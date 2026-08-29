import { CrdtRegistry } from "./crdt";
import { GitService } from "./git";
import { ShadowGitService } from "./shadow-git";
import { mergeThreeWay, assertContentPreservation } from "./merge";
import { mergeBlocksThreeWayV2 } from "./block-merge";
import { HistoryManager } from "./history";
import { App, TFile, Notice } from "obsidian";

export interface SyncResult {
  success: boolean;
  pulledFiles: number;
  mergedFiles: number;
  committed: boolean;
  pushed: boolean;
  warnings: string[];
  recordedHistory: number;
  error?: string;
}

/**
 * SyncEngine — 协调 CRDT + Git 的同步引擎
 *
 * v0.6 变更:使用 ShadowGitService 替代直接操作 GitService
 *
 * 核心工作流(参考 OpenKnowledge):
 * 1. syncVaultToShadow(): vault 的 .md 文件 → 复制到 shadow 工作区
 * 2. Fetch 远端(shadow repo)→ 找出有变更的 Markdown 文件
 * 3. 对每个变更文件:读取基线(shadow HEAD) + 本地(vault) + 远端(shadow remote ref) → 三路文本合并 → 写回 vault + shadow
 * 4. 提交合并结果(shadow repo)
 * 5. 推送到远端(shadow repo)
 *
 * 为什么 Git pull 不用 CRDT 合并(和 OK 一致):
 * Git pull 是"两个完整版本的合并",两边没有共享的 CRDT 操作历史,
 * Yjs 拿不到对方的 state vector,做不了真正的 CRDT 合并。
 * 三路文本合并(diff3 + diff-match-patch)在这种场景下更可靠。
 *
 * CRDT 的用武之地:
 * - 编辑器实时协作(未来版本)
 * - 保留本地编辑的操作历史(sidecar)
 * - 应用文件系统外部变更时的增量更新(applyFastDiff)
 */
export class SyncEngine {
  private app: App;
  private crdtRegistry: CrdtRegistry;
  private shadowGit: ShadowGitService;
  private history?: HistoryManager;
  private syncing = false;

  constructor(app: App, crdtRegistry: CrdtRegistry, shadowGit: ShadowGitService, history?: HistoryManager) {
    this.app = app;
    this.crdtRegistry = crdtRegistry;
    this.shadowGit = shadowGit;
    this.history = history;
  }

  /** 执行一次完整的同步(pull → merge → commit → push) */
  async sync(): Promise<SyncResult> {
    if (this.syncing) {
      return {
        success: false,
        pulledFiles: 0,
        mergedFiles: 0,
        committed: false,
        pushed: false,
        warnings: [],
        recordedHistory: 0,
        error: "Sync already in progress",
      };
    }

    this.syncing = true;
    const result: SyncResult = {
      success: false,
      pulledFiles: 0,
      mergedFiles: 0,
      committed: false,
      pushed: false,
      warnings: [],
      recordedHistory: 0,
    };

    try {
      // 记录同步前的历史数量,用于统计本次新增
      if (this.history) (this as any)._preSyncHistoryCount = this.history.count();

      // 第 1 步:smartPull — 内部先 syncVaultToShadow,再 fetch + 对比变更文件
      const pullResult = await this.shadowGit.smartPull();
      if (!pullResult.success) {
        result.error = pullResult.error;
        return result;
      }

      result.pulledFiles = pullResult.changedFiles.length;

      // 第 2 步:逐个文件做三路合并
      for (const change of pullResult.changedFiles) {
        try {
          await this.mergeFile(change.path, change.remoteContent, result.warnings);
          result.mergedFiles++;
        } catch (e: any) {
          console.error(`[git-crdt] merge failed for ${change.path}:`, e);
          result.warnings.push(`Failed to merge ${change.path}: ${e?.message || e}`);
        }
      }

      // 第 3 步:提交合并结果(在 shadow repo 中)
      if (result.mergedFiles > 0) {
        const oid = await this.shadowGit.commitAll(
          `git-crdt: merge ${result.mergedFiles} file(s) via three-way merge`
        );
        result.committed = !!oid;
      } else {
        // 没有要合并的文件,但本地可能有未提交变更,也一并提交
        const status = await this.shadowGit.statusMatrix();
        const hasChanges = status.some(
          (r: any) => r[2] !== r[3] || r[2] !== r[1]
        );
        if (hasChanges) {
          const oid = await this.shadowGit.commitAll(`git-crdt: sync snapshot`);
          result.committed = !!oid;
        }
      }

      // 第 4 步:push(从 shadow repo)
      if (result.committed) {
        const pushResult = await this.shadowGit.push();
        result.pushed = pushResult.success;
        if (!pushResult.success) {
          result.error = pushResult.error;
        }
      }

      result.success = !result.error;

      // 统计本次同步记录了多少条合并历史
      if (this.history) {
        result.recordedHistory = this.history.count() - (this as any)._preSyncHistoryCount || 0;
        delete (this as any)._preSyncHistoryCount;
      }

      return result;
    } catch (e: any) {
      result.error = e?.message || String(e);
      return result;
    } finally {
      this.syncing = false;
    }
  }

  /** 合并单个文件 — 三路文本合并 */
  private async mergeFile(
    filepath: string,
    remoteContent: string | null,
    warnings: string[]
  ): Promise<void> {
    const vault = this.app.vault;
    const abstractFile = vault.getFileByPath(filepath);

    // 远端新增文件 — 直接写入 vault + shadow
    if (!abstractFile && remoteContent !== null) {
      await vault.create(filepath, remoteContent);
      this.shadowGit.writeMergedFile(filepath, remoteContent);
      // 同时加载到 CRDT
      const crdt = this.crdtRegistry.get(filepath);
      crdt.loadFromMarkdown(remoteContent);
      return;
    }

    // 远端删除文件 — MVP 保守处理:保留本地
    if (remoteContent === null) {
      console.log(`[git-crdt] remote deleted ${filepath}, keeping local copy`);
      return;
    }

    if (!(abstractFile instanceof TFile)) return;
    const file = abstractFile;

    // 读取本地当前内容(vault 工作区)
    const localContent = await vault.read(file);

    // 读取基线(baseline):shadow repo 的 HEAD 版本
    const baselineContent = await this.shadowGit.readFileFromHead(filepath);

    let merged: string;

    if (baselineContent === null) {
      // shadow repo 还没有 HEAD(首次同步)→ 远端版本为准
      merged = remoteContent;
    } else {
      // v0.4:先用块级合并(段落/标题/列表为单位),块内冲突再降级到文本级合并
      merged = mergeBlocksThreeWayV2(baselineContent, localContent, remoteContent);

      // 内容保全检测(只警告不中断)
      try {
        assertContentPreservation(baselineContent, localContent, remoteContent, merged);
      } catch (e: any) {
        warnings.push(`${filepath}: ${e.message}`);
        console.warn(`[git-crdt] content preservation warning for ${filepath}:`, e.message);
      }
    }

    // 获取或创建 CRDT manager,用 applyFastDiff 增量更新
    const crdt = this.crdtRegistry.get(filepath);
    if (crdt.getYText().length === 0 && localContent.length > 0) {
      crdt.loadFromMarkdown(localContent);
    }

    // 通过 CRDT 层应用合并结果(行级增量,保留未变行的 Item 身份)
    crdt.loadFromMarkdown(merged);

    // 写回 vault 文件
    const finalContent = crdt.getMarkdown();
    if (finalContent !== localContent) {
      await vault.modify(file, finalContent);

      // v0.6: 同时写入 shadow repo 工作区
      this.shadowGit.writeMergedFile(filepath, finalContent);

      // v0.5: 记录合并历史(只有内容实际变化时才记录)
      if (this.history) {
        try {
          await this.history.record({
            file: filepath,
            before: localContent,
            after: finalContent,
            remoteContent,
            source: `git pull from origin/${this.shadowGit.getBranch()}`,
            warnings: warnings.filter((w) => w.includes(filepath)),
          });
          // 计数器(SyncResult 上)
          (this as any)._lastRecordedCount = ((this as any)._lastRecordedCount || 0) + 1;
        } catch (e: any) {
          console.warn(`[git-crdt] failed to record history for ${filepath}:`, e);
        }
      }
    } else {
      // 内容没变化,也要同步到 shadow(确保 shadow 和 vault 一致)
      this.shadowGit.writeMergedFile(filepath, finalContent);
    }
  }

  /** 只 pull,不 push */
  async pullOnly(): Promise<SyncResult> {
    if (this.syncing) {
      return {
        success: false,
        pulledFiles: 0,
        mergedFiles: 0,
        committed: false,
        pushed: false,
        warnings: [],
        recordedHistory: 0,
        error: "Sync already in progress",
      };
    }

    this.syncing = true;
    const preCount = this.history?.count() || 0;
    try {
      const pullResult = await this.shadowGit.smartPull();
      if (!pullResult.success) {
        return {
          success: false,
          pulledFiles: 0,
          mergedFiles: 0,
          committed: false,
          pushed: false,
          warnings: [],
          recordedHistory: 0,
          error: pullResult.error,
        };
      }

      const warnings: string[] = [];
      let merged = 0;
      for (const change of pullResult.changedFiles) {
        try {
          await this.mergeFile(change.path, change.remoteContent, warnings);
          merged++;
        } catch (e) {
          console.error(`[git-crdt] merge failed for ${change.path}:`, e);
          warnings.push(`Failed to merge ${change.path}`);
        }
      }

      const postCount = this.history?.count() || 0;
      return {
        success: true,
        pulledFiles: pullResult.changedFiles.length,
        mergedFiles: merged,
        committed: false,
        pushed: false,
        warnings,
        recordedHistory: postCount - preCount,
      };
    } finally {
      this.syncing = false;
    }
  }

  /** 手动提交并推送(从 shadow repo) */
  async commitAndPush(message: string): Promise<{ committed: boolean; pushed: boolean; error?: string }> {
    const oid = await this.shadowGit.commitAll(message);
    if (!oid) {
      return { committed: false, pushed: false };
    }

    const pushResult = await this.shadowGit.push();
    return {
      committed: true,
      pushed: pushResult.success,
      error: pushResult.error,
    };
  }

  isSyncing(): boolean {
    return this.syncing;
  }
}
