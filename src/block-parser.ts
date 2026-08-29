/**
 * Block Parser — 将 Markdown 解析为块级结构
 *
 * 设计目标(参考 OpenKnowledge 的 mdast 映射思路):
 * - 把 Markdown 拆成块(标题/段落/列表/代码块/引用/表格/分隔线)
 * - 每个块有类型、内容、签名(用于块级 diff)
 * - 块级 diff 比 行级 diff 更精确:移动段落不会导致大面积冲突
 *
 * 轻量实现:不依赖完整的 mdast/unified,
 * 用行首特征匹配来识别块边界。
 */

export type BlockType =
  | "heading"
  | "paragraph"
  | "list"
  | "code"
  | "blockquote"
  | "table"
  | "hr"
  | "blank";

export interface Block {
  /** 块类型 */
  type: BlockType;
  /** 原始文本(含换行) */
  content: string;
  /** 签名:内容去除空格后的 hash,用于块身份比较 */
  signature: string;
  /** 在原文中的起始行号(0-based) */
  startLine: number;
  /** 块的行数 */
  lineCount: number;
  /** 标题块的级别(1-6),非标题为 0 */
  level: number;
}

/**
 * 计算签名:去掉首尾空白和中间多余空格后的字符串
 * 用于判断两个块是否是"同一个块"(内容可能有细微差异)
 */
function computeSignature(content: string): string {
  return content
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * 判断一行是否是标题行
 */
function getHeadingLevel(line: string): number {
  const match = /^#{1,6}\s/.exec(line);
  return match ? match[0].trim().length : 0;
}

/**
 * 判断一行是否是列表项
 */
function isListItem(line: string): boolean {
  return /^\s*[-*+]\s/.test(line) || /^\s*\d+\.\s/.test(line);
}

/**
 * 判断一行是否是代码围栏
 */
function isCodeFence(line: string): boolean {
  return /^\s*(```|~~~)/.test(line);
}

/**
 * 判断一行是否是引用块
 */
function isBlockquote(line: string): boolean {
  return /^\s*>\s?/.test(line);
}

/**
 * 判断一行是否是表格行
 */
function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

/**
 * 判断一行是否是分隔线
 */
function isHorizontalRule(line: string): boolean {
  return /^\s*([-*_])\1{2,}\s*$/.test(line) || /^\s*-{3,}\s*$/.test(line);
}

/**
 * 将 Markdown 文本解析为块数组
 *
 * 规则:
 * 1. 空行分隔段落
 * 2. 标题(#)+ 后续内容直到空行
 * 3. 列表项连续行直到非列表行或空行
 * 4. 代码围栏 ``` 到 ``` 之间
 * 5. 引用块 > 连续行
 * 6. 表格行 | 连续行
 * 7. 分隔线单独一块
 * 8. 其余为段落
 */
export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const startLine = i;

    // 空行
    if (line.trim() === "") {
      blocks.push({
        type: "blank",
        content: line,
        signature: "",
        startLine,
        lineCount: 1,
        level: 0,
      });
      i++;
      continue;
    }

    // 标题
    const headingLevel = getHeadingLevel(line);
    if (headingLevel > 0) {
      // 标题通常单行,但可能后面跟内容直到空行
      let content = line;
      i++;
      // 标题后面的非空、非新块行也算标题块的一部分
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        getHeadingLevel(lines[i]) === 0 &&
        !isListItem(lines[i]) &&
        !isCodeFence(lines[i]) &&
        !isBlockquote(lines[i]) &&
        !isTableRow(lines[i]) &&
        !isHorizontalRule(lines[i])
      ) {
        content += "\n" + lines[i];
        i++;
      }
      blocks.push({
        type: "heading",
        content,
        signature: computeSignature(content),
        startLine,
        lineCount: i - startLine,
        level: headingLevel,
      });
      continue;
    }

    // 代码围栏
    if (isCodeFence(line)) {
      const fence = line.trim().match(/(```|~~~)/)?.[1] || "```";
      let content = line;
      i++;
      while (i < lines.length && !lines[i].includes(fence)) {
        content += "\n" + lines[i];
        i++;
      }
      if (i < lines.length) {
        content += "\n" + lines[i]; // 闭合围栏
        i++;
      }
      blocks.push({
        type: "code",
        content,
        signature: computeSignature(content),
        startLine,
        lineCount: i - startLine,
        level: 0,
      });
      continue;
    }

    // 分隔线
    if (isHorizontalRule(line)) {
      blocks.push({
        type: "hr",
        content: line,
        signature: "---",
        startLine,
        lineCount: 1,
        level: 0,
      });
      i++;
      continue;
    }

    // 列表
    if (isListItem(line)) {
      let content = line;
      i++;
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        (isListItem(lines[i]) || /^\s+/.test(lines[i])) // 缩进行是列表的一部分
      ) {
        content += "\n" + lines[i];
        i++;
      }
      blocks.push({
        type: "list",
        content,
        signature: computeSignature(content),
        startLine,
        lineCount: i - startLine,
        level: 0,
      });
      continue;
    }

    // 引用块
    if (isBlockquote(line)) {
      let content = line;
      i++;
      while (i < lines.length && (isBlockquote(lines[i]) || lines[i].trim() === "")) {
        content += "\n" + lines[i];
        i++;
      }
      // 去掉尾部空行
      while (content.endsWith("\n") && content.trim().length > 0) {
        content = content.slice(0, -1);
      }
      blocks.push({
        type: "blockquote",
        content,
        signature: computeSignature(content),
        startLine,
        lineCount: i - startLine,
        level: 0,
      });
      continue;
    }

    // 表格
    if (isTableRow(line)) {
      let content = line;
      i++;
      while (i < lines.length && (isTableRow(lines[i]) || lines[i].trim() === "")) {
        content += "\n" + lines[i];
        i++;
      }
      while (content.endsWith("\n")) {
        content = content.slice(0, -1);
      }
      blocks.push({
        type: "table",
        content,
        signature: computeSignature(content),
        startLine,
        lineCount: i - startLine,
        level: 0,
      });
      continue;
    }

    // 段落(默认)
    let content = line;
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      getHeadingLevel(lines[i]) === 0 &&
      !isListItem(lines[i]) &&
      !isCodeFence(lines[i]) &&
      !isBlockquote(lines[i]) &&
      !isTableRow(lines[i]) &&
      !isHorizontalRule(lines[i])
    ) {
      content += "\n" + lines[i];
      i++;
    }
    blocks.push({
      type: "paragraph",
      content,
      signature: computeSignature(content),
      startLine,
      lineCount: i - startLine,
      level: 0,
    });
  }

  return blocks;
}

/**
 * 将块数组还原为 Markdown 文本
 */
export function blocksToMarkdown(blocks: Block[]): string {
  // 保留空行块(它们是段落间的分隔),直接 join
  const parts = blocks.map((b) => b.content);
  return parts.join("\n");
}

/**
 * 获取块的"身份键" — 用于块匹配
 * 标题用 "heading:N:首行前缀",段落用签名的开头部分
 */
export function getBlockIdentity(block: Block): string {
  switch (block.type) {
    case "heading":
      // 标题用级别 + 前几个词作为身份
      const firstLine = block.content.split("\n")[0];
      return `heading:${block.level}:${computeSignature(firstLine).slice(0, 40)}`;
    case "code":
      // 代码块用语言标识 + 前 20 字符
      const fenceMatch = block.content.match(/^```(\w*)/m);
      const lang = fenceMatch?.[1] || "";
      return `code:${lang}:${block.signature.slice(0, 20)}`;
    case "hr":
      return `hr:${block.signature}`;
    default:
      // 其他块用签名的开头 40 字符作为身份
      return `${block.type}:${block.signature.slice(0, 40)}`;
  }
}
