import { App, Plugin, PluginSettingTab, Setting, Notice, TFile, Vault, Editor } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import { CrdtRegistry } from "./crdt";
import { GitService } from "./git";
import { ShadowGitService } from "./shadow-git";
import { SyncEngine, SyncResult } from "./sync";
import { yEditorBindingExtension, bindYTextToView } from "./editor-binding";
import { HistoryManager } from "./history";
import { HistoryListModal } from "./history-ui";
import { EditorView } from "@codemirror/view";

interface GitCrdtSettings {
  remoteUrl: string;
  branch: string;
  authorName: string;
  authorEmail: string;
  gitToken: string;
  autoSyncInterval: number;
  sidecarDir: string;
  historyMaxRecords: number;
  useShadowRepo: boolean;
}

const DEFAULT_SETTINGS: GitCrdtSettings = {
  remoteUrl: "",
  branch: "main",
  authorName: "git-crdt user",
  authorEmail: "git-crdt@example.com",
  gitToken: "",
  autoSyncInterval: 0,
  sidecarDir: ".obsidian/plugins/git-crdt/sidecar",
  historyMaxRecords: 50,
  useShadowRepo: true,
};

export default class GitCrdtPlugin extends Plugin {
  settings: GitCrdtSettings = DEFAULT_SETTINGS;
  crdtRegistry!: CrdtRegistry;
  shadowGit!: ShadowGitService;
  syncEngine!: SyncEngine;
  historyManager!: HistoryManager;

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

    // 确保 history 目录存在
    const historyPath = path.join(this.vaultRoot, this.settings.sidecarDir, "history");
    try {
      fs.mkdirSync(historyPath, { recursive: true });
    } catch (e) {
      console.error("[git-crdt] failed to create history dir:", e);
    }

    // 初始化各模块
    this.crdtRegistry = new CrdtRegistry(sidecarPath);

    this.historyManager = new HistoryManager(historyPath, this.settings.historyMaxRecords);

    // v0.6: 使用 ShadowGitService(隔离用户 staging area)
    this.shadowGit = new ShadowGitService({
      fs,
      vaultDir: this.vaultRoot,
      sidecarDir: sidecarPath,
      authorName: this.settings.authorName,
      authorEmail: this.settings.authorEmail,
      remote: this.settings.remoteUrl,
      branch: this.settings.branch,
      token: this.settings.gitToken,
    });

    this.syncEngine = new SyncEngine(this.app, this.crdtRegistry, this.shadowGit, this.historyManager);

    // 状态栏
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.setText("Git CRDT: ready");
    this.statusBarItem.style.cursor = "pointer";
    this.statusBarItem.title = "Click to sync";
    this.statusBarItem.onClickEvent(() => this.doSync());

    // ===== v0.3: 编辑器 CRDT 实时绑定 =====
    this.registerEditorExtension(yEditorBindingExtension);

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file && file.extension === "md") {
          this.bindEditorForFile(file);
        }
      })
    );

    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && activeFile.extension === "md") {
      this.app.workspace.onLayoutReady(() => {
        this.bindEditorForFile(activeFile);
      });
    }

    // ===== 命令 =====
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
      name: "Initialize Git repo (shadow repo)",
      callback: () => this.doInit(),
    });

    this.addCommand({
      id: "git-crdt-sync-to-shadow",
      name: "Sync vault files to shadow repo",
      callback: () => this.doSyncToShadow(),
    });

    // ===== v0.5: 合并历史命令 =====
    this.addCommand({
      id: "git-crdt-history",
      name: "Show merge history (all files)",
      callback: () => this.showHistory(null),
    });

    this.addCommand({
      id: "git-crdt-history-current",
      name: "Show merge history (current file)",
      editorCallback: (editor: Editor) => {
        const file = this.app.workspace.getActiveFile();
        if (file) {
          this.showHistory(file.path);
        } else {
          new Notice("Git CRDT: no active file");
        }
      },
    });

    // 设置面板
    this.addSettingTab(new GitCrdtSettingTab(this.app, this));

    // 如果配置了远端,自动设置
    if (this.settings.remoteUrl) {
      this.shadowGit.setRemote(this.settings.remoteUrl).catch(console.error);
    }

    // 自动同步
    this.setupAutoSync();

    console.log("[git-crdt] plugin loaded (v0.6 with shadow repo isolation)");
  }

  onunload() {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
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

  private async bindEditorForFile(file: TFile) {
    const relPath = file.path;
    const absPath = path.join(this.vaultRoot, relPath);

    try {
      const mgr = this.crdtRegistry.get(relPath);

      const loadedFromSidecar = await mgr.loadFromSidecar({
        readFile: async (p: string) => fs.readFileSync(p),
      });

      const fileContent = await this.app.vault.read(file);
      mgr.loadFromMarkdown(fileContent);

      if (loadedFromSidecar) {
        console.log(`[git-crdt] CRDT loaded from sidecar: ${relPath}`);
      } else {
        console.log(`[git-crdt] CRDT initialized from file: ${relPath}`);
      }

      this.bindToActiveEditor(relPath);
    } catch (e) {
      console.error(`[git-crdt] failed to bind editor for ${relPath}:`, e);
    }
  }

  private bindToActiveEditor(filePath: string): void {
    const activeEditor = this.app.workspace.activeEditor;
    if (!activeEditor || !activeEditor.editor) return;

    const view = this.getEditorView(activeEditor.editor);
    if (!view) return;

    const mgr = this.crdtRegistry.get(filePath);
    bindYTextToView(view, mgr.getYText());
    console.log(`[git-crdt] editor bound: ${filePath}`);
  }

  private getEditorView(editor: Editor): EditorView | null {
    // @ts-ignore — Obsidian Editor 的 cm 属性指向 CodeMirror 实例
    const cm = editor.cm;
    if (!cm) return null;
    if (typeof cm.dispatch === "function" && cm.state) {
      return cm as EditorView;
    }
    return null;
  }

  private async saveAllSidecars(): Promise<void> {
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

  // ===== 命令实现 =====

  async doSync() {
    if (this.syncEngine.isSyncing()) {
      new Notice("Git CRDT: sync already in progress...");
      return;
    }

    this.setStatus("syncing...");
    const result = await this.syncEngine.sync();
    this.handleResult(result, "Sync");
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
    this.refreshActiveEditor();
  }

  /** v0.6: 手动同步 vault → shadow */
  async doSyncToShadow() {
    this.setStatus("syncing to shadow...");
    try {
      const result = await this.shadowGit.syncVaultToShadow();
      this.setStatus("ready");
      new Notice(`Git CRDT: ${result.copied} files synced, ${result.deleted} deleted (shadow repo)`);
    } catch (e: any) {
      this.setStatus("error");
      new Notice(`Git CRDT: sync to shadow failed — ${e?.message || e}`);
    }
  }

  private refreshActiveEditor(): void {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && activeFile.extension === "md") {
      this.bindToActiveEditor(activeFile.path);
    }
  }

  async doPush() {
    this.setStatus("committing...");
    const result = await this.syncEngine.commitAndPush("git-crdt: manual commit");
    if (!result.committed) {
      this.setStatus("nothing to commit");
      new Notice("Git CRDT: nothing to commit");
      return;
    }

    this.setStatus("pushing...");
    if (result.pushed) {
      this.setStatus("pushed");
      new Notice("Git CRDT: pushed successfully");
    } else {
      this.setStatus("push failed");
      new Notice(`Git CRDT: push failed — ${result.error}`);
    }
  }

  async doInit() {
    try {
      await this.shadowGit.initIfNeeded();
      if (this.settings.remoteUrl) {
        await this.shadowGit.setRemote(this.settings.remoteUrl);
      }
      new Notice("Git CRDT: shadow repo initialized");
      this.setStatus("ready");
    } catch (e: any) {
      new Notice(`Git CRDT: init failed — ${e?.message || e}`);
    }
  }

  updateToken(token: string) {
    this.shadowGit.setToken(token);
  }

  // ===== v0.5: 合并历史 =====

  showHistory(filterFile: string | null) {
    new HistoryListModal(
      this.app,
      this.historyManager,
      this.app.vault,
      async (file: string, content: string) => {
        await this.revertFile(file, content);
      },
      filterFile
    ).open();
  }

  private async revertFile(filepath: string, beforeContent: string): Promise<void> {
    const file = this.app.vault.getFileByPath(filepath);
    if (!file || !(file instanceof TFile)) {
      throw new Error(`File not found: ${filepath}`);
    }

    await this.app.vault.modify(file, beforeContent);

    // v0.6: 同时更新 shadow repo
    this.shadowGit.writeMergedFile(filepath, beforeContent);

    const mgr = this.crdtRegistry.get(filepath);
    mgr.loadFromMarkdown(beforeContent);

    this.refreshActiveEditor();

    console.log(`[git-crdt] reverted ${filepath} to pre-merge state`);
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

  // ===== 私有辅助 =====

  private handleResult(result: SyncResult, action: string) {
    if (result.success) {
      const msg =
        `${action} done: pulled ${result.pulledFiles}, ` +
        `merged ${result.mergedFiles}, ` +
        `${result.committed ? "committed, " : ""}` +
        `${result.pushed ? "pushed" : "not pushed"}` +
        `${result.recordedHistory > 0 ? `, ${result.recordedHistory} history records` : ""}`;
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
              this.plugin.shadowGit.setRemote(value).catch(console.error);
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

    // v0.6: Shadow Repo 设置
    containerEl.createEl("h3", { text: "v0.6 Shadow Repo" });

    new Setting(containerEl)
      .setName("Use Shadow Repo")
      .setDesc("Isolate Git operations in a shadow repo. Keeps user's staging area untouched. (Recommended: ON)")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.useShadowRepo)
          .onChange(async (value) => {
            this.plugin.settings.useShadowRepo = value;
            await this.plugin.saveSettings();
          })
      );

    const shadowDir = this.plugin.shadowGit.getShadowDir();
    new Setting(containerEl)
      .setName("Shadow Repo Location")
      .setDesc(`Shadow repo is at: ${shadowDir}`)
      .addButton((btn) =>
        btn.setButtonText("Show in Files").onClick(() => {
          // 提示路径,用户可以手动导航
          new Notice(`Shadow repo: ${shadowDir}`);
        })
      );

    // 操作按钮
    containerEl.createEl("h3", { text: "Actions" });

    new Setting(containerEl)
      .setName("Initialize Shadow Repo")
      .setDesc("Init the shadow git repo for sync operations")
      .addButton((btn) =>
        btn.setButtonText("Init").onClick(() => {
          this.plugin.doInit();
        })
      );

    new Setting(containerEl)
      .setName("Sync Vault → Shadow")
      .setDesc("Manually copy vault .md files to shadow repo working dir")
      .addButton((btn) =>
        btn.setButtonText("Sync").onClick(() => {
          this.plugin.doSyncToShadow();
        })
      );

    new Setting(containerEl)
      .setName("Merge History")
      .setDesc(`View merge history and revert (${this.plugin.historyManager.count()} records)`)
      .addButton((btn) =>
        btn.setButtonText("Show History").onClick(() => {
          this.plugin.showHistory(null);
        })
      );

    new Setting(containerEl)
      .setName("Max History Records")
      .setDesc("Maximum number of merge history records to keep")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.historyMaxRecords))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            this.plugin.settings.historyMaxRecords = isNaN(n) ? 50 : Math.max(5, n);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync Now")
      .setDesc("Pull → merge → commit → push (via shadow repo)")
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

    // 版本信息
    containerEl.createEl("h3", { text: "About" });
    const info = containerEl.createEl("ul");
    info.createEl("li", {
      text: "v0.6: Shadow repo isolation — Git operations happen in sidecar, not in vault.",
    });
    info.createEl("li", {
      text: "v0.5: Merge history + revert UI — every merge is recorded, one-click revert.",
    });
    info.createEl("li", {
      text: "v0.4: Block-level structured merge — Markdown blocks as diff units.",
    });
    info.createEl("li", {
      text: "v0.3: CRDT editor binding — typing generates Yjs operations.",
    });
    info.createEl("li", {
      text: "Only Markdown (.md) files get CRDT merging and editor binding.",
    });
    info.createEl("li", {
      text: "Click status bar for quick sync.",
    });
  }
}
