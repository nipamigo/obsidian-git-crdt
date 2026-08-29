import { App, Plugin, PluginSettingTab, Setting, Notice, TFile, Vault, Editor } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import { CrdtRegistry } from "./crdt";
import { GitService } from "./git";
import { SyncEngine, SyncResult } from "./sync";
import { yEditorBindingExtension, bindYTextToView } from "./editor-binding";
import { EditorView } from "@codemirror/view";

interface GitCrdtSettings {
  remoteUrl: string;
  branch: string;
  authorName: string;
  authorEmail: string;
  gitToken: string;
  autoSyncInterval: number;
  sidecarDir: string;
}

const DEFAULT_SETTINGS: GitCrdtSettings = {
  remoteUrl: "",
  branch: "main",
  authorName: "git-crdt user",
  authorEmail: "git-crdt@example.com",
  gitToken: "",
  autoSyncInterval: 0,
  sidecarDir: ".obsidian/plugins/git-crdt/sidecar",
};

export default class GitCrdtPlugin extends Plugin {
  settings: GitCrdtSettings = DEFAULT_SETTINGS;
  crdtRegistry!: CrdtRegistry;
  gitService!: GitService;
  syncEngine!: SyncEngine;

  private statusBarItem!: HTMLElement;
  private autoSyncTimer: any = null;
  private vaultRoot!: string;

  async onload() {
    await this.loadSettings();

    // 获取 vault 根目录
    // @ts-ignore — Obsidian FileSystemAdapter 有 basePath
    this.vaultRoot = this.app.vault.adapter.basePath || process.cwd();

    // 确保 sidecar 目录存在
    const sidecarPath = path.join(this.vaultRoot, this.settings.sidecarDir);
    try {
      fs.mkdirSync(sidecarPath, { recursive: true });
    } catch (e) {
      console.error("[git-crdt] failed to create sidecar dir:", e);
    }

    // 初始化各模块
    this.crdtRegistry = new CrdtRegistry(sidecarPath);

    this.gitService = new GitService({
      fs,
      dir: this.vaultRoot,
      authorName: this.settings.authorName,
      authorEmail: this.settings.authorEmail,
      remote: this.settings.remoteUrl,
      branch: this.settings.branch,
      token: this.settings.gitToken,
    });

    this.syncEngine = new SyncEngine(this.app, this.crdtRegistry, this.gitService);

    // 状态栏
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.setText("Git CRDT: ready");
    this.statusBarItem.style.cursor = "pointer";
    this.statusBarItem.title = "Click to sync";
    this.statusBarItem.onClickEvent(() => this.doSync());

    // ===== v0.3: 编辑器 CRDT 实时绑定 =====
    // 1. 注册 CodeMirror 扩展(所有编辑器视图都会加载)
    this.registerEditorExtension(yEditorBindingExtension);

    // 2. 监听文件打开:加载 CRDT 状态并绑定到编辑器
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file && file.extension === "md") {
          this.bindEditorForFile(file);
        }
      })
    );

    // 3. 如果已经有打开的文件,立即绑定
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && activeFile.extension === "md") {
      // 延迟一下,等编辑器初始化完成
      this.app.workspace.onLayoutReady(() => {
        this.bindEditorForFile(activeFile);
      });
    }

    // 命令
    this.addCommand({
      id: "git-crdt-sync",
      name: "Sync (pull → merge → commit → push)",
      callback: () => this.doSync(),
    });

    this.addCommand({
      id: "git-crdt-pull",
      name: "Pull only (fetch + three-way merge)",
      callback: () => this.doPull(),
    });

    this.addCommand({
      id: "git-crdt-push",
      name: "Commit & push",
      callback: () => this.doPush(),
    });

    this.addCommand({
      id: "git-crdt-init",
      name: "Initialize Git repo",
      callback: () => this.doInit(),
    });

    // 设置面板
    this.addSettingTab(new GitCrdtSettingTab(this.app, this));

    // 如果配置了远端,自动设置
    if (this.settings.remoteUrl) {
      this.gitService.setRemote(this.settings.remoteUrl).catch(console.error);
    }

    // 自动同步
    this.setupAutoSync();

    console.log("[git-crdt] plugin loaded (v0.3 with editor binding)");
  }

  onunload() {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
    // 保存所有打开文件的 sidecar
    this.saveAllSidecars().catch(console.error);
    this.crdtRegistry.destroyAll();
    console.log("[git-crdt] plugin unloaded");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ===== 编辑器绑定 =====

  /**
   * 为指定文件绑定 CRDT 编辑器
   * 1. 获取或创建 CrdtManager
   * 2. 尝试从 sidecar 加载(保留操作历史)
   * 3. 加载当前文件内容(用 applyFastDiff 增量更新)
   * 4. 绑定到当前活动编辑器视图
   */
  private async bindEditorForFile(file: TFile) {
    const relPath = file.path;
    const absPath = path.join(this.vaultRoot, relPath);

    try {
      // 获取 CrdtManager
      const mgr = this.crdtRegistry.get(relPath);

      // 先尝试从 sidecar 加载(保留 CRDT 历史)
      const loadedFromSidecar = await mgr.loadFromSidecar({
        readFile: async (p: string) => fs.readFileSync(p),
      });

      // 再用当前文件内容同步(可能有外部改动)
      const fileContent = await this.app.vault.read(file);
      mgr.loadFromMarkdown(fileContent);

      if (loadedFromSidecar) {
        console.log(`[git-crdt] CRDT loaded from sidecar: ${relPath}`);
      } else {
        console.log(`[git-crdt] CRDT initialized from file: ${relPath}`);
      }

      // 绑定到活动编辑器视图
      this.bindToActiveEditor(relPath);
    } catch (e) {
      console.error(`[git-crdt] failed to bind editor for ${relPath}:`, e);
    }
  }

  /** 找到活动编辑器的 CodeMirror view 并绑定 Y.Text */
  private bindToActiveEditor(filePath: string): void {
    const activeEditor = this.app.workspace.activeEditor;
    if (!activeEditor || !activeEditor.editor) return;

    const view = this.getEditorView(activeEditor.editor);
    if (!view) return;

    const mgr = this.crdtRegistry.get(filePath);
    bindYTextToView(view, mgr.getYText());
    console.log(`[git-crdt] editor bound: ${filePath}`);
  }

  /**
   * 从 Obsidian Editor 获取底层 CodeMirror EditorView
   * Obsidian 的 Editor 有一个未公开的 cm 属性
   */
  private getEditorView(editor: Editor): EditorView | null {
    // @ts-ignore — Obsidian Editor 的 cm 属性指向 CodeMirror 实例
    const cm = editor.cm;
    if (!cm) return null;
    // 可能是 EditorView 实例(CM6)
    if (typeof cm.dispatch === "function" && cm.state) {
      return cm as EditorView;
    }
    return null;
  }

  /** 保存所有已打开文件的 sidecar */
  private async saveAllSidecars(): Promise<void> {
    // 遍历所有注册的 CrdtManager
    // 注意:CrdtRegistry 没有遍历方法,我们通过活动文件来保存
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && activeFile.extension === "md") {
      const mgr = this.crdtRegistry.get(activeFile.path);
      try {
        await mgr.saveSidecar({
          writeFile: async (p: string, d: Uint8Array) => fs.writeFileSync(p, d),
        });
        console.log(`[git-crdt] sidecar saved: ${activeFile.path}`);
      } catch (e) {
        console.error(`[git-crdt] failed to save sidecar for ${activeFile.path}:`, e);
      }
    }
  }

  // --- 公开方法,设置面板调用 ---

  async doSync() {
    if (this.syncEngine.isSyncing()) {
      new Notice("Git CRDT: sync already in progress...");
      return;
    }

    this.setStatus("syncing...");
    const result = await this.syncEngine.sync();
    this.handleResult(result, "Sync");

    // 同步后刷新编辑器绑定(如果活动文件被修改了)
    this.refreshActiveEditor();
  }

  async doPull() {
    if (this.syncEngine.isSyncing()) {
      new Notice("Git CRDT: sync already in progress...");
      return;
    }

    this.setStatus("pulling...");
    const result = await this.syncEngine.pullOnly();
    this.handleResult(result, "Pull");

    // 同步后刷新编辑器绑定
    this.refreshActiveEditor();
  }

  /** 同步后刷新活动编辑器的 CRDT 绑定 */
  private refreshActiveEditor(): void {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && activeFile.extension === "md") {
      // 重新绑定:Y.Text 已经被 sync engine 更新了
      // 编辑器绑定会自动检测到 Y.Text 变化并更新编辑器
      this.bindToActiveEditor(activeFile.path);
    }
  }

  async doPush() {
    this.setStatus("committing...");
    const oid = await this.gitService.commitAll("git-crdt: manual commit");
    if (!oid) {
      this.setStatus("nothing to commit");
      new Notice("Git CRDT: nothing to commit");
      return;
    }

    this.setStatus("pushing...");
    const pushResult = await this.gitService.push();
    if (pushResult.success) {
      this.setStatus("pushed");
      new Notice("Git CRDT: pushed successfully");
    } else {
      this.setStatus("push failed");
      new Notice(`Git CRDT: push failed — ${pushResult.error}`);
    }
  }

  async doInit() {
    try {
      await this.gitService.initIfNeeded();
      if (this.settings.remoteUrl) {
        await this.gitService.setRemote(this.settings.remoteUrl);
      }
      new Notice("Git CRDT: repository initialized");
      this.setStatus("ready");
    } catch (e: any) {
      new Notice(`Git CRDT: init failed — ${e?.message || e}`);
    }
  }

  updateToken(token: string) {
    this.gitService.setToken(token);
  }

  setupAutoSync() {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }

    const interval = this.settings.autoSyncInterval;
    if (interval > 0 && this.settings.remoteUrl) {
      this.autoSyncTimer = setInterval(() => {
        if (!this.syncEngine.isSyncing()) {
          this.doSync();
        }
      }, interval * 60 * 1000);
    }
  }

  // --- 私有辅助 ---

  private handleResult(result: SyncResult, action: string) {
    if (result.success) {
      const msg =
        `${action} done: pulled ${result.pulledFiles}, ` +
        `merged ${result.mergedFiles}, ` +
        `${result.committed ? "committed, " : ""}` +
        `${result.pushed ? "pushed" : "not pushed"}`;
      this.setStatus(msg);
      new Notice(`Git CRDT: ${msg}`);
    } else {
      this.setStatus("error");
      new Notice(`Git CRDT: ${action} failed — ${result.error}`);
      console.error("[git-crdt] sync error:", result.error);
    }
  }

  private setStatus(text: string) {
    this.statusBarItem.setText(`Git CRDT: ${text}`);
  }
}

class GitCrdtSettingTab extends PluginSettingTab {
  plugin: GitCrdtPlugin;

  constructor(app: App, plugin: GitCrdtPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Git CRDT Settings" });
    containerEl.createEl("p", {
      text: "CRDT editor + Git sync — conflict-free collaboration.",
    });

    new Setting(containerEl)
      .setName("Git Remote URL")
      .setDesc("Remote repository URL (GitHub / GitLab / etc.)")
      .addText((text) =>
        text
          .setPlaceholder("https://github.com/user/repo.git")
          .setValue(this.plugin.settings.remoteUrl)
          .onChange(async (value) => {
            this.plugin.settings.remoteUrl = value;
            await this.plugin.saveSettings();
            if (value) {
              this.plugin.gitService.setRemote(value).catch(console.error);
            }
          })
      );

    new Setting(containerEl)
      .setName("Branch")
      .setDesc("Branch to sync")
      .addText((text) =>
        text
          .setPlaceholder("main")
          .setValue(this.plugin.settings.branch)
          .onChange(async (value) => {
            this.plugin.settings.branch = value || "main";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Author Name")
      .setDesc("Git commit author name")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.authorName)
          .onChange(async (value) => {
            this.plugin.settings.authorName = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Author Email")
      .setDesc("Git commit author email")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.authorEmail)
          .onChange(async (value) => {
            this.plugin.settings.authorEmail = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Git Token")
      .setDesc("Personal access token for push. Can also set via GIT_TOKEN env var.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.gitToken)
          .onChange(async (value) => {
            this.plugin.settings.gitToken = value;
            this.plugin.updateToken(value);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto Sync Interval (minutes)")
      .setDesc("0 to disable. Recommended: 5 minutes or more.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.autoSyncInterval))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            this.plugin.settings.autoSyncInterval = isNaN(n) ? 0 : Math.max(0, n);
            await this.plugin.saveSettings();
            this.plugin.setupAutoSync();
          })
      );

    // 操作按钮
    containerEl.createEl("h3", { text: "Actions" });

    new Setting(containerEl)
      .setName("Initialize Git Repository")
      .setDesc("Init a git repo in current vault if not already")
      .addButton((btn) =>
        btn.setButtonText("Init").onClick(() => {
          this.plugin.doInit();
        })
      );

    new Setting(containerEl)
      .setName("Sync Now")
      .setDesc("Pull → merge → commit → push")
      .addButton((btn) =>
        btn
          .setButtonText("Sync")
          .setCta()
          .onClick(() => {
            this.plugin.doSync();
          })
      );

    new Setting(containerEl)
      .setName("Pull Only")
      .setDesc("Fetch and merge only, no commit or push")
      .addButton((btn) =>
        btn.setButtonText("Pull").onClick(() => {
          this.plugin.doPull();
        })
      );

    // v0.3 新特性提示
    containerEl.createEl("h3", { text: "v0.3 Features" });
    const v3Info = containerEl.createEl("ul");
    v3Info.createEl("li", {
      text: "CRDT 编辑器实时绑定:打字即生成 Yjs 操作历史",
    });
    v3Info.createEl("li", {
      text: "Sidecar 持久化:关闭后重开保留 CRDT 身份",
    });
    v3Info.createEl("li", {
      text: "同步后自动刷新编辑器:无需手动重载",
    });

    // 提示
    containerEl.createEl("h3", { text: "Notes" });
    const ul = containerEl.createEl("ul");
    ul.createEl("li", {
      text: "Only Markdown (.md) files get CRDT merging and editor binding.",
    });
    ul.createEl("li", {
      text: "Binary files go through normal Git (may conflict).",
    });
    ul.createEl("li", {
      text: "Set Remote URL first, then click Init.",
    });
    ul.createEl("li", {
      text: "Click status bar for quick sync.",
    });
  }
}
