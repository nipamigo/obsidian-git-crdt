// @ts-ignore - isomorphic-git 的 http 子模块类型声明不全
import git from "isomorphic-git";
// @ts-ignore
import http from "isomorphic-git/http/node";

/**
 * GitService — 封装 isomorphic-git,提供简单的 pull/commit/push/status 接口
 *
 * 设计要点:
 * - 不使用系统 git 命令,纯 JS 实现,跨平台
 * - pull 时不走 git merge,而是读取远端文件内容,交给上层 CRDT 合并
 * - 这是 "CRDT + Git" 架构的关键:Git 只做传输和版本历史,合并交给 CRDT
 */
export class GitService {
  private fs: any;
  private dir: string;
  private author: { name: string; email: string };
  private remote: string;
  private branch: string;
  private token: string;

  constructor(opts: {
    fs: any;
    dir: string;
    authorName: string;
    authorEmail: string;
    remote: string;
    branch: string;
    token?: string;
  }) {
    this.fs = opts.fs;
    this.dir = opts.dir;
    this.author = { name: opts.authorName, email: opts.authorEmail };
    this.remote = opts.remote;
    this.branch = opts.branch;
    this.token = opts.token || "";
  }

  setToken(token: string) {
    this.token = token;
  }

  /** 获取当前分支名 */
  getBranch(): string {
    return this.branch;
  }

  /** 检查当前目录是不是 Git 仓库 */
  async isRepo(): Promise<boolean> {
    try {
      await git.resolveRef({ fs: this.fs, dir: this.dir, ref: "HEAD" });
      return true;
    } catch {
      return false;
    }
  }

  /** 初始化 Git 仓库(如果还不是) */
  async initIfNeeded(): Promise<void> {
    if (await this.isRepo()) return;
    await git.init({ fs: this.fs, dir: this.dir, defaultBranch: this.branch });
  }

  /** 获取工作区变更状态(statusMatrix) */
  async statusMatrix(): Promise<any[]> {
    return git.statusMatrix({ fs: this.fs, dir: this.dir });
  }

  /** 暂存文件(stage) — 供 ShadowGitService.commitAll 使用 */
  async addFile(filepath: string): Promise<void> {
    await git.add({ fs: this.fs, dir: this.dir, filepath });
  }

  /** 从暂存区移除文件(git rm) — 供 ShadowGitService.commitAll 使用 */
  async removeFile(filepath: string): Promise<void> {
    await git.remove({ fs: this.fs, dir: this.dir, filepath });
  }

  /** 执行 commit(不包含 stage 逻辑,文件已提前 add) — 供 ShadowGitService 使用 */
  async commit(message: string): Promise<string> {
    return git.commit({
      fs: this.fs,
      dir: this.dir,
      author: this.author,
      message,
    });
  }

  /** 读取指定文件在 HEAD 中的内容(公开) */
  async readFileFromHead(filepath: string): Promise<string | null> {
    return this.readBlobAt("HEAD", filepath);
  }

  /** 读取指定文件在远端的内容(公开) */
  async readFileFromRemote(filepath: string): Promise<string | null> {
    const remoteRef = `refs/remotes/origin/${this.branch}`;
    return this.readBlobAt(remoteRef, filepath);
  }

  /** 获取 merge base(最近共同祖先) */
  async getMergeBase(): Promise<string | null> {
    try {
      const remoteRef = `refs/remotes/origin/${this.branch}`;
      // isomorphic-git 没有直接的 merge-base,用 findMergeBase?
      // 简化:如果本地和远端都有 HEAD,我们用 git 的方式找
      // MVP:直接用本地 HEAD 作为 baseline(假设本地已经是最新的)
      // 更准确的做法需要自己实现 merge-base,这里先简化
      const headOid = await git.resolveRef({ fs: this.fs, dir: this.dir, ref: "HEAD" });
      return headOid;
    } catch {
      return null;
    }
  }

  /** 读取指定文件在某个 ref 中的内容 */
  private async readBlobAt(ref: string, filepath: string): Promise<string | null> {
    try {
      const oid = await git.resolveRef({ fs: this.fs, dir: this.dir, ref });
      const result: any = await git.readBlob({
        fs: this.fs,
        dir: this.dir,
        oid,
        filepath,
      });
      return new TextDecoder().decode(result.blob);
    } catch {
      return null;
    }
  }

  /** 列出某个 ref 下的所有文件 */
  private async listFilesAt(ref: string): Promise<string[]> {
    try {
      const oid = await git.resolveRef({ fs: this.fs, dir: this.dir, ref });
      return git.listFiles({ fs: this.fs, dir: this.dir, ref: oid });
    } catch {
      return [];
    }
  }

  /**
   * 智能 pull — fetch 远端后逐文件对比,返回变更的 Markdown 文件列表
   * 不走 git merge,合并交给上层 CRDT
   */
  async smartPull(): Promise<{
    success: boolean;
    changedFiles: Array<{ path: string; remoteContent: string | null }>;
    error?: string;
  }> {
    try {
      // fetch 远端
      await git.fetch({
        fs: this.fs,
        http,
        dir: this.dir,
        remote: "origin",
        ref: this.branch,
        onAuth: () => this.getAuth(),
      });

      const remoteRef = `refs/remotes/origin/${this.branch}`;
      let hasRemote = true;
      try {
        await git.resolveRef({ fs: this.fs, dir: this.dir, ref: remoteRef });
      } catch {
        hasRemote = false;
      }

      if (!hasRemote) {
        // 远端还没东西
        return { success: true, changedFiles: [] };
      }

      // 检查本地有没有 HEAD
      let hasHead = true;
      try {
        await git.resolveRef({ fs: this.fs, dir: this.dir, ref: "HEAD" });
      } catch {
        hasHead = false;
      }

      const changedFiles: Array<{ path: string; remoteContent: string | null }> = [];

      if (!hasHead) {
        // 本地是空仓,远端所有文件都是新增的
        const files = await this.listFilesAt(remoteRef);
        for (const f of files) {
          if (!f.endsWith(".md")) continue; // MVP: 只处理 Markdown
          const content = await this.readBlobAt(remoteRef, f);
          changedFiles.push({ path: f, remoteContent: content });
        }
      } else {
        // 本地和远端都有 — 逐个文件对比
        const remoteFiles = await this.listFilesAt(remoteRef);
        const localFiles = await this.listFilesAt("HEAD");
        const localSet = new Set(localFiles);

        // 远端新增或修改的文件
        for (const f of remoteFiles) {
          if (!f.endsWith(".md")) continue;

          if (!localSet.has(f)) {
            // 远端新增
            const content = await this.readBlobAt(remoteRef, f);
            changedFiles.push({ path: f, remoteContent: content });
          } else {
            // 两边都有,比较内容
            const localContent = await this.readBlobAt("HEAD", f);
            const remoteContent = await this.readBlobAt(remoteRef, f);
            if (localContent !== remoteContent) {
              changedFiles.push({ path: f, remoteContent });
            }
          }
        }
        // 远端删除的文件 — MVP 不处理(保留本地)
      }

      return { success: true, changedFiles };
    } catch (e: any) {
      return {
        success: false,
        changedFiles: [],
        error: e?.message || String(e),
      };
    }
  }

  /** 提交所有变更 */
  async commitAll(message: string): Promise<string | null> {
    try {
      const matrix = await this.statusMatrix();
      for (const row of matrix) {
        const filepath = row[0];
        const head = row[1];
        const workdir = row[2];
        const stage = row[3];

        if (filepath.startsWith(".git")) continue;
        if (filepath.startsWith(".obsidian/plugins/git-crdt/sidecar")) continue;

        if (workdir === 0 && head > 0) {
          await git.remove({ fs: this.fs, dir: this.dir, filepath });
        } else if (workdir > 0 && workdir !== stage) {
          await git.add({ fs: this.fs, dir: this.dir, filepath });
        }
      }

      const oid = await git.commit({
        fs: this.fs,
        dir: this.dir,
        author: this.author,
        message,
      });
      return oid;
    } catch (e: any) {
      console.error("[git-crdt] commit failed:", e);
      return null;
    }
  }

  /** 推送到远端 */
  async push(): Promise<{ success: boolean; error?: string }> {
    try {
      await git.push({
        fs: this.fs,
        http,
        dir: this.dir,
        remote: "origin",
        ref: this.branch,
        onAuth: () => this.getAuth(),
      });
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  }

  /** 设置远端地址 */
  async setRemote(url: string): Promise<void> {
    try {
      await git.addRemote({
        fs: this.fs,
        dir: this.dir,
        remote: "origin",
        url,
        force: true,
      });
    } catch {
      // 可能已存在
    }
  }

  private getAuth(): { username: string; password: string } | undefined {
    const token = this.token || process.env.GIT_TOKEN || "";
    if (!token) return undefined;
    return { username: "git-crdt", password: token };
  }
}
