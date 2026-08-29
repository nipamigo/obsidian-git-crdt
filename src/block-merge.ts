/**
 * Block Merge — 块级三路合并
 *
 * 设计(参考 OpenKnowledge 的块级合并思路):
 * 1. 把 baseline / ours / theirs 都解析为块数组
 * 2. 用 LCS(最长公共子序列)做块级 diff:
 *    - baseline → ours 的块级 diff
 *    - baseline → theirs 的块级 diff
 * 3. 三路合并:
 *    - 块在 baseline 和 ours 一致 → 用 theirs(如果 theirs 改了)
 *    - 块在 baseline 和 theirs 一致 → 用 ours(如果 ours 改了)
 *    - 块在两边都改了 → 块内做文本级三路合并(fallback to mergeThreeWay)
 *    - 块只在 ours 新增 → 插入
 *    - 块只在 theirs 新增 → 插入
 *    - 块只在一边删除 → 删除
 *    - 块在两边都删除 → 删除
 *
 * 优势:
 * - 段落移动(剪切-粘贴)不会产生大量冲突
 * - 同段落内的小改动用文本级合并,精度不降
 * - 大纲级别变更(# 标题 → ## 子标题)不影响其他段落
 */

import { Block, parseBlocks, blocksToMarkdown, getBlockIdentity } from "./block-parser";
import { mergeThreeWay } from "./merge";

/**
 * 块级 diff 操作
 */
interface DiffOp {
  type: "retain" | "insert" | "delete" | "modify";
  /** baseline 中的块索引(retain/delete/modify 时有值) */
  baseIndex?: number;
  /** 新块(insert 时有值) */
  newBlock?: Block;
  /** modify 时的修改后内容 */
  modifiedContent?: string;
}

/**
 * 用 LCS 计算两个块数组的 diff
 * 返回操作序列:从 baseline 变到 target 的操作
 */
function computeBlockDiff(baseline: Block[], target: Block[]): DiffOp[] {
  const m = baseline.length;
  const n = target.length;

  // LCS DP 表
  // dp[i][j] = baseline[0..i-1] 和 target[0..j-1] 的 LCS 长度
  // 用签名比较块是否"相同"(签名一致视为同一个块)
  const dp: number[][] = Array(m + 1)
    .fill(0)
    .map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (baseline[i - 1].signature === target[j - 1].signature) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // 回溯生成 diff 操作
  const ops: DiffOp[] = [];
  let i = m, j = n;

  while (i > 0 && j > 0) {
    if (baseline[i - 1].signature === target[j - 1].signature) {
      // retain
      ops.unshift({ type: "retain", baseIndex: i - 1 });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      // baseline[i-1] 被删除
      ops.unshift({ type: "delete", baseIndex: i - 1 });
      i--;
    } else {
      // target[j-1] 是新增
      ops.unshift({ type: "insert", newBlock: target[j - 1] });
      j--;
    }
  }

  while (i > 0) {
    ops.unshift({ type: "delete", baseIndex: i - 1 });
    i--;
  }
  while (j > 0) {
    ops.unshift({ type: "insert", newBlock: target[j - 1] });
    j--;
  }

  // 合并连续的 retain + 后续 modify 检测
  // 实际上 LCS 已经处理了相同块的对齐,不同的块会变成 delete + insert
  // 但我们还想检测"修改"(同一块但内容不同)— 这在签名不同时表现为 delete+insert
  // 为了做块内合并,我们需要检测"相似"的块

  return ops;
}

/**
 * 计算两个块签名之间的相似度(0-1)
 * 用 Jaccard 相似度:交集/并集的字符 n-gram 集合
 */
function blockSimilarity(a: Block, b: Block): number {
  if (a.type !== b.type) return 0;
  if (a.signature === b.signature) return 1;

  // 用 3-gram 集合算 Jaccard
  const gramsA = getNgrams(a.signature, 3);
  const gramsB = getNgrams(b.signature, 3);

  if (gramsA.size === 0 && gramsB.size === 0) return 1;
  if (gramsA.size === 0 || gramsB.size === 0) return 0;

  let intersection = 0;
  for (const g of gramsA) {
    if (gramsB.has(g)) intersection++;
  }
  return intersection / (gramsA.size + gramsB.size - intersection);
}

function getNgrams(text: string, n: number): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i <= text.length - n; i++) {
    grams.add(text.slice(i, i + n));
  }
  return grams;
}

/**
 * 块级三路合并
 *
 * @param baseline 基线版本(Markdown 文本)
 * @param ours 本地版本
 * @param theirs 远程版本
 * @returns 合并后的 Markdown 文本
 */
export function mergeBlocksThreeWay(
  baseline: string,
  ours: string,
  theirs: string
): string {
  // 快速路径
  if (baseline === ours) return theirs;
  if (baseline === theirs) return ours;
  if (ours === theirs) return ours;

  const baseBlocks = parseBlocks(baseline);
  const ourBlocks = parseBlocks(ours);
  const theirBlocks = parseBlocks(theirs);

  // 计算块级 diff
  const diffOurs = computeBlockDiff(baseBlocks, ourBlocks);
  const diffTheirs = computeBlockDiff(baseBlocks, theirBlocks);

  // 三路合并:遍历 baseline 的块,对每个块决定用哪个版本
  // 同时处理新增和删除

  // 构建 baseline 块到 ours/theirs 的映射
  // oursMap: baseline block index → 对应的 ours 块(如果 retain) 或 null(如果 delete)
  const oursMap = buildBlockMapping(diffOurs);
  const theirsMap = buildBlockMapping(diffTheirs);

  // 收集 ours 和 theirs 中新增的块(不在 baseline 中的)
  const ourInserts = collectInserts(diffOurs, baseBlocks);
  const theirInserts = collectInserts(diffTheirs, baseBlocks);

  // 合并
  const result: Block[] = [];

  // 先处理所有 baseline 块
  for (let baseIdx = 0; baseIdx < baseBlocks.length; baseIdx++) {
    const baseBlock = baseBlocks[baseIdx];

    // 在 ours 中这个块的状态
    const oursState = oursMap.get(baseIdx); // Block | "deleted" | undefined
    // 在 theirs 中这个块的状态
    const theirsState = theirsMap.get(baseIdx);

    // 在处理 baseline 块之前,先插入"在这个位置之前新增的块"
    const ourNewBlocks = ourInserts.get(baseIdx) || [];
    const theirNewBlocks = theirInserts.get(baseIdx) || [];

    // 先插入两边的新增块(用签名去重,避免重复)
    const insertedSigs = new Set<string>();
    for (const b of ourNewBlocks) {
      if (!insertedSigs.has(b.signature)) {
        result.push(b);
        insertedSigs.add(b.signature);
      }
    }
    for (const b of theirNewBlocks) {
      if (!insertedSigs.has(b.signature)) {
        result.push(b);
        insertedSigs.add(b.signature);
      }
    }

    // 处理 baseline 块本身
    const oursBlock = oursState instanceof Object ? oursState : null;
    const theirsBlock = theirsState instanceof Object ? theirsState : null;
    const oursDeleted = oursState === "deleted";
    const theirsDeleted = theirsState === "deleted";

    if (oursDeleted && theirsDeleted) {
      // 两边都删了 → 跳过
      continue;
    }

    if (oursDeleted && !theirsDeleted) {
      // ours 删了,theirs 没删 → 用 theirs 的版本
      if (theirsBlock) result.push(theirsBlock);
      else result.push(baseBlock); // theirs 保留了原样
      continue;
    }

    if (theirsDeleted && !oursDeleted) {
      // theirs 删了,ours 没删 → 用 ours 的版本
      if (oursBlock) result.push(oursBlock);
      else result.push(baseBlock);
      continue;
    }

    // 两边都没删
    if (oursBlock && theirsBlock) {
      // 两边都改了 → 块内文本级合并
      const mergedContent = mergeThreeWay(
        baseBlock.content,
        oursBlock.content,
        theirsBlock.content
      );
      result.push({
        ...oursBlock,
        content: mergedContent,
        signature: computeSignature(mergedContent),
      });
    } else if (oursBlock) {
      // 只有 ours 改了
      result.push(oursBlock);
    } else if (theirsBlock) {
      // 只有 theirs 改了
      result.push(theirsBlock);
    } else {
      // 两边都没改
      result.push(baseBlock);
    }
  }

  // 处理在 baseline 最后面新增的块
  const ourTrailing = ourInserts.get(baseBlocks.length) || [];
  const theirTrailing = theirInserts.get(baseBlocks.length) || [];
  const insertedSigs = new Set<string>();
  for (const b of result) insertedSigs.add(b.signature);
  for (const b of [...ourTrailing, ...theirTrailing]) {
    if (!insertedSigs.has(b.signature)) {
      result.push(b);
      insertedSigs.add(b.signature);
    }
  }

  return blocksToMarkdown(result);
}

/**
 * 从 diff 操作构建块映射
 * 返回:Map<baseIndex, Block | "deleted">
 */
function buildBlockMapping(diffOps: DiffOp[]): Map<number, Block | string> {
  const map = new Map<number, Block | string>();
  for (const op of diffOps) {
    if (op.type === "retain" && op.baseIndex !== undefined) {
      // 保留:不加入 map(表示未修改)
    } else if (op.type === "delete" && op.baseIndex !== undefined) {
      map.set(op.baseIndex, "deleted");
    } else if (op.type === "insert" && op.newBlock) {
      // 新增:不在这个 map 中(在 collectInserts 中处理)
    }
  }
  return map;
}

/**
 * 收集新增块:Map<baseIndex, Block[]>
 * baseIndex 表示这个新增块出现在哪个 baseline 块之前
 * 如果 baseIndex == baseline.length,表示在最后面
 *
 * 注意:LCS diff 中的 insert 操作位置需要映射到 baseline 块索引
 */
function collectInserts(diffOps: DiffOp[], baseline: Block[]): Map<number, Block[]> {
  const inserts = new Map<number, Block[]>();
  let baseIdx = 0; // 当前在 baseline 中的位置

  for (const op of diffOps) {
    if (op.type === "retain") {
      baseIdx = (op.baseIndex ?? 0) + 1;
    } else if (op.type === "delete") {
      baseIdx = (op.baseIndex ?? 0) + 1;
    } else if (op.type === "insert" && op.newBlock) {
      const arr = inserts.get(baseIdx) || [];
      arr.push(op.newBlock);
      inserts.set(baseIdx, arr);
    }
  }

  return inserts;
}

/**
 * 修正版块映射:需要检测"修改"的情况
 * 当 baseline 的一个块在 ours/theirs 中被删除,但紧接着有一个相似的块被插入时,
 * 这应该被视为"修改"而非"删除+插入"
 *
 * 这个修正提高合并质量:避免把修改段落误判为删除+新增
 */
function refineMapping(
  baseline: Block[],
  diffOps: DiffOp[]
): Map<number, Block | string> {
  const map = new Map<number, Block | string>();
  const pendingInserts: Block[] = [];

  let baseIdx = 0;
  for (let i = 0; i < diffOps.length; i++) {
    const op = diffOps[i];

    if (op.type === "retain" && op.baseIndex !== undefined) {
      // 先处理积累的 pending inserts
      pendingInserts.length = 0;
      baseIdx = op.baseIndex + 1;
    } else if (op.type === "delete" && op.baseIndex !== undefined) {
      // 检查后面是否有相似的 insert
      const nextOp = diffOps[i + 1];
      if (nextOp?.type === "insert" && nextOp.newBlock) {
        const sim = blockSimilarity(baseline[op.baseIndex], nextOp.newBlock);
        if (sim > 0.3) {
          // 相似度高 → 视为修改
          map.set(op.baseIndex, nextOp.newBlock);
          i++; // 跳过这个 insert
          pendingInserts.length = 0;
          baseIdx = op.baseIndex + 1;
          continue;
        }
      }
      map.set(op.baseIndex, "deleted");
      baseIdx = op.baseIndex + 1;
    } else if (op.type === "insert" && op.newBlock) {
      pendingInserts.push(op.newBlock);
    }
  }

  return map;
}

// 重新实现,使用 refineMapping
export function mergeBlocksThreeWayV2(
  baseline: string,
  ours: string,
  theirs: string
): string {
  if (baseline === ours) return theirs;
  if (baseline === theirs) return ours;
  if (ours === theirs) return ours;

  const baseBlocks = parseBlocks(baseline);
  const ourBlocks = parseBlocks(ours);
  const theirBlocks = parseBlocks(theirs);

  const diffOurs = computeBlockDiff(baseBlocks, ourBlocks);
  const diffTheirs = computeBlockDiff(baseBlocks, theirBlocks);

  // 使用 refineMapping 检测修改
  const oursMap = refineMapping(baseBlocks, diffOurs);
  const theirsMap = refineMapping(baseBlocks, diffTheirs);

  // 收集新增块(用原始 diff)
  const ourInserts = collectInserts(diffOurs, baseBlocks);
  const theirInserts = collectInserts(diffTheirs, baseBlocks);

  const result: Block[] = [];

  for (let baseIdx = 0; baseIdx < baseBlocks.length; baseIdx++) {
    const baseBlock = baseBlocks[baseIdx];

    // 插入在此位置之前的新增块
    const ourNewBlocks = ourInserts.get(baseIdx) || [];
    const theirNewBlocks = theirInserts.get(baseIdx) || [];
    const insertedSigs = new Set<string>();

    for (const b of ourNewBlocks) {
      if (!insertedSigs.has(b.signature)) {
        result.push(b);
        insertedSigs.add(b.signature);
      }
    }
    for (const b of theirNewBlocks) {
      if (!insertedSigs.has(b.signature)) {
        result.push(b);
        insertedSigs.add(b.signature);
      }
    }

    // 处理 baseline 块
    const oursVal = oursMap.get(baseIdx);
    const theirsVal = theirsMap.get(baseIdx);

    const oursBlock = oursVal instanceof Object ? oursVal : null;
    const theirsBlock = theirsVal instanceof Object ? theirsVal : null;
    const oursDeleted = oursVal === "deleted";
    const theirsDeleted = theirsVal === "deleted";

    if (oursDeleted && theirsDeleted) continue;

    if (oursDeleted && !theirsDeleted) {
      result.push(theirsBlock || baseBlock);
      continue;
    }
    if (theirsDeleted && !oursDeleted) {
      result.push(oursBlock || baseBlock);
      continue;
    }

    if (oursBlock && theirsBlock) {
      const mergedContent = mergeThreeWay(
        baseBlock.content,
        oursBlock.content,
        theirsBlock.content
      );
      result.push({
        ...oursBlock,
        content: mergedContent,
        signature: computeSignature(mergedContent),
      });
    } else if (oursBlock) {
      result.push(oursBlock);
    } else if (theirsBlock) {
      result.push(theirsBlock);
    } else {
      result.push(baseBlock);
    }
  }

  // 尾部新增
  const ourTrailing = ourInserts.get(baseBlocks.length) || [];
  const theirTrailing = theirInserts.get(baseBlocks.length) || [];
  const insertedSigs = new Set(result.map((b) => b.signature));
  for (const b of [...ourTrailing, ...theirTrailing]) {
    if (!insertedSigs.has(b.signature)) {
      result.push(b);
      insertedSigs.add(b.signature);
    }
  }

  return blocksToMarkdown(result);
}

function computeSignature(content: string): string {
  return content.replace(/\s+/g, " ").trim().toLowerCase();
}
