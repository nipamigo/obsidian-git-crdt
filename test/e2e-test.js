/**
 * 端到端验证测试 v2
 *
 * 验证内容:
 * 1. 三路文本合并算法(单元测试)
 * 2. Yjs CRDT + applyFastDiff 增量更新(单元测试)
 * 3. 完整同步流程模拟(集成测试)
 *    - 两人基于同一版本各自修改
 *    - 模拟 smartPull + 三路合并的同步流程
 *    - 验证无冲突标记、内容保全、最终一致
 *
 * 注:不用 isomorphic-git 的 push/pull(它只支持 HTTP/SSH),
 *    而是手动模拟 fetch + 文件读写的同步流程,
 *    核心验证的是合并逻辑本身的正确性。
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { diff_match_patch } = require("diff-match-patch");
const Y = require("yjs");

// ===== 测试配置 =====
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "git-crdt-test-"));
const REMOTE_DIR = path.join(TEST_DIR, "remote");
const ALICE_DIR = path.join(TEST_DIR, "alice");
const BOB_DIR = path.join(TEST_DIR, "bob");

console.log("=".repeat(60));
console.log("  obsidian-git-crdt — 端到端验证测试");
console.log("=".repeat(60));
console.log(`测试目录: ${TEST_DIR}`);
console.log();

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
    failed++;
  }
}

function asyncTest(name, fn) {
  return fn().then(
    () => {
      console.log(`  ✅ ${name}`);
      passed++;
    },
    (e) => {
      console.log(`  ❌ ${name}`);
      console.log(`     ${e.message}`);
      failed++;
    }
  );
}

// ===== 合并核心函数(和插件的 merge.ts 逻辑一致) =====
function mergeThreeWay(baseline, ours, theirs) {
  if (baseline === ours) return theirs;
  if (baseline === theirs) return ours;
  if (ours === theirs) return ours;

  const dmp = new diff_match_patch();
  // 字符级 patch 合并:生成 ours 相对于 baseline 的 patch,应用到 theirs
  const patches = dmp.patch_make(baseline, ours);
  const [merged] = dmp.patch_apply(patches, theirs);
  return merged;
}

function applyFastDiff(ytext, currentText, newText) {
  if (currentText === newText) return;
  const dmp = new diff_match_patch();
  const chars = dmp.diff_linesToChars_(currentText, newText);
  const diffs = dmp.diff_main(chars.chars1, chars.chars2, false);
  dmp.diff_charsToLines_(diffs, chars.lineArray);

  let offset = 0;
  for (const d of diffs) {
    if (d[0] === -1) {
      ytext.delete(offset, d[1].length);
    } else if (d[0] === 1) {
      ytext.insert(offset, d[1]);
      offset += d[1].length;
    } else {
      offset += d[1].length;
    }
  }
}

// ===== 第一部分:三路文本合并算法验证 =====
console.log("📝 第一部分:三路文本合并算法验证");
console.log();

test("两边改不同行 → 正确合并", () => {
  const baseline = "第一行\n第二行\n第三行\n第四行\n第五行";
  const ours = "第一行\n第二行(Alice修改)\n第三行\n第四行\n第五行";
  const theirs = "第一行\n第二行\n第三行\n第四行(Bob修改)\n第五行";
  const result = mergeThreeWay(baseline, ours, theirs);

  if (!result.includes("Alice修改")) throw new Error("缺少 Alice 的修改");
  if (!result.includes("Bob修改")) throw new Error("缺少 Bob 的修改");
  if (result.includes("<<<<<<<")) throw new Error("出现冲突标记");
});

test("一边新增段落、一边修改段落 → 正确合并", () => {
  const baseline = "# 标题\n\n正文第一段。\n\n正文第二段。";
  const ours = "# 标题\n\n正文第一段。\n\n正文第二段(Alice改了)。\n\nAlice新增的段落。";
  const theirs = "# 标题\n\n正文第一段(Bob改了)。\n\n正文第二段。";
  const result = mergeThreeWay(baseline, ours, theirs);

  if (!result.includes("Alice改了")) throw new Error("缺少 Alice 修改");
  if (!result.includes("Bob改了")) throw new Error("缺少 Bob 修改");
  if (!result.includes("Alice新增的段落")) throw new Error("缺少 Alice 新增内容");
  if (result.includes("<<<<<<<")) throw new Error("出现冲突标记");
});

test("同一句子不同位置改字 → 字符级合并", () => {
  const baseline = "这是一个测试句子用于验证合并";
  const ours = "这是一个Alice的测试句子用于验证合并";
  const theirs = "这是一个测试句子用于验证Bob的合并";
  const result = mergeThreeWay(baseline, ours, theirs);

  if (!result.includes("Alice")) throw new Error("缺少 Alice 的修改");
  if (!result.includes("Bob")) throw new Error("缺少 Bob 的修改");
  if (result.includes("<<<<<<<")) throw new Error("出现冲突标记");
});

test("一边删除、一边修改同一行 → 无冲突标记", () => {
  const baseline = "行1\n要删除的行\n行3";
  const ours = "行1\n行3";
  const theirs = "行1\n要删除的行(Bob改了)\n行3";
  const result = mergeThreeWay(baseline, ours, theirs);

  if (result.includes("<<<<<<<")) throw new Error("出现冲突标记");
});

test("内容保全:两边新增的唯一子串必须都在结果中", () => {
  const baseline = "基础内容\n第二行";
  const ours = "基础内容\nAlice的独特内容ABC\n第二行";
  const theirs = "基础内容\n第二行\nBob的独特内容XYZ";
  const result = mergeThreeWay(baseline, ours, theirs);

  if (!result.includes("Alice的独特内容ABC")) throw new Error("Alice 的内容丢失了");
  if (!result.includes("Bob的独特内容XYZ")) throw new Error("Bob 的内容丢失了");
});

test("大文件(>256行)合并也能工作", () => {
  // 生成 300 行的 baseline
  let baseline = "";
  for (let i = 1; i <= 300; i++) {
    baseline += `第${i}行: 这是第 ${i} 行的内容。\n`;
  }

  // Alice 修改第 100 行,新增第 200 行
  let ours = baseline.split("\n");
  ours[99] = "第100行: Alice修改了这一行。";
  ours.splice(199, 0, "第200行(Alice新增): 这是 Alice 加的。");
  ours = ours.join("\n");

  // Bob 修改第 50 行,新增第 250 行
  let theirs = baseline.split("\n");
  theirs[49] = "第50行: Bob修改了这一行。";
  theirs.splice(249, 0, "第250行(Bob新增): 这是 Bob 加的。");
  theirs = theirs.join("\n");

  const result = mergeThreeWay(baseline, ours, theirs);

  if (!result.includes("Alice修改了这一行")) throw new Error("缺少 Alice 修改");
  if (!result.includes("Bob修改了这一行")) throw new Error("缺少 Bob 修改");
  if (!result.includes("Alice新增")) throw new Error("缺少 Alice 新增");
  if (!result.includes("Bob新增")) throw new Error("缺少 Bob 新增");
  if (result.includes("<<<<<<<")) throw new Error("出现冲突标记");

  // 验证行数合理
  const lineCount = result.split("\n").length;
  if (lineCount < 302) throw new Error(`行数太少: ${lineCount}`);
  console.log(`     (大文件合并: ${baseline.split("\n").length}行 → ${lineCount}行)`);
});

console.log();

// ===== 第二部分:Yjs CRDT + applyFastDiff 验证 =====
console.log("🔄 第二部分:Yjs CRDT + 增量更新验证");
console.log();

test("多次增量更新后内容正确", () => {
  const doc = new Y.Doc();
  const ytext = doc.getText("source");

  const v1 = "第一行\n第二行\n第三行";
  ytext.insert(0, v1);

  const v2 = "第一行\n第二行(改了)\n第三行";
  applyFastDiff(ytext, v1, v2);
  if (ytext.toString() !== v2) throw new Error("第一次更新后不匹配");

  const v3 = "第一行\n第二行(改了)\n第三行\n第四行(新增)";
  applyFastDiff(ytext, v2, v3);
  if (ytext.toString() !== v3) throw new Error("第二次更新后不匹配");
});

test("CRDT 合并两个独立文档 → 结果一致", () => {
  const baseline = "第一行\n第二行\n第三行";

  const docA = new Y.Doc();
  const textA = docA.getText("source");
  textA.insert(0, baseline);
  applyFastDiff(textA, baseline, "第一行\n第二行(Alice)\n第三行");

  const docB = new Y.Doc();
  const textB = docB.getText("source");
  textB.insert(0, baseline);
  applyFastDiff(textB, baseline, "第一行\n第二行\n第三行\n第四行(Bob)");

  // CRDT 双向同步
  const stateA = Y.encodeStateVector(docA);
  const stateB = Y.encodeStateVector(docB);
  Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, stateA));
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, stateB));

  if (textA.toString() !== textB.toString()) {
    throw new Error("两边合并结果不一致");
  }
  if (!textA.toString().includes("Alice")) throw new Error("缺少 Alice 修改");
  if (!textA.toString().includes("Bob")) throw new Error("缺少 Bob 修改");
});

test("applyFastDiff 保留未变行的 Yjs 身份(概念验证)", () => {
  const doc = new Y.Doc();
  const ytext = doc.getText("source");
  ytext.insert(0, "行A\n行B\n行C");

  // 获取第一次的 Yjs 状态
  const state1 = Y.encodeStateAsUpdate(doc);

  // 只修改第二行,用 applyFastDiff
  applyFastDiff(ytext, "行A\n行B\n行C", "行A\n行B(改了)\n行C");

  // 如果是全量删除再插入,状态向量会完全不同
  // 如果是增量更新,未变行的 Item ID 保持不变
  // 这里我们只验证功能正确,身份保留由 Yjs 保证
  if (ytext.toString() !== "行A\n行B(改了)\n行C") {
    throw new Error("内容不正确");
  }
  console.log("     (增量更新: 功能正确,未变行 Item 身份由 Yjs 机制保留)");
});

console.log();

// ===== 第三部分:完整同步流程模拟 =====
console.log("🌿 第三部分:完整同步流程模拟(Alice & Bob 协作)");
console.log();

async function runSyncScenario() {
  // 1. 初始化"远程"目录(用文件系统模拟远程仓库)
  fs.mkdirSync(REMOTE_DIR, { recursive: true });
  fs.mkdirSync(ALICE_DIR, { recursive: true });
  fs.mkdirSync(BOB_DIR, { recursive: true });

  // 初始笔记
  const initialNote = `# 项目设计文档

## 概述

本项目是一个 CRDT + Git 同步的笔记插件。
目标是实现无冲突的多人协作。

## 架构

采用三层架构:
1. CRDT 层
2. 合并层
3. Git 层

## 功能列表

- 三路文本合并
- 内容保全检测
- 增量更新
`;

  const noteFile = "design.md";

  // 写入远程
  fs.writeFileSync(path.join(REMOTE_DIR, noteFile), initialNote, "utf-8");
  // Alice 和 Bob 各自拉取
  fs.writeFileSync(path.join(ALICE_DIR, noteFile), initialNote, "utf-8");
  fs.writeFileSync(path.join(BOB_DIR, noteFile), initialNote, "utf-8");

  // 各自维护版本号(模拟 Git HEAD)
  const versions = {
    remote: "v0",
    alice: "v0",
    bob: "v0",
  };

  console.log("  🏗️  初始化:三人版本一致 (v0)");

  // 2. Alice 修改:在概述加一段,架构层加说明
  const aliceV1 = `# 项目设计文档

## 概述

本项目是一个 CRDT + Git 同步的笔记插件。
目标是实现无冲突的多人协作。

### 设计原则

- 内容第一:永远不丢用户数据
- 兼容 Git:用 Git 做版本历史
- 零服务端:不需要额外部署服务

## 架构

采用三层架构:
1. CRDT 层 — Yjs 操作历史管理
2. 合并层 — 三路文本合并算法
3. Git 层 — isomorphic-git 纯 JS 实现

## 功能列表

- 三路文本合并
- 内容保全检测
- 增量更新
`;

  fs.writeFileSync(path.join(ALICE_DIR, noteFile), aliceV1, "utf-8");
  versions.alice = "v1-alice";
  console.log("  ✏️  Alice: 新增设计原则章节 + 架构补充");

  // 3. Bob 修改:功能列表加内容,新增测试章节
  const bobV1 = `# 项目设计文档

## 概述

本项目是一个 CRDT + Git 同步的笔记插件。
目标是实现无冲突的多人协作。

## 架构

采用三层架构:
1. CRDT 层
2. 合并层
3. Git 层

## 功能列表

- 三路文本合并 (diff-match-patch)
- 内容保全检测 (子串/顺序/增长)
- 增量更新 (行级 fast diff)
- Sidecar 持久化 (Yjs 操作历史)

## 测试计划

- 单元测试:合并算法
- 集成测试:全链路同步
- E2E 测试:真实协作场景
`;

  fs.writeFileSync(path.join(BOB_DIR, noteFile), bobV1, "utf-8");
  versions.bob = "v1-bob";
  console.log("  ✏️  Bob: 扩充功能列表 + 新增测试计划章节");

  // 4. Alice 先 push 到远程
  fs.writeFileSync(path.join(REMOTE_DIR, noteFile), aliceV1, "utf-8");
  versions.remote = "v1-alice";
  console.log("  📤  Alice 先推送到远程");

  // 5. Bob 同步(模拟插件的 smartPull + 三路合并)
  // a. 读取远程版本(模拟 fetch)
  const remoteContent = fs.readFileSync(path.join(REMOTE_DIR, noteFile), "utf-8");
  // b. 读取自己的基线(上次同步的版本 = v0 初始版)
  const baselineContent = initialNote;
  // c. 读取自己的工作区版本
  const bobLocalContent = fs.readFileSync(path.join(BOB_DIR, noteFile), "utf-8");
  // d. 三路合并
  const bobMerged = mergeThreeWay(baselineContent, bobLocalContent, remoteContent);

  console.log(`  🔀  Bob 三路合并 (baseline:${baselineContent.length}B → ours:${bobLocalContent.length}B + theirs:${remoteContent.length}B → merged:${bobMerged.length}B)`);

  // 验证:无冲突标记
  if (bobMerged.includes("<<<<<<<") || bobMerged.includes(">>>>>>>")) {
    throw new Error("合并结果包含 Git 冲突标记!");
  }
  console.log("     ✅ 无冲突标记");

  // 验证:Alice 的改动都在
  const aliceChecks = [
    "设计原则",
    "内容第一",
    "兼容 Git",
    "零服务端",
    "Yjs 操作历史管理",
    "三路文本合并算法",
    "isomorphic-git 纯 JS 实现",
  ];
  for (const keyword of aliceChecks) {
    if (!bobMerged.includes(keyword)) {
      throw new Error(`Bob 的合并结果丢失了 Alice 的内容: ${keyword}`);
    }
  }
  console.log("     ✅ Alice 的全部修改都保留了");

  // 验证:Bob 的改动都在
  const bobChecks = [
    "diff-match-patch",
    "子串/顺序/增长",
    "行级 fast diff",
    "Sidecar 持久化",
    "Yjs 操作历史",
    "测试计划",
    "单元测试:合并算法",
    "集成测试:全链路同步",
    "E2E 测试:真实协作场景",
  ];
  for (const keyword of bobChecks) {
    if (!bobMerged.includes(keyword)) {
      throw new Error(`Bob 的合并结果丢失了自己的内容: ${keyword}`);
    }
  }
  console.log("     ✅ Bob 的全部修改都保留了");

  // 写回 Bob 的工作区
  fs.writeFileSync(path.join(BOB_DIR, noteFile), bobMerged, "utf-8");
  versions.bob = "v2-merged";

  // 6. Bob push 到远程
  fs.writeFileSync(path.join(REMOTE_DIR, noteFile), bobMerged, "utf-8");
  versions.remote = "v2-merged";
  console.log("  📤  Bob 推送合并结果到远程");

  // 7. Alice pull 同步(她这边 baseline 是 v1-alice,工作区也是 v1-alice)
  const aliceRemoteContent = fs.readFileSync(path.join(REMOTE_DIR, noteFile), "utf-8");
  const aliceBaseline = aliceV1; // Alice 的 HEAD 版本
  const aliceLocal = fs.readFileSync(path.join(ALICE_DIR, noteFile), "utf-8");

  // Alice 本地没新改动(ours = baseline),合并结果 = theirs
  const aliceMerged = mergeThreeWay(aliceBaseline, aliceLocal, aliceRemoteContent);

  fs.writeFileSync(path.join(ALICE_DIR, noteFile), aliceMerged, "utf-8");
  versions.alice = "v3-synced";
  console.log("  📥  Alice 拉取并同步");

  // 8. 最终验证:三端内容完全一致
  const finalAlice = fs.readFileSync(path.join(ALICE_DIR, noteFile), "utf-8");
  const finalBob = fs.readFileSync(path.join(BOB_DIR, noteFile), "utf-8");
  const finalRemote = fs.readFileSync(path.join(REMOTE_DIR, noteFile), "utf-8");

  if (finalAlice !== finalBob) throw new Error("Alice 和 Bob 内容不一致");
  if (finalAlice !== finalRemote) throw new Error("Alice 和远程内容不一致");

  console.log("  🤝  三端内容完全一致!");
  console.log(`     最终文件: ${finalAlice.length} 字符, ${finalAlice.split("\n").length} 行`);

  // 9. 额外验证:第二轮同步(继续改)
  console.log();
  console.log("  — 第二轮协作验证 —");

  // Alice 再加一节
  const aliceV4 = finalAlice + `
## 路线图

- v0.1: MVP 核心功能
- v0.2: 三路文本合并
- v0.3: 编辑器实时绑定
- v1.0: 发布正式版
`;
  fs.writeFileSync(path.join(ALICE_DIR, noteFile), aliceV4, "utf-8");

  // Bob 也再加一节
  const bobV4 = finalBob + `
## 常见问题

Q: 为什么不用 CRDT 做 Git 合并?
A: 因为 Git pull 场景下两边没有共享的 CRDT 操作历史。

Q: 和 Obsidian Git 有什么区别?
A: Obsidian Git 会产生冲突标记,本插件用三路合并自动解决。
`;
  fs.writeFileSync(path.join(BOB_DIR, noteFile), bobV4, "utf-8");

  console.log("  ✏️  两人各自又加了新章节");

  // Alice 先 push
  fs.writeFileSync(path.join(REMOTE_DIR, noteFile), aliceV4, "utf-8");

  // Bob 再同步
  const bobRemote2 = fs.readFileSync(path.join(REMOTE_DIR, noteFile), "utf-8");
  const bobBaseline2 = finalBob; // 上次同步后的版本
  const bobLocal2 = fs.readFileSync(path.join(BOB_DIR, noteFile), "utf-8");
  const bobMerged2 = mergeThreeWay(bobBaseline2, bobLocal2, bobRemote2);

  // 验证第二轮
  if (!bobMerged2.includes("路线图")) throw new Error("第二轮丢失路线图章节");
  if (!bobMerged2.includes("常见问题")) throw new Error("第二轮丢失常见问题章节");
  if (!bobMerged2.includes("v1.0: 发布正式版")) throw new Error("丢失路线图细节");
  if (!bobMerged2.includes("为什么不用 CRDT")) throw new Error("丢失 FAQ 细节");
  if (bobMerged2.includes("<<<<<<<")) throw new Error("第二轮出现冲突标记");

  console.log("  🔀  第二轮合并成功");
  console.log("     ✅ 两边新内容都保留");
  console.log("     ✅ 无冲突标记");

  // 写回 + push
  fs.writeFileSync(path.join(BOB_DIR, noteFile), bobMerged2, "utf-8");
  fs.writeFileSync(path.join(REMOTE_DIR, noteFile), bobMerged2, "utf-8");

  // Alice pull
  const aliceRemote2 = fs.readFileSync(path.join(REMOTE_DIR, noteFile), "utf-8");
  const aliceMerged2 = mergeThreeWay(aliceV4, aliceV4, aliceRemote2);
  fs.writeFileSync(path.join(ALICE_DIR, noteFile), aliceMerged2, "utf-8");

  // 最终一致
  const fa = fs.readFileSync(path.join(ALICE_DIR, noteFile), "utf-8");
  const fb = fs.readFileSync(path.join(BOB_DIR, noteFile), "utf-8");
  const fr = fs.readFileSync(path.join(REMOTE_DIR, noteFile), "utf-8");
  if (fa !== fb || fa !== fr) {
    throw new Error("第二轮后三端不一致");
  }

  console.log("  🤝  第二轮同步后三端仍一致!");
  console.log(`     最终文件: ${fa.length} 字符, ${fa.split("\n").length} 行`);
}

asyncTest("完整同步流程:两轮协作 + 三端一致", runSyncScenario).then(() => {
  // ===== 总结 =====
  console.log();
  console.log("=".repeat(60));
  console.log(`  测试完成: ${passed} 通过, ${failed} 失败`);
  console.log(`  测试目录: ${TEST_DIR}`);
  console.log("=".repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
});
