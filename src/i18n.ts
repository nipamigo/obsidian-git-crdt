/**
 * i18n — 国际化双语支持(中文 / English)
 *
 * 使用方式:
 *   import { t } from "./i18n";
 *   t("sync")  // → "同步" 或 "Sync"
 *
 * 语言切换:
 *   setLang("zh") / setLang("en")
 *   在设置面板中选择语言后,所有 t() 调用自动切换
 */

export type Lang = "zh" | "en";

/** 翻译键 → { 中文, 英文 } */
const STRINGS: Record<string, { zh: string; en: string }> = {
  // ===== 通用 =====
  "close": { zh: "关闭", en: "Close" },
  "error": { zh: "错误", en: "Error" },
  "ready": { zh: "就绪", en: "Ready" },
  "syncing": { zh: "同步中...", en: "Syncing..." },
  "pulling": { zh: "拉取中...", en: "Pulling..." },
  "committing": { zh: "提交中...", en: "Committing..." },
  "pushing": { zh: "推送中...", en: "Pushing..." },
  "pushed": { zh: "已推送", en: "Pushed" },
  "pushFailed": { zh: "推送失败", en: "Push failed" },
  "nothingToCommit": { zh: "没有需要提交的变更", en: "Nothing to commit" },
  "syncingToShadow": { zh: "同步到 shadow...", en: "Syncing to shadow..." },

  // ===== 设置面板标题 =====
  "settingsTitle": { zh: "Git CRDT 设置", en: "Git CRDT Settings" },
  "settingsDesc": { zh: "CRDT 编辑器 + Git 同步 — 无冲突的多人协作。", en: "CRDT editor + Git sync — conflict-free collaboration." },

  // ===== 设置项 =====
  "setting.remoteUrl": { zh: "Git 远程仓库地址", en: "Git Remote URL" },
  "setting.remoteUrl.desc": { zh: "远程仓库地址(GitHub / GitLab 等)", en: "Remote repository URL (GitHub / GitLab / etc.)" },
  "setting.branch": { zh: "分支", en: "Branch" },
  "setting.branch.desc": { zh: "要同步的分支", en: "Branch to sync" },
  "setting.authorName": { zh: "作者名", en: "Author Name" },
  "setting.authorName.desc": { zh: "Git 提交作者名", en: "Git commit author name" },
  "setting.authorEmail": { zh: "作者邮箱", en: "Author Email" },
  "setting.authorEmail.desc": { zh: "Git 提交作者邮箱", en: "Git commit author email" },
  "setting.gitToken": { zh: "Git Token", en: "Git Token" },
  "setting.gitToken.desc": { zh: "推送用的个人访问令牌。也可通过 GIT_TOKEN 环境变量设置。", en: "Personal access token for push. Can also set via GIT_TOKEN env var." },
  "setting.autoSync": { zh: "自动同步间隔(分钟)", en: "Auto Sync Interval (minutes)" },
  "setting.autoSync.desc": { zh: "0 表示禁用。建议:5 分钟或更长。", en: "0 to disable. Recommended: 5 minutes or more." },
  "setting.language": { zh: "界面语言", en: "Interface Language" },
  "setting.language.desc": { zh: "选择插件界面语言", en: "Choose plugin interface language" },

  // ===== v0.6 Shadow Repo 设置 =====
  "shadow.title": { zh: "v0.6 Shadow Repo 隔离", en: "v0.6 Shadow Repo Isolation" },
  "shadow.useShadow": { zh: "启用 Shadow Repo", en: "Use Shadow Repo" },
  "shadow.useShadow.desc": { zh: "在 shadow repo 中隔离 Git 操作,用户 staging area 不受影响。(推荐:开启)", en: "Isolate Git operations in a shadow repo. Keeps user's staging area untouched. (Recommended: ON)" },
  "shadow.location": { zh: "Shadow Repo 位置", en: "Shadow Repo Location" },
  "shadow.location.desc": { zh: "Shadow repo 位于:", en: "Shadow repo is at:" },
  "shadow.showInFiles": { zh: "在文件管理器中显示", en: "Show in Files" },

  // ===== 操作区 =====
  "actions.title": { zh: "操作", en: "Actions" },
  "actions.initShadow": { zh: "初始化 Shadow Repo", en: "Initialize Shadow Repo" },
  "actions.initShadow.desc": { zh: "初始化 shadow git 仓库以进行同步操作", en: "Init the shadow git repo for sync operations" },
  "actions.initBtn": { zh: "初始化", en: "Init" },
  "actions.syncToShadow": { zh: "同步 Vault → Shadow", en: "Sync Vault → Shadow" },
  "actions.syncToShadow.desc": { zh: "手动将 vault .md 文件复制到 shadow repo 工作区", en: "Manually copy vault .md files to shadow repo working dir" },
  "actions.syncBtn": { zh: "同步", en: "Sync" },
  "actions.mergeHistory": { zh: "合并历史", en: "Merge History" },
  "actions.mergeHistory.desc": { zh: "查看合并历史并回退", en: "View merge history and revert" },
  "actions.showHistoryBtn": { zh: "显示历史", en: "Show History" },
  "actions.maxRecords": { zh: "最大历史记录数", en: "Max History Records" },
  "actions.maxRecords.desc": { zh: "保留的最大合并历史记录数", en: "Maximum number of merge history records to keep" },
  "actions.syncNow": { zh: "立即同步", en: "Sync Now" },
  "actions.syncNow.desc": { zh: "拉取 → 合并 → 提交 → 推送(通过 shadow repo)", en: "Pull → merge → commit → push (via shadow repo)" },
  "actions.pullOnly": { zh: "仅拉取", en: "Pull Only" },
  "actions.pullOnly.desc": { zh: "只拉取并合并,不提交或推送", en: "Fetch and merge only, no commit or push" },
  "actions.pullBtn": { zh: "拉取", en: "Pull" },

  // ===== 关于 =====
  "about.title": { zh: "关于", en: "About" },
  "about.v06": { zh: "v0.6:Shadow repo 隔离 — Git 操作在 sidecar 中进行,不碰 vault。", en: "v0.6: Shadow repo isolation — Git operations happen in sidecar, not in vault." },
  "about.v05": { zh: "v0.5:合并历史 + 回退 UI — 每次合并都记录,一键回退。", en: "v0.5: Merge history + revert UI — every merge is recorded, one-click revert." },
  "about.v04": { zh: "v0.4:块级结构化合并 — 以 Markdown 块为 diff 单位。", en: "v0.4: Block-level structured merge — Markdown blocks as diff units." },
  "about.v03": { zh: "v0.3:CRDT 编辑器绑定 — 打字即生成 Yjs 操作。", en: "v0.3: CRDT editor binding — typing generates Yjs operations." },
  "about.mdOnly": { zh: "仅 Markdown (.md) 文件参与 CRDT 合并和编辑器绑定。", en: "Only Markdown (.md) files get CRDT merging and editor binding." },
  "about.clickStatus": { zh: "点击状态栏可快速同步。", en: "Click status bar for quick sync." },

  // ===== 命令 =====
  "cmd.sync": { zh: "同步(拉取 → 合并 → 提交 → 推送)", en: "Sync (pull → merge → commit → push)" },
  "cmd.pull": { zh: "仅拉取(fetch + 三路合并)", en: "Pull only (fetch + three-way merge)" },
  "cmd.push": { zh: "提交并推送", en: "Commit & push" },
  "cmd.init": { zh: "初始化 Git 仓库(shadow repo)", en: "Initialize Git repo (shadow repo)" },
  "cmd.syncToShadow": { zh: "同步 vault 文件到 shadow repo", en: "Sync vault files to shadow repo" },
  "cmd.historyAll": { zh: "显示合并历史(所有文件)", en: "Show merge history (all files)" },
  "cmd.historyCurrent": { zh: "显示合并历史(当前文件)", en: "Show merge history (current file)" },

  // ===== Notice 提示 =====
  "notice.syncInProgress": { zh: "Git CRDT: 同步正在进行中...", en: "Git CRDT: sync already in progress..." },
  "notice.noActiveFile": { zh: "Git CRDT: 没有活动文件", en: "Git CRDT: no active file" },
  "notice.pushedOk": { zh: "Git CRDT: 推送成功", en: "Git CRDT: pushed successfully" },
  "notice.pushFailed": { zh: "Git CRDT: 推送失败 — ", en: "Git CRDT: push failed — " },
  "notice.shadowInit": { zh: "Git CRDT: shadow repo 已初始化", en: "Git CRDT: shadow repo initialized" },
  "notice.initFailed": { zh: "Git CRDT: 初始化失败 — ", en: "Git CRDT: init failed — " },
  "notice.syncToShadow": { zh: "Git CRDT: {copied} 个文件已同步,{deleted} 个已删除(shadow repo)", en: "Git CRDT: {copied} files synced, {deleted} deleted (shadow repo)" },
  "notice.syncToShadowFailed": { zh: "Git CRDT: 同步到 shadow 失败 — ", en: "Git CRDT: sync to shadow failed — " },
  "notice.actionFailed": { zh: "Git CRDT: {action} 失败 — {error}", en: "Git CRDT: {action} failed — {error}" },

  // ===== SyncResult 消息 =====
  "result.actionDone": { zh: "{action} 完成:拉取 {pulled} 个,合并 {merged} 个,{committed}{pushed}{history}", en: "{action} done: pulled {pulled}, merged {merged}, {committed}{pushed}{history}" },
  "result.committed": { zh: "已提交, ", en: "committed, " },
  "result.notPushed": { zh: "未推送", en: "not pushed" },
  "result.historySuffix": { zh: ", {n} 条历史记录", en: ", {n} history records" },

  // ===== 历史 UI =====
  "history.title": { zh: "合并历史", en: "Merge History" },
  "history.file": { zh: "文件: {file}", en: "File: {file}" },
  "history.empty": { zh: "暂无合并历史记录。执行 Sync 后会自动记录。", en: "No merge history yet. Run Sync to start recording." },
  "history.viewDiff": { zh: "查看差异", en: "View Diff" },
  "history.clearAll": { zh: "清空历史", en: "Clear All" },
  "history.confirmClear": { zh: "确定要清空所有合并历史吗?此操作不可撤销。", en: "Are you sure you want to clear all merge history? This cannot be undone." },
  "history.cleared": { zh: "合并历史已清空", en: "Merge history cleared" },
  "history.notFound": { zh: "记录不存在或已删除", en: "Record not found or deleted" },
  "history.detail": { zh: "合并详情", en: "Merge Detail" },
  "history.time": { zh: "时间: {time}", en: "Time: {time}" },
  "history.source": { zh: "来源: {source}", en: "Source: {source}" },
  "history.warnings": { zh: "警告:", en: "Warnings:" },
  "history.diffPreview": { zh: "差异预览(合并前 → 合并后)", en: "Diff Preview (before → after)" },
  "history.revert": { zh: "回退到合并前", en: "Revert to before merge" },
  "history.confirmRevert": { zh: "确定回退 \"{file}\" 到合并前状态?\n\n合并前: {before} 字符\n当前: {after} 字符", en: "Revert \"{file}\" to pre-merge state?\n\nBefore: {before} chars\nCurrent: {after} chars" },
  "history.reverted": { zh: "已回退 {file} 到合并前状态", en: "Reverted {file} to pre-merge state" },
  "history.revertFailed": { zh: "回退失败: {error}", en: "Revert failed: {error}" },
  "history.moreLines": { zh: "还有 {n} 行", en: "{n} more lines" },
  "history.justNow": { zh: "刚刚", en: "just now" },
  "history.minutesAgo": { zh: "{n} 分钟前", en: "{n} min ago" },
  "history.hoursAgo": { zh: "{n} 小时前", en: "{n} hr ago" },
  "history.chars": { zh: "{before} → {after} 字符", en: "{before} → {after} chars" },
  "history.warningBadge": { zh: "⚠ {n} 警告", en: "⚠ {n} warnings" },

  // ===== 日志 =====
  "log.loaded": { zh: "插件已加载(v0.6 含 shadow repo 隔离 + 双语支持)", en: "Plugin loaded (v0.6 with shadow repo isolation + i18n)" },
  "log.unloaded": { zh: "插件已卸载", en: "Plugin unloaded" },
};

/** 当前语言 */
let currentLang: Lang = "zh";

/** 设置当前语言 */
export function setLang(lang: Lang): void {
  currentLang = lang;
}

/** 获取当前语言 */
export function getLang(): Lang {
  return currentLang;
}

/**
 * 翻译函数
 * @param key 翻译键
 * @param vars 模板变量,替换 {key} 占位符
 * @returns 当前语言的翻译文本
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const entry = STRINGS[key];
  if (!entry) {
    return key; // 找不到翻译,返回 key 本身
  }

  let text = entry[currentLang] ?? entry.en ?? key;

  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(`{${k}}`, String(v));
    }
  }

  return text;
}
