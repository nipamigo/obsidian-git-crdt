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
 */

import { App, Modal, Setting, TFile, Notice, Vault } from "obsidian";
import { HistoryManager } from "./history";

/** 格式化时间 */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return d.toLocaleString("zh-CN", {
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
    lines.push(`<div class="diff-more">... 还有 ${changes.length - 200} 行</div>`);
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

    contentEl.createEl("h2", { text: "合并历史" });

    if (this.filterFile) {
      contentEl.createEl("p", {
        text: `文件: ${this.filterFile}`,
        cls: "setting-item-description",
      });
    }

    if (entries.length === 0) {
      contentEl.createEl("p", {
        text: "暂无合并历史记录。执行 Sync 后会自动记录。",
        cls: "setting-item-description",
      });
      contentEl.createEl("button", { text: "关闭" }).onclick = () => this.close();
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
          text: `⚠ ${entry.warningCount} 警告`,
          cls: "history-warning",
        });
      }
      leftEl.createEl("span", {
        text: `${entry.beforeLength} → ${entry.afterLength} 字符`,
        cls: "history-size",
      });

      const rightEl = itemEl.createDiv({ cls: "history-item-actions" });
      const detailBtn = rightEl.createEl("button", { text: "查看差异", cls: "mod-compact" });
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
    footerEl.createEl("button", { text: "关闭" }).onclick = () => this.close();

    const clearBtn = footerEl.createEl("button", {
      text: "清空历史",
      cls: "mod-compact",
    });
    clearBtn.style.float = "right";
    clearBtn.onclick = () => {
      if (confirm("确定要清空所有合并历史吗?此操作不可撤销。")) {
        this.history.clearAll();
        new Notice("合并历史已清空");
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
      contentEl.createEl("p", { text: "记录不存在或已删除" });
      contentEl.createEl("button", { text: "关闭" }).onclick = () => this.close();
      return;
    }

    contentEl.createEl("h2", { text: "合并详情" });

    // 元信息
    const metaEl = contentEl.createDiv({ cls: "history-detail-meta" });
    metaEl.createEl("p", {
      text: `文件: ${record.file}`,
      cls: "setting-item-description",
    });
    metaEl.createEl("p", {
      text: `时间: ${new Date(record.timestamp).toLocaleString("zh-CN")}`,
      cls: "setting-item-description",
    });
    metaEl.createEl("p", {
      text: `来源: ${record.source}`,
      cls: "setting-item-description",
    });
    if (record.warnings.length > 0) {
      const warnEl = metaEl.createEl("div", { cls: "history-warnings" });
      warnEl.createEl("p", { text: "警告:", cls: "setting-item-description" });
      for (const w of record.warnings) {
        warnEl.createEl("p", { text: `  ⚠ ${w}`, cls: "history-warning-text" });
      }
    }

    // diff 预览
    contentEl.createEl("h3", { text: "差异预览(合并前 → 合并后)" });

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
      text: "回退到合并前",
      cls: "mod-warning",
    });
    revertBtn.onclick = async () => {
      if (!confirm(`确定回退 "${record.file}" 到合并前状态?\n\n合并前: ${record.before.length} 字符\n当前: ${record.after.length} 字符`)) {
        return;
      }
      try {
        await this.onRevert(record.file, record.before);
        new Notice(`已回退 ${record.file} 到合并前状态`);
        this.close();
      } catch (e: any) {
        new Notice(`回退失败: ${e.message}`);
        console.error("[git-crdt] revert failed:", e);
      }
    };

    const closeBtn = actionsEl.createEl("button", { text: "关闭" });
    closeBtn.onclick = () => this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}
