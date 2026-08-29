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
import { setLang, getLang, t } from "./i18n";

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
  language: "zh" | "en";
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
  language: "zh",
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

    // 设置语言
    setLang(this.settings.language);

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
    this.statusBarItem.setText(`Git CRDT: ${t("ready")}`);
    this.statusBarItem.style.cursor = "pointer";
    this.statusBarItem.title = t("cmd.sync");
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
      name: t("cmd.sync"),
      callback: () => this.doSync(),
    });

    this.addCommand({
      id: "git-crdt-pull",
      name: t("cmd.pull"),
      callback: () => this.doPull(),
    });

    this.addCommand({
      id: "git-crdt-push",
      name: t("cmd.push"),
      callback: () => this.doPush(),
    });

    this.addCommand({
      id: "git-crdt-init",
      name: t("cmd.init"),
      callback: () => this.doInit(),
    });

    this.addCommand({
      id: "git-crdt-sync-to-shadow",
      name: t("cmd.syncToShadow"),
      callback: () => this.doSyncToShadow(),
    });

    // ===== v0.5: 合并历史命令 =====
    this.addCommand({
      id: "git-crdt-history",
      name: t("cmd.historyAll"),
      callback: () => this.showHistory(null),
    });

    this.addCommand({
      id: "git-crdt-history-current",
      name: t("cmd.historyCurrent"),
      editorCallback: (editor: Editor) => {
        const file = this.app.workspace.getActiveFile();
        if (file) {
          this.showHistory(file.path);
        } else {
          new Notice(t("notice.noActiveFile"));
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

    console.log(`[git-crdt] ${t("log.loaded")}`);
  }

  onunload() {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
    this.saveAllSidecars().catch(console.error);
    this.crdtRegistry.destroyAll();
    console.log(`[git-crdt] ${t("log.unloaded")}`);
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
      new Notice(t("notice.syncInProgress"));
      return;
    }

    this.setStatus(t("syncing"));
    const result = await this.syncEngine.sync();
    this.handleResult(result, "Sync");
    this.refreshActiveEditor();
  }

  async doPull() {
    if (this.syncEngine.isSyncing()) {
      new Notice(t("notice.syncInProgress"));
      return;
    }

    this.setStatus(t("pulling"));
    const result = await this.syncEngine.pullOnly();
    this.handleResult(result, "Pull");
    this.refreshActiveEditor();
  }

  /** v0.6: 手动同步 vault → shadow */
  async doSyncToShadow() {
    this.setStatus(t("syncingToShadow"));
    try {
      const result = await this.shadowGit.syncVaultToShadow();
      this.setStatus(t("ready"));
      new Notice(t("notice.syncToShadow", { copied: result.copied, deleted: result.deleted }));
    } catch (e: any) {
      this.setStatus(t("error"));
      new Notice(t("notice.syncToShadowFailed") + (e?.message || e));
    }
  }

  private refreshActiveEditor(): void {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && activeFile.extension === "md") {
      this.bindToActiveEditor(activeFile.path);
    }
  }

  async doPush() {
    this.setStatus(t("committing"));
    const result = await this.syncEngine.commitAndPush("git-crdt: manual commit");
    if (!result.committed) {
      this.setStatus(t("nothingToCommit"));
      new Notice(`Git CRDT: ${t("nothingToCommit")}`);
      return;
    }

    this.setStatus(t("pushing"));
    if (result.pushed) {
      this.setStatus(t("pushed"));
      new Notice(t("notice.pushedOk"));
    } else {
      this.setStatus(t("pushFailed"));
      new Notice(t("notice.pushFailed") + (result.error || ""));
    }
  }

  async doInit() {
    try {
      await this.shadowGit.initIfNeeded();
      if (this.settings.remoteUrl) {
        await this.shadowGit.setRemote(this.settings.remoteUrl);
      }
      new Notice(t("notice.shadowInit"));
      this.setStatus(t("ready"));
    } catch (e: any) {
      new Notice(t("notice.initFailed") + (e?.message || e));
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
      const committed = result.committed ? t("result.committed") : "";
      const pushed = result.committed
        ? (result.pushed ? t("pushed") : t("result.notPushed"))
        : t("result.notPushed");
      const history = result.recordedHistory > 0
        ? t("result.historySuffix", { n: result.recordedHistory })
        : "";

      const msg = t("result.actionDone", {
        action,
        pulled: result.pulledFiles,
        merged: result.mergedFiles,
        committed,
        pushed,
        history,
      });
      this.setStatus(msg);
      new Notice(`Git CRDT: ${msg}`);
    } else {
      this.setStatus(t("error"));
      new Notice(t("notice.actionFailed", { action, error: result.error || "" }));
      console.error("[git-crdt] sync error:", result.error);
    }
  }

  private setStatus(text: string) {
    this.statusBarItem.setText(`Git CRDT: ${text}`);
  }

  /** 公开方法:刷新状态栏文本(供 SettingTab 语言切换后调用) */
  refreshStatusBar(): void {
    this.statusBarItem.setText(`Git CRDT: ${t("ready")}`);
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

    containerEl.createEl("h2", { text: t("settingsTitle") });
    containerEl.createEl("p", {
      text: t("settingsDesc"),
    });

    // ===== 语言设置(放在最前面) =====
    new Setting(containerEl)
      .setName(t("setting.language"))
      .setDesc(t("setting.language.desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("zh", "中文")
          .addOption("en", "English")
          .setValue(this.plugin.settings.language)
          .onChange(async (value) => {
            const lang = value as "zh" | "en";
            this.plugin.settings.language = lang;
            setLang(lang);
            await this.plugin.saveSettings();
            // 刷新设置面板
            this.display();
            // 刷新状态栏
            this.plugin.refreshStatusBar();
          })
      );

    new Setting(containerEl)
      .setName(t("setting.remoteUrl"))
      .setDesc(t("setting.remoteUrl.desc"))
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
      .setName(t("setting.branch"))
      .setDesc(t("setting.branch.desc"))
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
      .setName(t("setting.authorName"))
      .setDesc(t("setting.authorName.desc"))
      .addText((text) =>
        text
          .setValue(this.plugin.settings.authorName)
          .onChange(async (value) => {
            this.plugin.settings.authorName = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("setting.authorEmail"))
      .setDesc(t("setting.authorEmail.desc"))
      .addText((text) =>
        text
          .setValue(this.plugin.settings.authorEmail)
          .onChange(async (value) => {
            this.plugin.settings.authorEmail = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("setting.gitToken"))
      .setDesc(t("setting.gitToken.desc"))
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
      .setName(t("setting.autoSync"))
      .setDesc(t("setting.autoSync.desc"))
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
    containerEl.createEl("h3", { text: t("shadow.title") });

    new Setting(containerEl)
      .setName(t("shadow.useShadow"))
      .setDesc(t("shadow.useShadow.desc"))
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
      .setName(t("shadow.location"))
      .setDesc(`${t("shadow.location.desc")} ${shadowDir}`)
      .addButton((btn) =>
        btn.setButtonText(t("shadow.showInFiles")).onClick(() => {
          new Notice(`Shadow repo: ${shadowDir}`);
        })
      );

    // 操作按钮
    containerEl.createEl("h3", { text: t("actions.title") });

    new Setting(containerEl)
      .setName(t("actions.initShadow"))
      .setDesc(t("actions.initShadow.desc"))
      .addButton((btn) =>
        btn.setButtonText(t("actions.initBtn")).onClick(() => {
          this.plugin.doInit();
        })
      );

    new Setting(containerEl)
      .setName(t("actions.syncToShadow"))
      .setDesc(t("actions.syncToShadow.desc"))
      .addButton((btn) =>
        btn.setButtonText(t("actions.syncBtn")).onClick(() => {
          this.plugin.doSyncToShadow();
        })
      );

    const historyCount = this.plugin.historyManager.count();
    new Setting(containerEl)
      .setName(t("actions.mergeHistory"))
      .setDesc(`${t("actions.mergeHistory.desc")} (${historyCount})`)
      .addButton((btn) =>
        btn.setButtonText(t("actions.showHistoryBtn")).onClick(() => {
          this.plugin.showHistory(null);
        })
      );

    new Setting(containerEl)
      .setName(t("actions.maxRecords"))
      .setDesc(t("actions.maxRecords.desc"))
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
      .setName(t("actions.syncNow"))
      .setDesc(t("actions.syncNow.desc"))
      .addButton((btn) =>
        btn
          .setButtonText(t("actions.syncBtn"))
          .setCta()
          .onClick(() => {
            this.plugin.doSync();
          })
      );

    new Setting(containerEl)
      .setName(t("actions.pullOnly"))
      .setDesc(t("actions.pullOnly.desc"))
      .addButton((btn) =>
        btn.setButtonText(t("actions.pullBtn")).onClick(() => {
          this.plugin.doPull();
        })
      );

    // 版本信息
    containerEl.createEl("h3", { text: t("about.title") });
    const info = containerEl.createEl("ul");
    info.createEl("li", { text: t("about.v06") });
    info.createEl("li", { text: t("about.v05") });
    info.createEl("li", { text: t("about.v04") });
    info.createEl("li", { text: t("about.v03") });
    info.createEl("li", { text: t("about.mdOnly") });
    info.createEl("li", { text: t("about.clickStatus") });
  }
}
