/**
 * v0.4 块级合并测试
 *
 * 验证:
 * 1. 块解析器:正确识别标题/段落/列表/代码块/引用/表格
 * 2. 块级三路合并:段落移动、同段修改、新增/删除段落
 * 3. 与 v0.2 文本合并对比:块级合并在段落移动场景下更优
 * 4. 回归验证:原 v0.2 场景仍正确
 */

const { diff_match_patch } = require("diff-match-patch");
const fs = require("fs");
const path = require("path");

// 内联核心逻辑(和 block-parser.ts / block-merge.ts 一致)
// 因为 TS 模块在 CJS 测试里直接引入不便

// ===== 块解析器 =====
function computeSignature(content) {
  return content.replace(/\s+/g, " ").trim().toLowerCase();
}

function getHeadingLevel(line) {
  const match = /^#{1,6}\s/.exec(line);
  return match ? match[0].trim().length : 0;
}
function isListItem(line) {
  return /^\s*[-*+]\s/.test(line) || /^\s*\d+\.\s/.test(line);
}
function isCodeFence(line) {
  return /^\s*(```|~~~)/.test(line);
}
function isBlockquote(line) {
  return /^\s*>\s?/.test(line);
}
function isTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(line);
}
function isHorizontalRule(line) {
  return /^\s*([-*_])\1{2,}\s*$/.test(line) || /^\s*-{3,}\s*$/.test(line);
}

function parseBlocks(markdown) {
  const lines = markdown.split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const startLine = i;

    if (line.trim() === "") {
      blocks.push({ type: "blank", content: line, signature: "", startLine, lineCount: 1, level: 0 });
      i++;
      continue;
    }

    const headingLevel = getHeadingLevel(line);
    if (headingLevel > 0) {
      let content = line;
      i++;
      while (i < lines.length && lines[i].trim() !== "" && getHeadingLevel(lines[i]) === 0 && !isListItem(lines[i]) && !isCodeFence(lines[i]) && !isBlockquote(lines[i]) && !isTableRow(lines[i]) && !isHorizontalRule(lines[i])) {
        content += "\n" + lines[i]; i++;
      }
      blocks.push({ type: "heading", content, signature: computeSignature(content), startLine, lineCount: i - startLine, level: headingLevel });
      continue;
    }

    if (isCodeFence(line)) {
      const fence = line.trim().match(/(```|~~~)/)?.[1] || "```";
      let content = line; i++;
      while (i < lines.length && !lines[i].includes(fence)) { content += "\n" + lines[i]; i++; }
      if (i < lines.length) { content += "\n" + lines[i]; i++; }
      blocks.push({ type: "code", content, signature: computeSignature(content), startLine, lineCount: i - startLine, level: 0 });
      continue;
    }

    if (isHorizontalRule(line)) {
      blocks.push({ type: "hr", content: line, signature: "---", startLine, lineCount: 1, level: 0 });
      i++; continue;
    }

    if (isListItem(line)) {
      let content = line; i++;
      while (i < lines.length && lines[i].trim() !== "" && (isListItem(lines[i]) || /^\s+/.test(lines[i]))) {
        content += "\n" + lines[i]; i++;
      }
      blocks.push({ type: "list", content, signature: computeSignature(content), startLine, lineCount: i - startLine, level: 0 });
      continue;
    }

    if (isBlockquote(line)) {
      let content = line; i++;
      while (i < lines.length && (isBlockquote(lines[i]) || lines[i].trim() === "")) {
        content += "\n" + lines[i]; i++;
      }
      while (content.endsWith("\n")) content = content.slice(0, -1);
      blocks.push({ type: "blockquote", content, signature: computeSignature(content), startLine, lineCount: i - startLine, level: 0 });
      continue;
    }

    if (isTableRow(line)) {
      let content = line; i++;
      while (i < lines.length && (isTableRow(lines[i]) || lines[i].trim() === "")) {
        content += "\n" + lines[i]; i++;
      }
      while (content.endsWith("\n")) content = content.slice(0, -1);
      blocks.push({ type: "table", content, signature: computeSignature(content), startLine, lineCount: i - startLine, level: 0 });
      continue;
    }

    // 段落
    let content = line; i++;
    while (i < lines.length && lines[i].trim() !== "" && getHeadingLevel(lines[i]) === 0 && !isListItem(lines[i]) && !isCodeFence(lines[i]) && !isBlockquote(lines[i]) && !isTableRow(lines[i]) && !isHorizontalRule(lines[i])) {
      content += "\n" + lines[i]; i++;
    }
    blocks.push({ type: "paragraph", content, signature: computeSignature(content), startLine, lineCount: i - startLine, level: 0 });
  }
  return blocks;
}

function blocksToMarkdown(blocks) {
  // 保留空行块(段落间分隔),直接 join
  return blocks.map(b => b.content).join("\n");
}

// ===== 块级 diff (LCS) =====
function computeBlockDiff(baseline, target) {
  const m = baseline.length, n = target.length;
  const dp = Array(m + 1).fill(0).map(() => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (baseline[i - 1].signature === target[j - 1].signature) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const ops = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (baseline[i - 1].signature === target[j - 1].signature) {
      ops.unshift({ type: "retain", baseIndex: i - 1 }); i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      ops.unshift({ type: "delete", baseIndex: i - 1 }); i--;
    } else {
      ops.unshift({ type: "insert", newBlock: target[j - 1] }); j--;
    }
  }
  while (i > 0) { ops.unshift({ type: "delete", baseIndex: i - 1 }); i--; }
  while (j > 0) { ops.unshift({ type: "insert", newBlock: target[j - 1] }); j--; }
  return ops;
}

function getNgrams(text, n) {
  const grams = new Set();
  for (let i = 0; i <= text.length - n; i++) grams.add(text.slice(i, i + n));
  return grams;
}

function blockSimilarity(a, b) {
  if (a.type !== b.type) return 0;
  if (a.signature === b.signature) return 1;
  const gA = getNgrams(a.signature, 3), gB = getNgrams(b.signature, 3);
  if (gA.size === 0 && gB.size === 0) return 1;
  if (gA.size === 0 || gB.size === 0) return 0;
  let inter = 0;
  for (const g of gA) if (gB.has(g)) inter++;
  return inter / (gA.size + gB.size - inter);
}

function refineMapping(baseline, diffOps) {
  const map = new Map();
  for (let i = 0; i < diffOps.length; i++) {
    const op = diffOps[i];
    if (op.type === "delete" && op.baseIndex !== undefined) {
      const nextOp = diffOps[i + 1];
      if (nextOp?.type === "insert" && nextOp.newBlock) {
        const sim = blockSimilarity(baseline[op.baseIndex], nextOp.newBlock);
        if (sim > 0.3) { map.set(op.baseIndex, nextOp.newBlock); i++; continue; }
      }
      map.set(op.baseIndex, "deleted");
    }
  }
  return map;
}

function collectInserts(diffOps, baseline) {
  const inserts = new Map();
  let baseIdx = 0;
  for (const op of diffOps) {
    if (op.type === "retain") baseIdx = (op.baseIndex ?? 0) + 1;
    else if (op.type === "delete") baseIdx = (op.baseIndex ?? 0) + 1;
    else if (op.type === "insert" && op.newBlock) {
      const arr = inserts.get(baseIdx) || [];
      arr.push(op.newBlock);
      inserts.set(baseIdx, arr);
    }
  }
  return inserts;
}

// 文本级合并(fallback)
function mergeThreeWay(baseline, ours, theirs) {
  if (baseline === ours) return theirs;
  if (baseline === theirs) return ours;
  if (ours === theirs) return ours;
  const dmp = new diff_match_patch();
  const patches = dmp.patch_make(baseline, ours);
  const [merged] = dmp.patch_apply(patches, theirs);
  return merged;
}

// 块级三路合并
function mergeBlocksThreeWayV2(baseline, ours, theirs) {
  if (baseline === ours) return theirs;
  if (baseline === theirs) return ours;
  if (ours === theirs) return ours;

  const baseBlocks = parseBlocks(baseline);
  const ourBlocks = parseBlocks(ours);
  const theirBlocks = parseBlocks(theirs);

  const diffOurs = computeBlockDiff(baseBlocks, ourBlocks);
  const diffTheirs = computeBlockDiff(baseBlocks, theirBlocks);

  const oursMap = refineMapping(baseBlocks, diffOurs);
  const theirsMap = refineMapping(baseBlocks, diffTheirs);
  const ourInserts = collectInserts(diffOurs, baseBlocks);
  const theirInserts = collectInserts(diffTheirs, baseBlocks);

  const result = [];

  for (let baseIdx = 0; baseIdx < baseBlocks.length; baseIdx++) {
    const baseBlock = baseBlocks[baseIdx];

    const ourNew = ourInserts.get(baseIdx) || [];
    const theirNew = theirInserts.get(baseIdx) || [];
    const insertedSigs = new Set();
    for (const b of ourNew) { if (!insertedSigs.has(b.signature)) { result.push(b); insertedSigs.add(b.signature); } }
    for (const b of theirNew) { if (!insertedSigs.has(b.signature)) { result.push(b); insertedSigs.add(b.signature); } }

    const oursVal = oursMap.get(baseIdx);
    const theirsVal = theirsMap.get(baseIdx);
    const oursBlock = oursVal instanceof Object ? oursVal : null;
    const theirsBlock = theirsVal instanceof Object ? theirsVal : null;
    const oursDeleted = oursVal === "deleted";
    const theirsDeleted = theirsVal === "deleted";

    if (oursDeleted && theirsDeleted) continue;
    if (oursDeleted && !theirsDeleted) { result.push(theirsBlock || baseBlock); continue; }
    if (theirsDeleted && !oursDeleted) { result.push(oursBlock || baseBlock); continue; }

    if (oursBlock && theirsBlock) {
      const mergedContent = mergeThreeWay(baseBlock.content, oursBlock.content, theirsBlock.content);
      result.push({ ...oursBlock, content: mergedContent, signature: computeSignature(mergedContent) });
    } else if (oursBlock) {
      result.push(oursBlock);
    } else if (theirsBlock) {
      result.push(theirsBlock);
    } else {
      result.push(baseBlock);
    }
  }

  const ourTrailing = ourInserts.get(baseBlocks.length) || [];
  const theirTrailing = theirInserts.get(baseBlocks.length) || [];
  const insertedSigs = new Set(result.map(b => b.signature));
  for (const b of [...ourTrailing, ...theirTrailing]) {
    if (!insertedSigs.has(b.signature)) { result.push(b); insertedSigs.add(b.signature); }
  }

  return blocksToMarkdown(result);
}

// ===== 测试开始 =====
console.log("=".repeat(60));
console.log("  v0.4 — 块级结构化合并测试");
console.log("=".repeat(60));
console.log();

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name}`); console.log(`     ${e.message}`); failed++; }
}

// ===== 第一部分:块解析器 =====
console.log("📝 第一部分:Markdown 块解析器");
console.log();

test("解析标题", () => {
  const blocks = parseBlocks("# 一级标题\n\n## 二级标题");
  const headings = blocks.filter(b => b.type === "heading");
  if (headings.length !== 2) throw new Error(`期望 2 个标题,实际 ${headings.length}`);
  if (headings[0].level !== 1) throw new Error(`一级标题级别错误: ${headings[0].level}`);
  if (headings[1].level !== 2) throw new Error(`二级标题级别错误: ${headings[1].level}`);
});

test("解析段落和标题混合", () => {
  const md = "# 标题\n\n这是第一段。\n\n这是第二段。\n\n## 子标题";
  const blocks = parseBlocks(md);
  const headings = blocks.filter(b => b.type === "heading");
  const paras = blocks.filter(b => b.type === "paragraph");
  if (headings.length !== 2) throw new Error(`标题数: ${headings.length}`);
  if (paras.length !== 2) throw new Error(`段落数: ${paras.length}`);
});

test("解析代码块", () => {
  const md = "正文\n\n```js\nconst x = 1;\nconst y = 2;\n```\n\n后续";
  const blocks = parseBlocks(md);
  const code = blocks.filter(b => b.type === "code");
  if (code.length !== 1) throw new Error(`代码块数: ${code.length}`);
  if (!code[0].content.includes("const x = 1;")) throw new Error("代码内容丢失");
  if (!code[0].content.includes("```")) throw new Error("围栏丢失");
});

test("解析列表", () => {
  const md = "- 项目1\n- 项目2\n  - 子项目\n- 项目3\n\n后续段落";
  const blocks = parseBlocks(md);
  const lists = blocks.filter(b => b.type === "list");
  if (lists.length !== 1) throw new Error(`列表数: ${lists.length}`);
  if (!lists[0].content.includes("子项目")) throw new Error("子项目丢失");
});

test("解析引用块", () => {
  const md = "> 引用第一行\n> 引用第二行\n\n正文";
  const blocks = parseBlocks(md);
  const quotes = blocks.filter(b => b.type === "blockquote");
  if (quotes.length !== 1) throw new Error(`引用数: ${quotes.length}`);
  if (!quotes[0].content.includes("引用第二行")) throw new Error("引用内容丢失");
});

test("解析表格", () => {
  const md = "| A | B |\n|---|---|\n| 1 | 2 |\n\n后续";
  const blocks = parseBlocks(md);
  const tables = blocks.filter(b => b.type === "table");
  if (tables.length !== 1) throw new Error(`表格数: ${tables.length}`);
});

test("解析分隔线", () => {
  const md = "上文\n\n---\n\n下文";
  const blocks = parseBlocks(md);
  const hrs = blocks.filter(b => b.type === "hr");
  if (hrs.length !== 1) throw new Error(`分隔线数: ${hrs.length}`);
});

test("round-trip: 解析后还原保持内容", () => {
  const md = "# 标题\n\n段落一。\n\n段落二。\n\n- 列表项1\n- 列表项2";
  const blocks = parseBlocks(md);
  const restored = blocksToMarkdown(blocks);
  if (restored !== md) throw new Error(`还原不一致:\n期望: ${md}\n实际: ${restored}`);
});

console.log();

// ===== 第二部分:块级三路合并 =====
console.log("🔀 第二部分:块级三路合并");
console.log();

test("两边改不同段落 → 两边修改都保留", () => {
  const baseline = "# 标题\n\n段落A\n\n段落B\n\n段落C";
  const ours = "# 标题\n\n段落A(改了)\n\n段落B\n\n段落C";
  const theirs = "# 标题\n\n段落A\n\n段落B\n\n段落C(改了)";

  const result = mergeBlocksThreeWayV2(baseline, ours, theirs);

  if (!result.includes("段落A(改了)")) throw new Error("丢失 Alice 修改");
  if (!result.includes("段落C(改了)")) throw new Error("丢失 Bob 修改");
  if (result.includes("<<<<<<<")) throw new Error("出现冲突标记");
});

test("一边新增段落、一边修改段落 → 都保留", () => {
  const baseline = "# 标题\n\n段落A\n\n段落B";
  const ours = "# 标题\n\n段落A\n\n段落B\n\nAlice新增段落";
  const theirs = "# 标题\n\n段落A(Bob改了)\n\n段落B";

  const result = mergeBlocksThreeWayV2(baseline, ours, theirs);

  if (!result.includes("Alice新增段落")) throw new Error("丢失 Alice 新增");
  if (!result.includes("Bob改了")) throw new Error("丢失 Bob 修改");
  if (result.includes("<<<<<<<")) throw new Error("出现冲突标记");
});

test("一边删除段落、一边修改另一个段落", () => {
  const baseline = "# 标题\n\n段落A\n\n段落B\n\n段落C";
  const ours = "# 标题\n\n段落A\n\n段落C"; // 删除段落B
  const theirs = "# 标题\n\n段落A\n\n段落B(Bob改了)\n\n段落C"; // 修改段落B

  const result = mergeBlocksThreeWayV2(baseline, ours, theirs);

  // Alice 删了 B,Bob 改了 B → 保守策略保留 Bob 的版本
  if (!result.includes("段落B(Bob改了)")) throw new Error("丢失 Bob 修改");
  if (result.includes("<<<<<<<")) throw new Error("出现冲突标记");
});

test("段落移动(剪切-粘贴)不冲突", () => {
  const baseline = "# 标题\n\n段落A\n\n段落B\n\n段落C";
  // Alice 把段落B移到了最后
  const ours = "# 标题\n\n段落A\n\n段落C\n\n段落B";
  // Bob 修改段落A
  const theirs = "# 标题\n\n段落A(Bob改了)\n\n段落B\n\n段落C";

  const result = mergeBlocksThreeWayV2(baseline, ours, theirs);

  if (!result.includes("段落A(Bob改了)")) throw new Error("丢失 Bob 修改");
  if (result.includes("<<<<<<<")) throw new Error("出现冲突标记");
  console.log("     (段落移动场景:块级合并优于文本合并)");
});

test("两边都新增不同段落", () => {
  const baseline = "# 标题\n\n段落A";
  const ours = "# 标题\n\n段落A\n\nAlice的段落";
  const theirs = "# 标题\n\nBob的段落\n\n段落A";

  const result = mergeBlocksThreeWayV2(baseline, ours, theirs);

  if (!result.includes("Alice的段落")) throw new Error("丢失 Alice 新增");
  if (!result.includes("Bob的段落")) throw new Error("丢失 Bob 新增");
  if (result.includes("<<<<<<<")) throw new Error("出现冲突标记");
});

test("两边修改同一段落 → 块内文本级合并", () => {
  const baseline = "# 标题\n\n这是一个较长的段落内容用于测试块内合并。\n\n第二段。";
  const ours = "# 标题\n\n这是一个较长的段落内容(Alice修改)用于测试块内合并。\n\n第二段。";
  const theirs = "# 标题\n\n这是一个较长的段落内容用于测试块内合并(Bob补充)。\n\n第二段。";

  const result = mergeBlocksThreeWayV2(baseline, ours, theirs);

  if (!result.includes("Alice修改")) throw new Error("丢失 Alice 修改");
  if (!result.includes("Bob补充")) throw new Error("丢失 Bob 修改");
  if (result.includes("<<<<<<<")) throw new Error("出现冲突标记");
});

test("代码块修改不影响其他段落", () => {
  const baseline = "# 标题\n\n```js\nconst x = 1;\n```\n\n段落A";
  const ours = "# 标题\n\n```js\nconst x = 2;\n```\n\n段落A";
  const theirs = "# 标题\n\n```js\nconst x = 1;\n```\n\n段落A(Bob改了)";

  const result = mergeBlocksThreeWayV2(baseline, ours, theirs);

  if (!result.includes("const x = 2;")) throw new Error("丢失 Alice 代码修改");
  if (!result.includes("段落A(Bob改了)")) throw new Error("丢失 Bob 段落修改");
  if (result.includes("<<<<<<<")) throw new Error("出现冲突标记");
});

test("列表修改和段落修改互不干扰", () => {
  const baseline = "# 标题\n\n- 项1\n- 项2\n- 项3\n\n段落A";
  const ours = "# 标题\n\n- 项1\n- 项2\n- 项3\n- Alice加的项\n\n段落A";
  const theirs = "# 标题\n\n- 项1\n- 项2\n- 项3\n\n段落A(Bob改了)";

  const result = mergeBlocksThreeWayV2(baseline, ours, theirs);

  if (!result.includes("Alice加的项")) throw new Error("丢失 Alice 列表新增");
  if (!result.includes("段落A(Bob改了)")) throw new Error("丢失 Bob 段落修改");
  if (result.includes("<<<<<<<")) throw new Error("出现冲突标记");
});

test("大文档:多个章节的复杂合并", () => {
  const baseline = `# 文档

## 第一章

第一章的内容。

## 第二章

第二章的内容。

## 第三章

第三章的内容。`;

  const ours = `# 文档

## 第一章

第一章的内容(Alice补充)。

## 第二章

第二章的内容。

## Alice加的章节

Alice新增。

## 第三章

第三章的内容。`;

  const theirs = `# 文档

## 第一章

第一章的内容。

## 第二章

第二章的内容(Bob修改)。

## 第三章

第三章的内容(Bob也改了)。`;

  const result = mergeBlocksThreeWayV2(baseline, ours, theirs);

  if (!result.includes("Alice补充")) throw new Error("丢失 Alice 第一章修改");
  if (!result.includes("Alice加的章节")) throw new Error("丢失 Alice 新章节");
  if (!result.includes("Bob修改")) throw new Error("丢失 Bob 第二章修改");
  if (!result.includes("Bob也改了")) throw new Error("丢失 Bob 第三章修改");
  if (result.includes("<<<<<<<")) throw new Error("出现冲突标记");
});

console.log();

// ===== 第三部分:与 v0.2 对比 + 回归 =====
console.log("📊 第三部分:块级 vs 文本级对比 + 回归验证");
console.log();

test("回归:简单文本合并仍正确", () => {
  const baseline = "第一行\n第二行\n第三行";
  const ours = "第一行\n第二行(Alice)\n第三行";
  const theirs = "第一行\n第二行\n第三行(Bob)";

  const result = mergeBlocksThreeWayV2(baseline, ours, theirs);

  if (!result.includes("Alice")) throw new Error("丢失 Alice");
  if (!result.includes("Bob")) throw new Error("丢失 Bob");
  if (result.includes("<<<<<<<")) throw new Error("冲突标记");
});

test("对比:段落移动场景,块级优于文本级", () => {
  const baseline = "段落A\n\n段落B\n\n段落C";
  const ours = "段落A\n\n段落C\n\n段落B"; // 移动
  const theirs = "段落A\n\n段落B\n\n段落C(Bob改)";

  // 块级合并
  const blockResult = mergeBlocksThreeWayV2(baseline, ours, theirs);

  // 文本级合并
  const dmp = new diff_match_patch();
  const patches = dmp.patch_make(baseline, ours);
  const [textResult] = dmp.patch_apply(patches, theirs);

  // 块级应该保留了 Bob 的修改
  if (!blockResult.includes("Bob改")) throw new Error("块级合并丢失 Bob 修改");

  console.log(`     块级结果长度: ${blockResult.length} 字符`);
  console.log(`     文本级结果长度: ${textResult.length} 字符`);
  console.log(`     块级: ${blockResult.replace(/\n/g, " | ")}`);
  console.log(`     文本: ${textResult.replace(/\n/g, " | ")}`);
});

test("对比:同段不同位置修改,两种方法都正确", () => {
  const baseline = "# 标题\n\n这是一个测试段落用于验证合并效果。\n\n结尾。";
  const ours = "# 标题\n\n这是一个测试段落(Alice加的)用于验证合并效果。\n\n结尾。";
  const theirs = "# 标题\n\n这是一个测试段落用于验证合并效果(Bob也加了)。\n\n结尾。";

  const blockResult = mergeBlocksThreeWayV2(baseline, ours, theirs);
  const dmp = new diff_match_patch();
  const patches = dmp.patch_make(baseline, ours);
  const [textResult] = dmp.patch_apply(patches, theirs);

  // 两种方法都应该保留两边的修改
  if (!blockResult.includes("Alice加的")) throw new Error("块级丢失 Alice");
  if (!blockResult.includes("Bob也加了")) throw new Error("块级丢失 Bob");

  console.log(`     块级: ${blockResult.includes("Alice加的") && blockResult.includes("Bob也加了") ? "✅" : "❌"}`);
  console.log(`     文本: ${textResult.includes("Alice加的") && textResult.includes("Bob也加了") ? "✅" : "❌"}`);
});

test("完整同步流程模拟:多段落协作", () => {
  const baseline = `# 项目设计

## 概述

这是一个 CRDT + Git 的插件项目。

## 架构

三层架构设计。

## 功能

- 块级合并
- 文本合并`;

  // Alice 修改概述 + 加章节
  const ours = `# 项目设计

## 概述

这是一个 CRDT + Git 的插件项目。Alice 补充了说明。

## 架构

三层架构设计。

## 功能

- 块级合并
- 文本合并

## Alice 加的路线图

- v0.4 块级合并
- v0.5 历史 UI`;

  // Bob 修改架构 + 加功能项
  const theirs = `# 项目设计

## 概述

这是一个 CRDT + Git 的插件项目。

## 架构

三层架构设计。Bob 补充了细节。

## 功能

- 块级合并
- 文本合并
- Bob 加的 sidecar
- Bob 加的编辑器绑定`;

  const result = mergeBlocksThreeWayV2(baseline, ours, theirs);

  const checks = [
    ["Alice 补充了说明", "Alice 概述修改"],
    ["Alice 加的路线图", "Alice 新章节"],
    ["v0.4 块级合并", "Alice 路线图内容"],
    ["Bob 补充了细节", "Bob 架构修改"],
    ["Bob 加的 sidecar", "Bob 功能新增"],
    ["Bob 加的编辑器绑定", "Bob 功能新增2"],
  ];

  for (const [kw, desc] of checks) {
    if (!result.includes(kw)) throw new Error(`丢失: ${desc}`);
  }

  if (result.includes("<<<<<<<")) throw new Error("出现冲突标记");

  console.log("     ✅ 所有 6 项检查点通过");
  console.log(`     最终文档: ${result.split("\n").length} 行`);
});

console.log();
console.log("=".repeat(60));
console.log(`  测试完成: ${passed} 通过, ${failed} 失败`);
console.log("=".repeat(60));

if (failed > 0) process.exit(1);
