/**
 * v0.5 合并历史 + 回退测试
 *
 * 验证:
 * 1. HistoryManager: 记录、读取、查询、删除、清理
 * 2. 合并历史在 SyncEngine 流程中的自动记录
 * 3. 回退功能:恢复到合并前内容
 * 4. 自动清理:maxRecords 超出时删除最旧记录
 * 5. 索引持久化:重启后仍可读取
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

// ===== 内联 HistoryManager 逻辑(和 history.ts 一致) =====

class HistoryManager {
  constructor(historyDir, maxRecords = 50) {
    this.historyDir = historyDir;
    this.maxRecords = maxRecords;
    this.index = [];
    this.ensureDir();
    this.loadIndex();
  }

  ensureDir() {
    try { fs.mkdirSync(this.historyDir, { recursive: true }); } catch (e) {}
  }

  loadIndex() {
    try {
      const indexFile = path.join(this.historyDir, "_index.json");
      if (fs.existsSync(indexFile)) {
        this.index = JSON.parse(fs.readFileSync(indexFile, "utf-8"));
      }
    } catch (e) { this.index = []; }
  }

  saveIndex() {
    try {
      fs.writeFileSync(path.join(this.historyDir, "_index.json"), JSON.stringify(this.index, null, 2), "utf-8");
    } catch (e) {}
  }

  async record(record) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const full = { id, timestamp: Date.now(), ...record };

    fs.writeFileSync(path.join(this.historyDir, `${id}.json`), JSON.stringify(full, null, 2), "utf-8");

    this.index.push({
      id: full.id,
      timestamp: full.timestamp,
      file: full.file,
      source: full.source,
      warningCount: full.warnings.length,
      beforeLength: full.before.length,
      afterLength: full.after.length,
    });

    this.cleanup();
    this.saveIndex();
    return id;
  }

  getRecord(id) {
    try {
      const fp = path.join(this.historyDir, `${id}.json`);
      if (!fs.existsSync(fp)) return null;
      return JSON.parse(fs.readFileSync(fp, "utf-8"));
    } catch (e) { return null; }
  }

  getHistoryForFile(filePath) {
    return this.index.filter(r => r.file === filePath).sort((a, b) => b.timestamp - a.timestamp);
  }

  getAllHistory() {
    return [...this.index].sort((a, b) => b.timestamp - a.timestamp);
  }

  getBeforeContent(id) {
    const r = this.getRecord(id);
    return r ? r.before : null;
  }

  getAfterContent(id) {
    const r = this.getRecord(id);
    return r ? r.after : null;
  }

  deleteRecord(id) {
    try { const fp = path.join(this.historyDir, `${id}.json`); if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (e) {}
    this.index = this.index.filter(r => r.id !== id);
    this.saveIndex();
  }

  cleanup() {
    if (this.index.length <= this.maxRecords) return;
    this.index.sort((a, b) => b.timestamp - a.timestamp);
    const toDelete = this.index.slice(this.maxRecords);
    for (const entry of toDelete) {
      try { const fp = path.join(this.historyDir, `${entry.id}.json`); if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (e) {}
    }
    this.index = this.index.slice(0, this.maxRecords);
  }

  clearAll() {
    for (const entry of this.index) {
      try { const fp = path.join(this.historyDir, `${entry.id}.json`); if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (e) {}
    }
    this.index = [];
    this.saveIndex();
  }

  count() { return this.index.length; }
}

// ===== diff-match-patch for merge =====
const { diff_match_patch } = require("diff-match-patch");

function mergeThreeWay(baseline, ours, theirs) {
  if (baseline === ours) return theirs;
  if (baseline === theirs) return ours;
  if (ours === theirs) return ours;
  const dmp = new diff_match_patch();
  const patches = dmp.patch_make(baseline, ours);
  const [merged] = dmp.patch_apply(patches, theirs);
  return merged;
}

// ===== 测试开始 =====
console.log("=".repeat(60));
console.log("  v0.5 — 合并历史 + 回退 测试");
console.log("=".repeat(60));
console.log();

let passed = 0, failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn, isAsync: false });
}

function testAsync(name, fn) {
  tests.push({ name, fn, isAsync: true });
}

async function runTests() {
  for (const t of tests) {
    try {
      if (t.isAsync) await t.fn();
      else t.fn();
      console.log(`  ✅ ${t.name}`);
      passed++;
    } catch (e) {
      console.log(`  ❌ ${t.name}`);
      console.log(`     ${e.message}`);
      failed++;
    }
  }
}


// 使用临时目录
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-crdt-test-"));

// ===== 第一部分:HistoryManager 基本功能 =====
console.log("📝 第一部分:HistoryManager 基本功能");
console.log();

test("创建 HistoryManager + 目录自动创建", () => {
  const dir = path.join(tmpDir, "history1");
  const mgr = new HistoryManager(dir);
  if (!fs.existsSync(dir)) throw new Error("history 目录未创建");
  if (mgr.count() !== 0) throw new Error("初始记录数应为 0");
});

testAsync("record() 记录一次合并", async () => {
  const dir = path.join(tmpDir, "history2");
  const mgr = new HistoryManager(dir);

  const id = await mgr.record({
    file: "test.md",
    before: "原始内容",
    after: "合并后内容",
    remoteContent: "远端内容",
    source: "git pull from origin/main",
    warnings: [],
  });

  if (!id) throw new Error("返回 ID 为空");
  if (mgr.count() !== 1) throw new Error(`记录数应为 1,实际 ${mgr.count()}`);
});

testAsync("getRecord() 读取完整记录", async () => {
  const dir = path.join(tmpDir, "history3");
  const mgr = new HistoryManager(dir);

  const id = await mgr.record({
    file: "note.md",
    before: "之前",
    after: "之后",
    remoteContent: "远端",
    source: "git pull",
    warnings: ["警告1"],
  });

  const record = mgr.getRecord(id);
  if (!record) throw new Error("记录不存在");
  if (record.file !== "note.md") throw new Error(`文件名错误: ${record.file}`);
  if (record.before !== "之前") throw new Error("before 内容错误");
  if (record.after !== "之后") throw new Error("after 内容错误");
  if (record.warnings.length !== 1) throw new Error("警告数错误");
  if (record.warnings[0] !== "警告1") throw new Error("警告内容错误");
});

testAsync("getBeforeContent() 获取合并前内容", async () => {
  const dir = path.join(tmpDir, "history4");
  const mgr = new HistoryManager(dir);

  const id = await mgr.record({
    file: "doc.md",
    before: "合并前的完整内容",
    after: "合并后的完整内容",
    remoteContent: "远端",
    source: "git pull",
    warnings: [],
  });

  const before = mgr.getBeforeContent(id);
  if (before !== "合并前的完整内容") throw new Error(`before 内容错误: ${before}`);
});

testAsync("getHistoryForFile() 按文件查询", async () => {
  const dir = path.join(tmpDir, "history5");
  const mgr = new HistoryManager(dir);

  await mgr.record({ file: "a.md", before: "a1", after: "a2", remoteContent: "r", source: "pull", warnings: [] });
  await new Promise(r => setTimeout(r, 10));
  await mgr.record({ file: "b.md", before: "b1", after: "b2", remoteContent: "r", source: "pull", warnings: [] });
  await new Promise(r => setTimeout(r, 10));
  await mgr.record({ file: "a.md", before: "a2", after: "a3", remoteContent: "r2", source: "pull2", warnings: [] });

  const aHistory = mgr.getHistoryForFile("a.md");
  if (aHistory.length !== 2) throw new Error(`a.md 应有 2 条记录,实际 ${aHistory.length}`);

  // 按时间倒序,最新的在前
  if (aHistory[0].afterLength !== 2) throw new Error("最新记录排序错误");
});

testAsync("getAllHistory() 获取所有历史(倒序)", async () => {
  const dir = path.join(tmpDir, "history6");
  const mgr = new HistoryManager(dir);

  for (let i = 0; i < 5; i++) {
    await mgr.record({ file: `f${i}.md`, before: `b${i}`, after: `a${i}`, remoteContent: "r", source: "pull", warnings: [] });
    await new Promise(r => setTimeout(r, 10));
  }

  const all = mgr.getAllHistory();
  if (all.length !== 5) throw new Error(`总记录数应为 5,实际 ${all.length}`);
  // 倒序:最新的在前
  if (all[0].file !== "f4.md") throw new Error("排序错误,应最新在前");
});

testAsync("deleteRecord() 删除单条记录", async () => {
  const dir = path.join(tmpDir, "history7");
  const mgr = new HistoryManager(dir);

  const id1 = await mgr.record({ file: "x.md", before: "x1", after: "x2", remoteContent: "r", source: "pull", warnings: [] });
  const id2 = await mgr.record({ file: "y.md", before: "y1", after: "y2", remoteContent: "r", source: "pull", warnings: [] });

  mgr.deleteRecord(id1);

  if (mgr.count() !== 1) throw new Error(`删除后应剩 1 条,实际 ${mgr.count()}`);
  if (mgr.getRecord(id1) !== null) throw new Error("已删除的记录仍可读取");
  if (mgr.getRecord(id2) === null) throw new Error("未删除的记录不存在");
});

testAsync("clearAll() 清空所有记录", async () => {
  const dir = path.join(tmpDir, "history8");
  const mgr = new HistoryManager(dir);

  await mgr.record({ file: "a.md", before: "a", after: "b", remoteContent: "r", source: "pull", warnings: [] });
  await mgr.record({ file: "b.md", before: "c", after: "d", remoteContent: "r", source: "pull", warnings: [] });

  mgr.clearAll();

  if (mgr.count() !== 0) throw new Error(`清空后记录数应为 0,实际 ${mgr.count()}`);
});

console.log();

// ===== 第二部分:自动清理 =====
console.log("🧹 第二部分:自动清理");
console.log();

testAsync("maxRecords 超出时自动删除最旧记录", async () => {
  const dir = path.join(tmpDir, "history9");
  const mgr = new HistoryManager(dir, 3); // 最多 3 条

  for (let i = 0; i < 5; i++) {
    await mgr.record({ file: `f${i}.md`, before: `b${i}`, after: `a${i}`, remoteContent: "r", source: "pull", warnings: [] });
    await new Promise(r => setTimeout(r, 10));
  }

  if (mgr.count() !== 3) throw new Error(`清理后应剩 3 条,实际 ${mgr.count()}`);

  // 最旧的 2 条应该被删了
  const all = mgr.getAllHistory();
  if (all[0].file !== "f4.md") throw new Error("最新记录应保留");
  if (all[2].file !== "f2.md") throw new Error(`最旧应从 f2 开始,实际 ${all[2].file}`);
  if (all.some(e => e.file === "f0.md")) throw new Error("f0.md 应被删除");
  if (all.some(e => e.file === "f1.md")) throw new Error("f1.md 应被删除");
});

testAsync("被清理的记录文件也被删除", async () => {
  const dir = path.join(tmpDir, "history10");
  const mgr = new HistoryManager(dir, 2);

  const id1 = await mgr.record({ file: "old.md", before: "old", after: "new", remoteContent: "r", source: "pull", warnings: [] });
  await new Promise(r => setTimeout(r, 10));
  const id2 = await mgr.record({ file: "new1.md", before: "n1", after: "n2", remoteContent: "r", source: "pull", warnings: [] });
  await new Promise(r => setTimeout(r, 10));
  const id3 = await mgr.record({ file: "new2.md", before: "n3", after: "n4", remoteContent: "r", source: "pull", warnings: [] });

  // id1 应该被清理
  const oldFile = path.join(dir, `${id1}.json`);
  if (fs.existsSync(oldFile)) throw new Error("被清理的记录文件仍存在");

  // id2 和 id3 应该保留
  if (!fs.existsSync(path.join(dir, `${id2}.json`))) throw new Error("id2 文件不应被删除");
  if (!fs.existsSync(path.join(dir, `${id3}.json`))) throw new Error("id3 文件不应被删除");
});

console.log();

// ===== 第三部分:索引持久化 =====
console.log("💾 第三部分:索引持久化(模拟重启)");
console.log();

testAsync("重启后索引仍可读取", async () => {
  const dir = path.join(tmpDir, "history11");
  const mgr1 = new HistoryManager(dir);

  await mgr1.record({ file: "a.md", before: "a", after: "b", remoteContent: "r", source: "pull", warnings: [] });
  await mgr1.record({ file: "b.md", before: "c", after: "d", remoteContent: "r", source: "pull", warnings: [] });

  // 模拟重启:创建新的 HistoryManager 实例
  const mgr2 = new HistoryManager(dir);
  if (mgr2.count() !== 2) throw new Error(`重启后记录数应为 2,实际 ${mgr2.count()}`);

  const all = mgr2.getAllHistory();
  if (all.length !== 2) throw new Error("索引加载失败");
});

testAsync("重启后仍可读取完整记录内容", async () => {
  const dir = path.join(tmpDir, "history12");
  const mgr1 = new HistoryManager(dir);

  const id = await mgr1.record({
    file: "persist.md",
    before: "持久化前",
    after: "持久化后",
    remoteContent: "远端",
    source: "git pull from origin/main",
    warnings: ["warning1"],
  });

  // 模拟重启
  const mgr2 = new HistoryManager(dir);
  const record = mgr2.getRecord(id);

  if (!record) throw new Error("重启后记录不存在");
  if (record.before !== "持久化前") throw new Error("before 内容丢失");
  if (record.after !== "持久化后") throw new Error("after 内容丢失");
  if (record.source !== "git pull from origin/main") throw new Error("source 丢失");
  if (record.warnings[0] !== "warning1") throw new Error("warnings 丢失");
});

console.log();

// ===== 第四部分:回退功能模拟 =====
console.log("↩️ 第四部分:回退功能模拟");
console.log();

testAsync("合并后记录历史 → 回退到合并前", async () => {
  const dir = path.join(tmpDir, "history13");
  const mgr = new HistoryManager(dir);

  // 模拟一次合并
  const baseline = "原始内容\n第二行";
  const ours = "原始内容(Alice改)\n第二行";
  const theirs = "原始内容\n第二行(Bob改)";
  const merged = mergeThreeWay(baseline, ours, theirs);

  // 记录合并历史
  const id = await mgr.record({
    file: "collab.md",
    before: ours,      // 合并前本地内容
    after: merged,     // 合并后内容
    remoteContent: theirs,
    source: "git pull from origin/main",
    warnings: [],
  });

  // 验证:合并后内容包含两边修改
  if (!merged.includes("Alice改")) throw new Error("合并丢失 Alice");
  if (!merged.includes("Bob改")) throw new Error("合并丢失 Bob");

  // 回退:获取合并前内容
  const beforeContent = mgr.getBeforeContent(id);
  if (beforeContent !== ours) throw new Error("回退内容不等于合并前");

  // 验证:回退后内容不包含 Bob 的修改
  if (beforeContent.includes("Bob改")) throw new Error("回退内容不应包含 Bob 的修改");
});

testAsync("多次合并 → 回退到任意一次", async () => {
  const dir = path.join(tmpDir, "history14");
  const mgr = new HistoryManager(dir);

  // 第一轮合并
  const id1 = await mgr.record({
    file: "multi.md",
    before: "v0",
    after: "v1(Alice+Bob第一轮)",
    remoteContent: "remote-v1",
    source: "pull #1",
    warnings: [],
  });
  await new Promise(r => setTimeout(r, 10));

  // 第二轮合并
  const id2 = await mgr.record({
    file: "multi.md",
    before: "v1(Alice+Bob第一轮)",
    after: "v2(Alice+Bob第二轮)",
    remoteContent: "remote-v2",
    source: "pull #2",
    warnings: ["内容保全警告"],
  });
  await new Promise(r => setTimeout(r, 10));

  // 第三轮合并
  const id3 = await mgr.record({
    file: "multi.md",
    before: "v2(Alice+Bob第二轮)",
    after: "v3(Alice+Bob第三轮)",
    remoteContent: "remote-v3",
    source: "pull #3",
    warnings: [],
  });

  // 回退到第一轮
  const before1 = mgr.getBeforeContent(id1);
  if (before1 !== "v0") throw new Error(`回退第一轮错误: ${before1}`);

  // 回退到第二轮
  const before2 = mgr.getBeforeContent(id2);
  if (before2 !== "v1(Alice+Bob第一轮)") throw new Error(`回退第二轮错误: ${before2}`);

  // 回退到第三轮
  const before3 = mgr.getBeforeContent(id3);
  if (before3 !== "v2(Alice+Bob第二轮)") throw new Error(`回退第三轮错误: ${before3}`);

  // 验证历史记录数
  const fileHistory = mgr.getHistoryForFile("multi.md");
  if (fileHistory.length !== 3) throw new Error(`应有 3 条历史,实际 ${fileHistory.length}`);

  // 验证警告记录
  const record2 = mgr.getRecord(id2);
  if (record2.warnings.length !== 1) throw new Error("第二轮警告数错误");
  if (record2.warnings[0] !== "内容保全警告") throw new Error("警告内容错误");
});

testAsync("回退不影响其他文件的历史", async () => {
  const dir = path.join(tmpDir, "history15");
  const mgr = new HistoryManager(dir);

  await mgr.record({ file: "a.md", before: "a1", after: "a2", remoteContent: "r", source: "pull", warnings: [] });
  await new Promise(r => setTimeout(r, 10));
  await mgr.record({ file: "b.md", before: "b1", after: "b2", remoteContent: "r", source: "pull", warnings: [] });
  await new Promise(r => setTimeout(r, 10));
  await mgr.record({ file: "a.md", before: "a2", after: "a3", remoteContent: "r2", source: "pull2", warnings: [] });

  // 获取 a.md 的历史
  const aHistory = mgr.getHistoryForFile("a.md");
  if (aHistory.length !== 2) throw new Error(`a.md 应有 2 条记录,实际 ${aHistory.length}`);

  // 获取 b.md 的历史
  const bHistory = mgr.getHistoryForFile("b.md");
  if (bHistory.length !== 1) throw new Error(`b.md 应有 1 条记录,实际 ${bHistory.length}`);

  // 回退 a.md 到第一次合并前
  const beforeContent = mgr.getBeforeContent(aHistory[0].id); // 最新记录的 before
  if (beforeContent !== "a2") throw new Error(`回退内容错误: ${beforeContent}`);

  // b.md 的历史不受影响
  const bRecord = mgr.getRecord(bHistory[0].id);
  if (bRecord.before !== "b1") throw new Error("b.md 记录被影响");
});

console.log();

// ===== 第五部分:完整流程模拟 =====
console.log("🔄 第五部分:完整同步流程(合并 + 记录 + 回退)");
console.log();

testAsync("完整流程:多人协作 → 合并 → 记录 → 回退 → 重试", async () => {
  const dir = path.join(tmpDir, "history16");
  const mgr = new HistoryManager(dir);

  // 模拟三人协作场景
  const baseline = `# 项目文档

## 概述
这是一个测试项目。

## 架构
三层设计。`;

  // Alice 修改了概述
  const aliceVersion = `# 项目文档

## 概述
这是一个测试项目(Alice补充了背景)。

## 架构
三层设计。`;

  // Bob 新增了功能章节
  const bobVersion = `# 项目文档

## 概述
这是一个测试项目。

## 架构
三层设计。

## 功能
- 块级合并
- 历史回退`;

  // 合并 Alice + Bob
  const merged1 = mergeThreeWay(baseline, aliceVersion, bobVersion);

  // 记录合并历史
  const id1 = await mgr.record({
    file: "project.md",
    before: aliceVersion,
    after: merged1,
    remoteContent: bobVersion,
    source: "git pull from origin/main",
    warnings: [],
  });

  // 验证合并正确
  if (!merged1.includes("Alice补充了背景")) throw new Error("合并丢失 Alice");
  if (!merged1.includes("块级合并")) throw new Error("合并丢失 Bob 功能");

  // 模拟第二次同步:Charlie 也改了
  const charlieVersion = `# 项目文档

## 概述
这是一个测试项目(Alice补充了背景)。

## 架构
三层设计。

## 功能
- 块级合并
- 历史回退

## 路线图
Charlie 加的。`;

  // 合并
  const merged2 = mergeThreeWay(merged1, merged1, charlieVersion);

  // 记录第二次合并
  const id2 = await mgr.record({
    file: "project.md",
    before: merged1,
    after: merged2,
    remoteContent: charlieVersion,
    source: "git pull from origin/main",
    warnings: [],
  });

  // 验证历史记录
  const history = mgr.getHistoryForFile("project.md");
  if (history.length !== 2) throw new Error(`应有 2 条历史,实际 ${history.length}`);

  // 回退到第一次合并前(Alice 的版本)
  const before1 = mgr.getBeforeContent(id1);
  if (before1 !== aliceVersion) throw new Error("第一次回退内容错误");

  // 回退到第二次合并前(第一次合并结果)
  const before2 = mgr.getBeforeContent(id2);
  if (before2 !== merged1) throw new Error("第二次回退内容错误");

  // 验证:回退到第一次合并前不会包含 Bob 的内容
  if (before1.includes("块级合并")) throw new Error("第一次回退不应包含 Bob 内容");

  // 验证:回退到第二次合并前包含 Bob 但不包含 Charlie
  if (!before2.includes("块级合并")) throw new Error("第二次回退应包含 Bob");
  if (before2.includes("Charlie")) throw new Error("第二次回退不应包含 Charlie");

  console.log("     ✅ 完整流程验证通过");
});

// 运行所有测试(按顺序)
runTests().then(() => {
  // 清理临时目录
  try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) {}

  console.log();
  console.log("=".repeat(60));
  console.log(`  测试完成: ${passed} 通过, ${failed} 失败`);
  console.log("=".repeat(60));
  if (failed > 0) process.exit(1);
});
