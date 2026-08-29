/**
 * Markdown ↔ Yjs 增量更新工具 — 参考 OpenKnowledge 的 apply-diff.ts
 *
 * 核心思想:不要全量删除再插入(会丢失所有 CRDT 操作历史),
 * 而是通过行级 diff 找出变更,只对变更行做 Y.Text 操作。
 *
 * 这样保留了未变行的 Yjs Item 身份,合并质量更高。
 */

import * as Y from "yjs";
import { diff_match_patch } from "diff-match-patch";

const dmp = new diff_match_patch();

// 阈值:超过这个大小的文档不走行级 diff,用前后缀+中间替换的策略
const APPLY_FAST_DIFF_MAX_BYTES = 256 * 1024; // 256KB

/**
 * 将 currentText 到 newText 的行级 diff 应用到 ytext
 *
 * 优势:
 * - 未变更的行保留原始 Yjs Item(有 Lamport timestamp,合并时更准)
 * - 性能更好(不用删了再插)
 */
export function applyFastDiff(ytext: Y.Text, currentText: string, newText: string): void {
  if (currentText === newText) return;

  if (
    currentText.length > APPLY_FAST_DIFF_MAX_BYTES ||
    newText.length > APPLY_FAST_DIFF_MAX_BYTES
  ) {
    // 大文件:用前缀+后缀匹配,只替换中间部分
    applyByPrefixSuffixMiddleReplace(ytext, currentText, newText);
    return;
  }

  // 行级 diff
  const changes = diffLinesFast(currentText, newText);

  let offset = 0;
  for (const change of changes) {
    if (change.removed) {
      ytext.delete(offset, change.value.length);
    } else if (change.added) {
      ytext.insert(offset, change.value);
      offset += change.value.length;
    } else {
      offset += change.value.length;
    }
  }
}

/**
 * 大文件优化:找公共前缀和后缀,只替换中间部分
 */
function applyByPrefixSuffixMiddleReplace(
  ytext: Y.Text,
  currentText: string,
  newText: string
): void {
  let prefixLen = 0;
  const minLen = Math.min(currentText.length, newText.length);

  while (prefixLen < minLen && currentText.charCodeAt(prefixLen) === newText.charCodeAt(prefixLen)) {
    prefixLen++;
  }

  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixLen &&
    currentText.charCodeAt(currentText.length - 1 - suffixLen) ===
      newText.charCodeAt(newText.length - 1 - suffixLen)
  ) {
    suffixLen++;
  }

  const middleDeleteLen = currentText.length - prefixLen - suffixLen;
  const middleInsert = newText.slice(prefixLen, newText.length - suffixLen);

  if (middleDeleteLen > 0) {
    ytext.delete(prefixLen, middleDeleteLen);
  }
  if (middleInsert.length > 0) {
    ytext.insert(prefixLen, middleInsert);
  }
}

/**
 * 行级快速 diff
 * 返回变更数组,类似 unified diff 的格式
 */
export function diffLinesFast(
  a: string,
  b: string
): Array<{ value: string; added?: boolean; removed?: boolean }> {
  const chars = dmp.diff_linesToChars_(a, b);
  const lineA = chars.chars1;
  const lineB = chars.chars2;
  const lineArray = chars.lineArray;

  const diffs = dmp.diff_main(lineA, lineB, false);
  dmp.diff_charsToLines_(diffs, lineArray);

  return diffs.map((d) => ({
    value: d[1],
    added: d[0] === 1 ? true : undefined,
    removed: d[0] === -1 ? true : undefined,
  }));
}

/**
 * 计算两个文本的相似度(0-1)
 * 用于判断是否需要做 CRDT 合并,还是直接替换
 */
export function textSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;

  const diffs = dmp.diff_main(a, b);
  const totalLen = diffs.reduce((sum, d) => sum + d[1].length, 0);
  const sameLen = diffs.filter((d) => d[0] === 0).reduce((sum, d) => sum + d[1].length, 0);

  return totalLen > 0 ? sameLen / totalLen : 0;
}
