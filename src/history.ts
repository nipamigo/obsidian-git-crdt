/**
 * HistoryManager — 合并历史存储 + 回退引擎
 *
 * 设计:
 * - 每次 Sync 合并文件后,自动记录:时间戳、文件路径、合并前内容、合并后内容、来源
 * - 历史记录存在 sidecar 目录下的 history/ 子目录
 * - 每条记录一个 JSON 文件,文件名 = 时间戳_文件名.json
 * - 自动清理:超过 maxRecords 条时,删除最旧的
 * - 回退:把 before 内容写回文件 + 重新加载 CRDT
 *
 * 数据结构:
 * {
 *   id: string;           // 唯一 ID(时间戳)
 *   timestamp: number;   // 合并时间
 *   file: string;         // 文件路径(相对 vault)
 *   before: string;       // 合并前本地内容
 *   after: string;        // 合并后内容
 *   remoteContent: string;// 远端原始内容
 *   source: string;       // 来源描述(如 "git pull from origin/main")
 *   warnings: string[];   // 合并时的警告
 * }
 */

import * as fs from "fs";
import * as path from "path";

export interface MergeRecord {
  id: string;
  timestamp: number;
  file: string;
  before: string;
  after: string;
  remoteContent: string;
  source: string;
  warnings: string[];
}

export class HistoryManager {
  private historyDir: string;
  private maxRecords: number;
  private index: MergeRecordIndex = [];

  constructor(historyDir: string, maxRecords = 50) {
    this.historyDir = historyDir;
    this.maxRecords = maxRecords;
    this.ensureDir();
    this.loadIndex();
  }

  private ensureDir(): void {
    try {
      fs.mkdirSync(this.historyDir, { recursive: true });
    } catch (e) {
      console.error("[git-crdt] failed to create history dir:", e);
    }
  }

  /** 加载索引(轻量元数据,不含 before/after 全文) */
  private loadIndex(): void {
    try {
      const indexFile = path.join(this.historyDir, "_index.json");
      if (fs.existsSync(indexFile)) {
        const data = fs.readFileSync(indexFile, "utf-8");
        this.index = JSON.parse(data);
      }
    } catch (e) {
      console.error("[git-crdt] failed to load history index:", e);
      this.index = [];
    }
  }

  /** 保存索引 */
  private saveIndex(): void {
    try {
      const indexFile = path.join(this.historyDir, "_index.json");
      fs.writeFileSync(indexFile, JSON.stringify(this.index, null, 2), "utf-8");
    } catch (e) {
      console.error("[git-crdt] failed to save history index:", e);
    }
  }

  /** 记录一次合并 */
  async record(record: Omit<MergeRecord, "id" | "timestamp">): Promise<string> {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const full: MergeRecord = {
      id,
      timestamp: Date.now(),
      ...record,
    };

    // 保存完整记录到单独文件
    const filePath = path.join(this.historyDir, `${id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(full, null, 2), "utf-8");

    // 更新索引(只存元数据,不含全文,避免索引文件太大)
    this.index.push({
      id: full.id,
      timestamp: full.timestamp,
      file: full.file,
      source: full.source,
      warningCount: full.warnings.length,
      beforeLength: full.before.length,
      afterLength: full.after.length,
    });

    // 清理超出的记录
    this.cleanup();

    this.saveIndex();

    console.log(`[git-crdt] merge recorded: ${full.file} (${id})`);
    return id;
  }

  /** 获取完整记录(含 before/after 全文) */
  getRecord(id: string): MergeRecord | null {
    try {
      const filePath = path.join(this.historyDir, `${id}.json`);
      if (!fs.existsSync(filePath)) return null;
      const data = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(data) as MergeRecord;
    } catch (e) {
      console.error("[git-crdt] failed to load record:", e);
      return null;
    }
  }

  /** 获取某个文件的合并历史(按时间倒序) */
  getHistoryForFile(filePath: string): MergeRecordIndexEntry[] {
    return this.index
      .filter((r) => r.file === filePath)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /** 获取所有合并历史(按时间倒序) */
  getAllHistory(): MergeRecordIndexEntry[] {
    return [...this.index].sort((a, b) => b.timestamp - a.timestamp);
  }

  /** 回退到合并前状态 — 返回 before 内容 */
  getBeforeContent(id: string): string | null {
    const record = this.getRecord(id);
    return record ? record.before : null;
  }

  /** 获取合并后内容(用于 diff 预览) */
  getAfterContent(id: string): string | null {
    const record = this.getRecord(id);
    return record ? record.after : null;
  }

  /** 删除单条记录 */
  deleteRecord(id: string): void {
    const filePath = path.join(this.historyDir, `${id}.json`);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {
      console.error("[git-crdt] failed to delete record:", e);
    }
    this.index = this.index.filter((r) => r.id !== id);
    this.saveIndex();
  }

  /** 清理超出 maxRecords 的旧记录 */
  private cleanup(): void {
    if (this.index.length <= this.maxRecords) return;

    // 按时间排序,保留最新的
    this.index.sort((a, b) => b.timestamp - a.timestamp);
    const toDelete = this.index.slice(this.maxRecords);

    for (const entry of toDelete) {
      const filePath = path.join(this.historyDir, `${entry.id}.json`);
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (e) {
        // 忽略删除失败
      }
    }

    this.index = this.index.slice(0, this.maxRecords);
  }

  /** 清空所有历史 */
  clearAll(): void {
    for (const entry of this.index) {
      const filePath = path.join(this.historyDir, `${entry.id}.json`);
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (e) {
        // 忽略
      }
    }
    this.index = [];
    this.saveIndex();
  }

  /** 获取记录数 */
  count(): number {
    return this.index.length;
  }
}

/** 索引条目(轻量,不含全文) */
interface MergeRecordIndexEntry {
  id: string;
  timestamp: number;
  file: string;
  source: string;
  warningCount: number;
  beforeLength: number;
  afterLength: number;
}

type MergeRecordIndex = MergeRecordIndexEntry[];
