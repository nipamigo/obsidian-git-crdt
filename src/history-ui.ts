/**
 * HistoryModal — 合并历史 UI
 *
 * 两个模态框:
 * 1. HistoryListModal: 合并历史列表,点击某条 → 打开详情
 * 2. HistoryDetailModal: 显示 diff 预览 + 回退按钮
 *
 * 设计原则(参考 Obsidian 社区插件的 UI 惯例):
 * - 列表用 Obsidian 的 Modal API
 * - diff 预览用简单的 HTML 渲染(不依赖 CodeMirror diff)
 * - 回退操作有二次确认
 * - v0.6: 所有界面文本支持中英双语
 */

import { App, Modal, Setting, TFile, Notice, Vault } from "obsidian";
import { HistoryManager } from "./history";
import { t, getLang } from "./i18n";

/** 格式化时间 */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return t("history.justNow");
  if (diff < 3600_000) return t("history.minutesAgo", { n: Math.floor(diff / 60_000) });
  if (diff < 86400_000) return t("history.hoursAgo", { n: Math.floor(diff / 3600_000) });
  const locale = getLang() === "zh" ? "zh-CN" : "en-US";
  return d.toLocaleString(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 生成简单的行级 diff 预览(HTML) */
function generateDiffHTML(before: string, after: string): string {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");

  // 简单 LCS 行级 diff
  const m = beforeLines.length;
  const n = afterLines.length;
  const dp: number[][] = Array(m + 1)
    .fill(0)
    .map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (beforeLines[i - 1] === afterLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const changes: { type: "same" | "add" | "del"; text: string }[] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (beforeLines[i - 1] === afterLines[j - 1]) {
      changes.unshift({ type: "same", text: beforeLines[i - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      changes.unshift({ type: "del", text: beforeLines[i - 1] });
      i--;
    } else {
      changes.unshift({ type: "add", text: afterLines[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    changes.unshift({ type: "del", text: beforeLines[i - 1] });
    i--;
  }
  while (j > 0) {
    changes.unshift({ type: "add", text: afterLines[j - 1] });
    j--;
  }

  // 生成 HTML
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const lines = changes.slice(0, 200).map((c) => {
    const text = esc(c.text) || "&nbsp;";
    const cls = c.type === "add" ? "diff-add" : c.type === "del" ? "diff-del" : "diff-same";
    const prefix = c.type === "add" ? "+ " : c.type === "del" ? "- " : "&nbsp;&nbsp;";
    return `<div class="${cls}">${prefix}${text}</div>`;
  });

  if (changes.length > 200) {
    lines.push(`<div class="diff-more">${t("history.moreLines", { n: changes.length - 200 })}</div>`);
  }

  return lines.join("");
}

/** 合并历史列表 Modal */
export class HistoryListModal extends Modal {
  private history: HistoryManager;
  private vault: Vault;
  private filterFile: string | null;
  private onRevert: (file: string, content: string) => Promise<void>;

  constructor(
    app: App,
    history: HistoryManager,
    vault: Vault,
    onRevert: (file: string, content: string) => Promise<void>,
    filterFile: string | null = null
  ) {
    super(app);
    this.history = history;
    this.vault = vault;
    this.filterFile = filterFile;
    this.onRevert = onRevert;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    const entries = this.filterFile
      ? this.history.getHistoryForFile(this.filterFile)
      : this.history.getAllHistory();

    contentEl.createEl("h2", { text: t("history.title") });

    if (this.filterFile) {
      contentEl.createEl("p", {
        text: t("history.file", { file: this.filterFile }),
        cls: "setting-item-description",
      });
    }

    if (entries.length === 0) {
      contentEl.createEl("p", {
        text: t("history.empty"),
        cls: "setting-item-description",
      });
      contentEl.createEl("button", { text: t("close") }).onclick = () => this.close();
      return;
    }

    // 列表容器
    const listEl = contentEl.createDiv({ cls: "history-list" });

    for (const entry of entries) {
      const itemEl = listEl.createDiv({ cls: "history-item" });

      const leftEl = itemEl.createDiv({ cls: "history-item-info" });
      leftEl.createEl("span", {
        text: formatTime(entry.timestamp),
        cls: "history-time",
      });
      leftEl.createEl("span", {
        text: entry.file,
        cls: "history-file",
      });
      if (entry.warningCount > 0) {
        leftEl.createEl("span", {
          text: t("history.warningBadge", { n: entry.warningCount }),
          cls: "history-warning",
        });
      }
      leftEl.createEl("span", {
        text: t("history.chars", { before: entry.beforeLength, after: entry.afterLength }),
        cls: "history-size",
      });

      const rightEl = itemEl.createDiv({ cls: "history-item-actions" });
      const detailBtn = rightEl.createEl("button", { text: t("history.viewDiff"), cls: "mod-compact" });
      detailBtn.onclick = () => {
        this.close();
        new HistoryDetailModal(
          this.app,
          this.history,
          entry.id,
          entry.file,
          this.vault,
          this.onRevert
        ).open();
      };
    }

    // 底部操作
    const footerEl = contentEl.createDiv({ cls: "history-footer" });
    footerEl.createEl("button", { text: t("close") }).onclick = () => this.close();

    const clearBtn = footerEl.createEl("button", {
      text: t("history.clearAll"),
      cls: "mod-compact",
    });
    clearBtn.style.float = "right";
    clearBtn.onclick = () => {
      if (confirm(t("history.confirmClear"))) {
        this.history.clearAll();
        new Notice(t("history.cleared"));
        this.close();
      }
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** 合并详情 Modal — 显示 diff + 回退 */
class HistoryDetailModal extends Modal {
  private history: HistoryManager;
  private recordId: string;
  private filePath: string;
  private vault: Vault;
  private onRevert: (file: string, content: string) => Promise<void>;

  constructor(
    app: App,
    history: HistoryManager,
    recordId: string,
    filePath: string,
    vault: Vault,
    onRevert: (file: string, content: string) => Promise<void>
  ) {
    super(app);
    this.history = history;
    this.recordId = recordId;
    this.filePath = filePath;
    this.vault = vault;
    this.onRevert = onRevert;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    const record = this.history.getRecord(this.recordId);
    if (!record) {
      contentEl.createEl("p", { text: t("history.notFound") });
      contentEl.createEl("button", { text: t("close") }).onclick = () => this.close();
      return;
    }

    contentEl.createEl("h2", { text: t("history.detail") });

    // 元信息
    const metaEl = contentEl.createDiv({ cls: "history-detail-meta" });
    metaEl.createEl("p", {
      text: t("history.file", { file: record.file }),
      cls: "setting-item-description",
    });
    const locale = getLang() === "zh" ? "zh-CN" : "en-US";
    metaEl.createEl("p", {
      text: t("history.time", { time: new Date(record.timestamp).toLocaleString(locale) }),
      cls: "setting-item-description",
    });
    metaEl.createEl("p", {
      text: t("history.source", { source: record.source }),
      cls: "setting-item-description",
    });
    if (record.warnings.length > 0) {
      const warnEl = metaEl.createEl("div", { cls: "history-warnings" });
      warnEl.createEl("p", { text: t("history.warnings"), cls: "setting-item-description" });
      for (const w of record.warnings) {
        warnEl.createEl("p", { text: `  ⚠ ${w}`, cls: "history-warning-text" });
      }
    }

    // diff 预览
    contentEl.createEl("h3", { text: t("history.diffPreview") });

    const diffContainer = contentEl.createDiv({ cls: "history-diff-container" });
    const diffHTML = generateDiffHTML(record.before, record.after);
    diffContainer.innerHTML = diffHTML;

    // 注入 diff 样式
    const styleEl = contentEl.createEl("style");
    styleEl.textContent = `
      .history-list { max-height: 400px; overflow-y: auto; }
      .history-item {
        display: flex; justify-content: space-between; align-items: center;
        padding: 8px 0; border-bottom: 1px solid var(--background-modifier-border);
      }
      .history-item-info { display: flex; gap: 12px; align-items: center; flex: 1; }
      .history-time { color: var(--text-muted); font-size: 0.85em; min-width: 100px; }
      .history-file { font-weight: 500; }
      .history-warning { color: var(--text-warning); font-size: 0.85em; }
      .history-size { color: var(--text-muted); font-size: 0.85em; }
      .history-footer { margin-top: 16px; }
      .history-diff-container {
        max-height: 400px; overflow-y: auto;
        background: var(--background-secondary);
        border-radius: 4px; padding: 8px;
        font-family: var(--font-monospace); font-size: 0.85em;
        line-height: 1.5;
      }
      .diff-add { color: var(--text-success); background: rgba(0,200,0,0.1); }
      .diff-del { color: var(--text-error); background: rgba(255,0,0,0.1); }
      .diff-same { color: var(--text-muted); }
      .diff-more { color: var(--text-muted); padding: 4px 0; font-style: italic; }
      .history-detail-meta { margin-bottom: 12px; }
      .history-warnings { margin: 8px 0; }
      .history-warning-text { color: var(--text-warning); font-size: 0.85em; }
      .history-actions { display: flex; gap: 8px; margin-top: 16px; }
    `;

    // 操作按钮
    const actionsEl = contentEl.createDiv({ cls: "history-actions" });
    const revertBtn = actionsEl.createEl("button", {
      text: t("history.revert"),
      cls: "mod-warning",
    });
    revertBtn.onclick = async () => {
      const confirmMsg = t("history.confirmRevert", {
        file: record.file,
        before: record.before.length,
        after: record.after.length,
      });
      if (!confirm(confirmMsg)) {
        return;
      }
      try {
        await this.onRevert(record.file, record.before);
        new Notice(t("history.reverted", { file: record.file }));
        this.close();
      } catch (e: any) {
        new Notice(t("history.revertFailed", { error: e.message }));
        console.error("[git-crdt] revert failed:", e);
      }
    };

    const closeBtn = actionsEl.createEl("button", { text: t("close") });
    closeBtn.onclick = () => this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}
