/**
 * ShadowGitService — Shadow repo 隔离层
 *
 * 核心问题:
 *   v0.5 之前 GitService 直接在 vault 根目录操作 .git,
 *   如果用户自己也在用 Git 管理 vault,插件的 add/commit 会污染用户的 staging area。
 *
 * Shadow repo 方案:
 *   在 sidecar 目录下创建一个独立的 git 仓库(shadow repo),
 *   所有 fetch / commit / push 操作都在 shadow repo 中进行,
 *   vault 的 .git 完全不被触碰。
 *
 * 工作流:
 *   1. syncVaultToShadow(): vault 的 .md 文件 → 复制到 shadow 工作区
 *   2. fetch + smartPull: 在 shadow repo 中拉取远端、对比变更
 *   3. 三路合并(基线来自 shadow HEAD,本地来自 vault,远端来自 shadow remote ref)
 *   4. 合并结果写回 vault + shadow 工作区
 *   5. commitAll + push: 在 shadow repo 中提交并推送
 *
 * 文件映射:
 *   vault:  /path/to/vault/notes/foo.md
 *   shadow: /path/to/sidecar/shadow-git/notes/foo.md  (镜像副本)
 */

import * as fs from "fs";
import * as path from "path";
import { GitService } from "./git";

export class ShadowGitService {
  /** Shadow repo 的根目录 */
  private shadowDir: string;
  /** Vault 根目录 */
  private vaultDir: string;
  /** 内部 GitService 实例,操作 shadow repo */
  private git: GitService;
  /** sidecar 目录(用于读取 .gitignore 模板等) */
  private sidecarDir: string;

  constructor(opts: {
    fs: any;
    vaultDir: string;
    sidecarDir: string;
    authorName: string;
    authorEmail: string;
    remote: string;
    branch: string;
    token?: string;
  }) {
    this.vaultDir = opts.vaultDir;
    this.sidecarDir = opts.sidecarDir;
    this.shadowDir = path.join(opts.sidecarDir, "shadow-git");

    // 确保 shadow 目录存在
    try {
      fs.mkdirSync(this.shadowDir, { recursive: true });
    } catch (e) {
      console.error("[git-crdt] failed to create shadow dir:", e);
    }

    // 创建内部 GitService,dir 指向 shadow repo
    this.git = new GitService({
      fs: opts.fs,
      dir: this.shadowDir,
      authorName: opts.authorName,
      authorEmail: opts.authorEmail,
      remote: opts.remote,
      branch: opts.branch,
      token: opts.token,
    });
  }

  /** 获取 shadow repo 目录路径 */
  getShadowDir(): string {
    return this.shadowDir;
  }

  /** 获取内部 GitService(供 SyncEngine 读取 HEAD 等) */
  getGitService(): GitService {
    return this.git;
  }

  /** 获取当前分支名 */
  getBranch(): string {
    return this.git.getBranch();
  }

  /** 设置 token */
  setToken(token: string): void {
    this.git.setToken(token);
  }

  /** 设置远端 */
  async setRemote(url: string): Promise<void> {
    await this.git.setRemote(url);
  }

  /** 初始化 shadow repo(如果还不是 git 仓库) */
  async initIfNeeded(): Promise<void> {
    await this.git.initIfNeeded();
    // 不用 .gitignore 的 * 模式(isomorphic-git 兼容性不好)
    // commitAll() 中已过滤非 .md 文件
  }

  /** 检查 shadow repo 是否已初始化 */
  async isRepo(): Promise<boolean> {
    return this.git.isRepo();
  }

  /**
   * 将 vault 的 .md 文件同步到 shadow 工作区
   * - 只复制 .md 文件
   * - 删除 shadow 中 vault 已不存在的 .md 文件
   * - 保持目录结构一致
   */
  async syncVaultToShadow(): Promise<{ copied: number; deleted: number }> {
    let copied = 0;
    let deleted = 0;

    // 收集 vault 中所有 .md 文件
    const vaultMdFiles = this.collectMdFiles(this.vaultDir);

    // 收集 shadow 中现有的 .md 文件(排除 .git)
    const shadowMdFiles = this.collectMdFiles(this.shadowDir);
    const vaultSet = new Set(vaultMdFiles.map((f) => f.relative));

    // 删除 shadow 中 vault 已不存在的 .md 文件
    for (const shadowFile of shadowMdFiles) {
      if (!vaultSet.has(shadowFile.relative)) {
        const absPath = path.join(this.shadowDir, shadowFile.relative);
        try {
          fs.unlinkSync(absPath);
          deleted++;
        } catch (e) {
          // 忽略删除失败
        }
      }
    }

    // 复制 vault 的 .md 文件到 shadow(只复制有变化的)
    for (const vaultFile of vaultMdFiles) {
      const srcPath = path.join(this.vaultDir, vaultFile.relative);
      const dstPath = path.join(this.shadowDir, vaultFile.relative);

      // 确保目标目录存在
      const dstDir = path.dirname(dstPath);
      try {
        fs.mkdirSync(dstDir, { recursive: true });
      } catch (e) {
        // 目录可能已存在
      }

      // 比较文件内容,只在变化时复制
      let needCopy = true;
      try {
        if (fs.existsSync(dstPath)) {
          const srcContent = fs.readFileSync(srcPath, "utf-8");
          const dstContent = fs.readFileSync(dstPath, "utf-8");
          if (srcContent === dstContent) {
            needCopy = false;
          }
        }
      } catch (e) {
        // 读取失败,强制复制
      }

      if (needCopy) {
        try {
          fs.copyFileSync(srcPath, dstPath);
          copied++;
        } catch (e) {
          console.warn(`[git-crdt] failed to copy ${vaultFile.relative} to shadow:`, e);
        }
      }
    }

    if (copied > 0 || deleted > 0) {
      console.log(`[git-crdt] vault → shadow: ${copied} copied, ${deleted} deleted`);
    }

    return { copied, deleted };
  }

  /**
   * 将单个文件写入 shadow 工作区(合并后用)
   */
  writeMergedFile(relativePath: string, content: string): void {
    const dstPath = path.join(this.shadowDir, relativePath);
    const dstDir = path.dirname(dstPath);

    try {
      fs.mkdirSync(dstDir, { recursive: true });
      fs.writeFileSync(dstPath, content, "utf-8");
    } catch (e) {
      console.error(`[git-crdt] failed to write merged file to shadow: ${relativePath}`, e);
    }
  }

  /**
   * 删除 shadow 工作区中的文件(远端删除时用)
   */
  deleteShadowFile(relativePath: string): void {
    const absPath = path.join(this.shadowDir, relativePath);
    try {
      if (fs.existsSync(absPath)) {
        fs.unlinkSync(absPath);
      }
    } catch (e) {
      // 忽略
    }
  }

  /** smartPull — 委托给内部 GitService,在 shadow repo 中执行 */
  async smartPull(): Promise<{
    success: boolean;
    changedFiles: Array<{ path: string; remoteContent: string | null }>;
    error?: string;
  }> {
    // 先把 vault 当前状态同步到 shadow
    await this.syncVaultToShadow();
    // 在 shadow repo 中执行 smartPull
    return this.git.smartPull();
  }

  /** 读取文件在 shadow HEAD 中的内容 */
  async readFileFromHead(filepath: string): Promise<string | null> {
    return this.git.readFileFromHead(filepath);
  }

  /** 读取文件在 shadow remote ref 中的内容 */
  async readFileFromRemote(filepath: string): Promise<string | null> {
    return this.git.readFileFromRemote(filepath);
  }

  /** 获取 merge base */
  async getMergeBase(): Promise<string | null> {
    return this.git.getMergeBase();
  }

  /** 获取工作区变更状态(在 shadow repo 中) */
  async statusMatrix(): Promise<any[]> {
    return this.git.statusMatrix();
  }

  /** 在 shadow repo 中提交所有变更 */
  async commitAll(message: string): Promise<string | null> {
    // 先确保 shadow 工作区和 vault 一致
    await this.syncVaultToShadow();

    // shadow repo: 只提交 .md 文件,总是 stage(比 statusMatrix 更可靠)
    const gitSvc = this.git;
    const matrix = await gitSvc.statusMatrix();
    let hasChanges = false;

    // 用 isomorphic-git 直接操作(通过 GitService 暴露的方法)
    for (const row of matrix) {
      const filepath: string = row[0];
      const head: number = row[1];
      const workdir: number = row[2];

      if (filepath.startsWith(".git")) continue;
      if (!filepath.endsWith(".md")) continue;

      if (workdir === 0 && head > 0) {
        // 文件被删除
        await gitSvc.removeFile(filepath);
        hasChanges = true;
      } else if (workdir > 0) {
        // 总是 stage .md 文件
        await gitSvc.addFile(filepath);
        hasChanges = true;
      }
    }

    if (!hasChanges) return null;
    return gitSvc.commit(message);
  }

  /** 从 shadow repo 推送到远端 */
  async push(): Promise<{ success: boolean; error?: string }> {
    return this.git.push();
  }

  /**
   * 递归收集目录下所有 .md 文件
   * 返回 [{ absolute, relative }] 列表
   */
  private collectMdFiles(rootDir: string): Array<{ absolute: string; relative: string }> {
    const result: Array<{ absolute: string; relative: string }> = [];

    const walk = (dir: string, prefix: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        return;
      }

      for (const entry of entries) {
        // 跳过 .git 目录
        if (entry.name === ".git") continue;
        // 跳过 .obsidian 目录(在 vault 中)
        if (entry.name === ".obsidian" && dir === this.vaultDir) continue;

        const fullPath = path.join(dir, entry.name);
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          walk(fullPath, relativePath);
        } else if (entry.name.endsWith(".md")) {
          result.push({ absolute: fullPath, relative: relativePath });
        }
      }
    };

    walk(rootDir, "");
    return result;
  }

  /**
   * 清理 shadow repo(危险操作,仅在卸载或重置时调用)
   */
  async destroy(): Promise<void> {
    try {
      fs.rmSync(this.shadowDir, { recursive: true, force: true });
      console.log("[git-crdt] shadow repo destroyed");
    } catch (e) {
      console.error("[git-crdt] failed to destroy shadow repo:", e);
    }
  }
}
