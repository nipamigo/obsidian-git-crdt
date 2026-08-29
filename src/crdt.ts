import * as Y from "yjs";
import { applyFastDiff } from "./apply-diff";
import { ORIGIN_EXTERNAL } from "./editor-binding";

/**
 * CrdtManager — 管理单个文件的 CRDT 状态
 *
 * 设计(参考 OpenKnowledge):
 * - 每个 Markdown 文件对应一个 Y.Doc,共享类型为 Y.Text('source')
 * - Y.Text 是真相来源(Y.Text-is-truth)
 * - 通过 applyFastDiff 做行级增量更新,保留未变行的 Yjs Item 身份
 * - Sidecar 文件保存 Yjs 更新向量,保留 CRDT 身份
 *
 * MVP 阶段:只有 Y.Text 单轨(纯文本级合并)
 * v0.3 计划:增加 Y.XmlFragment 双轨(结构化块级合并)
 */
export class CrdtManager {
  private doc: Y.Doc;
  private ytext: Y.Text;
  private filePath: string;
  private sidecarDir: string;
  private applyingRemote = false;
  private _lastSyncedText = "";

  constructor(filePath: string, sidecarDir: string) {
    this.filePath = filePath;
    this.sidecarDir = sidecarDir;
    this.doc = new Y.Doc();
    this.ytext = this.doc.getText("source");
  }

  /**
   * 从 Markdown 文本初始化/更新 CRDT 文档
   * 使用 applyFastDiff 做行级增量更新,保留未变行的 Item 身份
   */
  loadFromMarkdown(content: string): void {
    this.applyingRemote = true;
    try {
      const current = this.ytext.toString();
      applyFastDiff(this.ytext, current, content);
      this._lastSyncedText = this.ytext.toString();
    } finally {
      this.applyingRemote = false;
    }
  }

  /** 从 sidecar 恢复 CRDT 状态(保留操作历史) */
  async loadFromSidecar(fs: { readFile: (p: string) => Promise<Uint8Array> }): Promise<boolean> {
    try {
      const data = await fs.readFile(this.sidecarPath());
      Y.applyUpdate(this.doc, data);
      this._lastSyncedText = this.ytext.toString();
      return true;
    } catch {
      return false;
    }
  }

  /** 保存 CRDT 状态到 sidecar */
  async saveSidecar(fs: { writeFile: (p: string, d: Uint8Array) => Promise<void> }): Promise<void> {
    const update = Y.encodeStateAsUpdate(this.doc);
    await fs.writeFile(this.sidecarPath(), update);
  }

  /**
   * 应用远程 Markdown 内容并合并
   *
   * 注意:Git pull 场景下,两边没有共享的 CRDT 操作历史,
   * 真正的 CRDT 合并效果有限。推荐使用 merge.ts 中的三路文本合并。
   * 这个方法保留作为 CRDT 层的兜底能力。
   */
  applyRemoteMarkdown(remoteContent: string): string {
    // 策略:用远端内容创建一个临时 Y.Doc,然后交换 state vector 做合并
    const remoteDoc = new Y.Doc();
    const remoteText = remoteDoc.getText("source");
    if (remoteContent.length > 0) {
      remoteText.insert(0, remoteContent);
    }

    const localState = Y.encodeStateVector(this.doc);
    const remoteState = Y.encodeStateVector(remoteDoc);

    const remoteUpdate = Y.encodeStateAsUpdate(remoteDoc, localState);

    this.applyingRemote = true;
    try {
      Y.applyUpdate(this.doc, remoteUpdate);
    } finally {
      this.applyingRemote = false;
    }

    remoteDoc.destroy();
    this._lastSyncedText = this.ytext.toString();
    return this._lastSyncedText;
  }

  /** 直接应用 Yjs update 字节 */
  applyRemoteUpdate(update: Uint8Array): void {
    this.applyingRemote = true;
    try {
      Y.applyUpdate(this.doc, update);
    } finally {
      this.applyingRemote = false;
    }
    this._lastSyncedText = this.ytext.toString();
  }

  /** 获取当前 Markdown 文本 */
  getMarkdown(): string {
    return this.ytext.toString();
  }

  /** 获取 Y.Text 实例 */
  getYText(): Y.Text {
    return this.ytext;
  }

  /** 获取 Y.Doc 实例 */
  getDoc(): Y.Doc {
    return this.doc;
  }

  /** 是否正在应用远程更新(用于事件去重) */
  isApplyingRemote(): boolean {
    return this.applyingRemote;
  }

  /** 销毁释放资源 */
  destroy(): void {
    this.doc.destroy();
  }

  private sidecarPath(): string {
    const safeName = this.filePath.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+/, "");
    return `${this.sidecarDir}/${safeName}.yjs`;
  }
}

/**
 * CrdtRegistry — 管理所有打开文件的 CrdtManager 实例
 */
export class CrdtRegistry {
  private managers = new Map<string, CrdtManager>();
  private sidecarDir: string;

  constructor(sidecarDir: string) {
    this.sidecarDir = sidecarDir;
  }

  get(filePath: string): CrdtManager {
    let mgr = this.managers.get(filePath);
    if (!mgr) {
      mgr = new CrdtManager(filePath, this.sidecarDir);
      this.managers.set(filePath, mgr);
    }
    return mgr;
  }

  has(filePath: string): boolean {
    return this.managers.has(filePath);
  }

  release(filePath: string): void {
    const mgr = this.managers.get(filePath);
    if (mgr) {
      mgr.destroy();
      this.managers.delete(filePath);
    }
  }

  destroyAll(): void {
    for (const mgr of this.managers.values()) {
      mgr.destroy();
    }
    this.managers.clear();
  }
}
