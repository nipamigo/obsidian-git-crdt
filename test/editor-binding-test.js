/**
 * v0.3 编辑器绑定单元测试
 *
 * 验证 CodeMirror 6 ↔ Y.Text 双向绑定:
 * 1. 编辑器输入 → Y.Text 更新(方向 A)
 * 2. Y.Text 外部变化 → 编辑器更新(方向 B)
 * 3. Origin 防环:本地输入不反射回编辑器
 * 4. 初始同步:绑定时 Y.Text 内容同步到编辑器
 * 5. 解绑后不再同步
 */

const { JSDOM } = require("jsdom");
const path = require("path");

// 设置 DOM 环境(必须在 import codemirror 之前)
const dom = new JSDOM("<!DOCTYPE html><html><body><div id='editor'></div></body></html>");
const win = dom.window;
global.window = win;
global.document = win.document;
global.navigator = win.navigator;
global.HTMLElement = win.HTMLElement;
global.Text = win.Text;

// CodeMirror 需要的浏览器 API polyfill
if (!win.MutationObserver) {
  win.MutationObserver = class {
    constructor() {}
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
  };
}
if (!win.ResizeObserver) {
  win.ResizeObserver = class {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
win.requestAnimationFrame = (cb) => setTimeout(cb, 0);
win.cancelAnimationFrame = (id) => clearTimeout(id);

// 全局也设一份(有些库直接读全局)
global.MutationObserver = win.MutationObserver;
global.ResizeObserver = win.ResizeObserver;
global.requestAnimationFrame = win.requestAnimationFrame;
global.cancelAnimationFrame = win.cancelAnimationFrame;

const { EditorView, keymap } = require("@codemirror/view");
const { EditorState } = require("@codemirror/state");
const Y = require("yjs");

// 从编译后的模块导入(因为测试是 Node.js CJS)
// 我们直接从源文件逻辑提取核心来测试
// 或者用 esbuild 构建一个测试版本
//
// 更简单的方案:直接内联核心绑定逻辑来测试
// 因为我们的 editor-binding.ts 是 ESM + TS,在 CJS 测试里直接引入麻烦

// 内联的核心转换函数(和 editor-binding.ts 中的逻辑一致)
// 用于验证算法正确性

/**
 * 将 Y.Text delta 转换为 CodeMirror changes(基于原始文档位置)
 * 这是方向 B 的核心算法
 */
function yDeltaToCmChanges(delta) {
  const changes = [];
  let cursor = 0; // 原始文档中的位置

  for (const op of delta) {
    if (typeof op.retain === "number") {
      cursor += op.retain;
    } else if (typeof op.insert === "string") {
      changes.push({ from: cursor, insert: op.insert });
      // insert 不移动 cursor(后续操作引用原始文档位置)
    } else if (typeof op.delete === "number") {
      changes.push({ from: cursor, to: cursor + op.delete });
      // delete 也不移动 cursor
    }
  }

  return changes;
}

// ===== 测试开始 =====
console.log("=".repeat(60));
console.log("  v0.3 — 编辑器绑定逻辑单元测试");
console.log("=".repeat(60));
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

// ===== 第一部分:Y.Text delta → CodeMirror changes 转换 =====
console.log("📝 第一部分:Y.Text delta → CodeMirror changes 转换");
console.log();

test("纯 insert delta → 正确的插入位置", () => {
  const delta = [{ retain: 5 }, { insert: "hello" }];
  const changes = yDeltaToCmChanges(delta);

  if (changes.length !== 1) throw new Error(`期望 1 个 change,实际 ${changes.length}`);
  if (changes[0].from !== 5) throw new Error(`from 位置错误: ${changes[0].from}`);
  if (changes[0].insert !== "hello") throw new Error(`insert 内容错误`);
  if (changes[0].to !== undefined) throw new Error("不应该有 to");
});

test("纯 delete delta → 正确的删除范围", () => {
  const delta = [{ retain: 3 }, { delete: 5 }];
  const changes = yDeltaToCmChanges(delta);

  if (changes.length !== 1) throw new Error(`期望 1 个 change`);
  if (changes[0].from !== 3) throw new Error(`from 错误: ${changes[0].from}`);
  if (changes[0].to !== 8) throw new Error(`to 错误: ${changes[0].to}`);
});

test("先插入后删除 → 位置基于原始文档", () => {
  // 原始文档: ABCDEFG (7 chars)
  // delta: 在位置 2 插入 "X",然后删除原始位置 3-4 的 2 个字符
  const delta = [
    { retain: 2 },
    { insert: "X" },
    { retain: 1 }, // 这 1 个是原始文档的第 3 个字符(位置 2)
    { delete: 2 }, // 删除原始位置 3-4 的 2 个字符
  ];
  const changes = yDeltaToCmChanges(delta);

  if (changes.length !== 2) throw new Error(`期望 2 个 change,实际 ${changes.length}`);

  // 第一个:在位置 2 插入
  if (changes[0].from !== 2 || changes[0].insert !== "X") {
    throw new Error(`第一个 change 错误: ${JSON.stringify(changes[0])}`);
  }

  // 第二个:从位置 3 删 2 个(原始文档的 3,4)
  if (changes[1].from !== 3 || changes[1].to !== 5) {
    throw new Error(`第二个 change 错误: ${JSON.stringify(changes[1])}`);
  }
});

test("先删除后插入 → 位置正确", () => {
  // 原始: ABCDEFG
  // 删除位置 2 的 2 个字符(CD),然后在位置 2 插入 "X"
  const delta = [
    { retain: 2 },
    { delete: 2 },
    { insert: "X" },
    { retain: 3 },
  ];
  const changes = yDeltaToCmChanges(delta);

  if (changes.length !== 2) throw new Error(`期望 2 个 change`);

  // 删除:位置 2-4
  if (changes[0].from !== 2 || changes[0].to !== 4) {
    throw new Error(`delete change 错误: ${JSON.stringify(changes[0])}`);
  }

  // 插入:位置 2
  if (changes[1].from !== 2 || changes[1].insert !== "X") {
    throw new Error(`insert change 错误: ${JSON.stringify(changes[1])}`);
  }
});

test("多段 retain + insert + delete", () => {
  const delta = [
    { retain: 10 },
    { insert: "NEW" },
    { retain: 5 },
    { delete: 3 },
    { retain: 20 },
    { insert: "TAIL" },
  ];
  const changes = yDeltaToCmChanges(delta);

  if (changes.length !== 3) throw new Error(`期望 3 个 change,实际 ${changes.length}`);
  if (changes[0].from !== 10 || changes[0].insert !== "NEW") throw new Error("change 0 错");
  if (changes[1].from !== 15 || changes[1].to !== 18) throw new Error("change 1 错");
  if (changes[2].from !== 35 || changes[2].insert !== "TAIL") throw new Error("change 2 错");
});

console.log();

// ===== 第二部分:Y.Text 事件验证(真实 Yjs 环境) =====
console.log("🔄 第二部分:Y.Text 事件与 origin 机制");
console.log();

test("Y.Text insert 操作产生正确的 delta", () => {
  const doc = new Y.Doc();
  const ytext = doc.getText("test");
  ytext.insert(0, "ABCDEFG");

  let capturedDelta = null;
  ytext.observe((event) => {
    capturedDelta = event.delta;
  });

  // 在位置 2 插入 "X"
  ytext.insert(2, "X");

  if (!capturedDelta) throw new Error("没有捕获到 delta");

  const changes = yDeltaToCmChanges(capturedDelta);
  if (changes.length !== 1) throw new Error(`期望 1 个 change`);
  if (changes[0].from !== 2) throw new Error(`from 错误: ${changes[0].from}`);
  if (changes[0].insert !== "X") throw new Error(`insert 错误`);
});

test("Y.Text delete 操作产生正确的 delta", () => {
  const doc = new Y.Doc();
  const ytext = doc.getText("test");
  ytext.insert(0, "ABCDEFG");

  let capturedDelta = null;
  ytext.observe((event) => {
    capturedDelta = event.delta;
  });

  // 删除位置 2 开始的 2 个字符
  ytext.delete(2, 2);

  if (!capturedDelta) throw new Error("没有捕获到 delta");

  const changes = yDeltaToCmChanges(capturedDelta);
  if (changes.length !== 1) throw new Error(`期望 1 个 change`);
  if (changes[0].from !== 2) throw new Error(`from 错误`);
  if (changes[0].to !== 4) throw new Error(`to 错误: ${changes[0].to}`);
});

test("Origin 机制:transact 中设置 origin,观察者能看到", () => {
  const doc = new Y.Doc();
  const ytext = doc.getText("test");
  ytext.insert(0, "hello");

  const ORIGIN_LOCAL = Symbol("local");
  const ORIGIN_REMOTE = Symbol("remote");

  let lastOrigin = null;
  ytext.observe((event, transaction) => {
    lastOrigin = transaction.origin;
  });

  // 本地操作
  doc.transact(() => {
    ytext.insert(5, " world");
  }, ORIGIN_LOCAL);

  if (lastOrigin !== ORIGIN_LOCAL) throw new Error("本地 origin 未正确传递");

  // 远程操作
  doc.transact(() => {
    ytext.insert(11, "!");
  }, ORIGIN_REMOTE);

  if (lastOrigin !== ORIGIN_REMOTE) throw new Error("远程 origin 未正确传递");
});

test("直接 insert/delete(无 transact)的 origin 为 null/undefined", () => {
  const doc = new Y.Doc();
  const ytext = doc.getText("test");
  ytext.insert(0, "hello");

  let lastOrigin = "not-set";
  ytext.observe((event, transaction) => {
    lastOrigin = transaction.origin;
  });

  ytext.insert(5, " world");

  // Yjs 中直接操作的 origin 可能是 null 或 undefined(取决于版本)
  if (lastOrigin !== null && lastOrigin !== undefined) {
    throw new Error(`期望 null/undefined origin,实际: ${lastOrigin}`);
  }
});

console.log();

// ===== 第三部分:CodeMirror 真实编辑器 + Y.Text 集成测试 =====
console.log("🖥️  第三部分:CodeMirror + Y.Text 集成测试");
console.log();

// 注意:Yjs observer 和 CodeMirror updateListener 都是同步触发的
// 所以所有测试都是同步的,不需要 setTimeout

const parent = document.getElementById("editor");

test("CodeMirror 编辑器能正常创建和编辑", () => {
  const state = EditorState.create({ doc: "初始内容" });
  const view = new EditorView({ state, parent });

  const content = view.state.doc.toString();
  if (content !== "初始内容") throw new Error(`编辑器内容错误: ${content}`);

  // 测试 dispatch 修改
  view.dispatch({ changes: { from: 2, insert: "XX" } });
  if (view.state.doc.toString() !== "初始XX内容") {
    throw new Error(`dispatch 后内容错误: ${view.state.doc.toString()}`);
  }

  view.destroy();
});

test("方向 A:编辑器输入 → Y.Text 更新(精确增量)", () => {
  const doc = new Y.Doc();
  const ytext = doc.getText("source");

  const ORIGIN_LOCAL = "local-input";
  let applyingToY = false;
  let applyingToEditor = false;

  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged && !applyingToEditor) {
      applyingToY = true;
      try {
        doc.transact(() => {
          const changeList = [];
          update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
            changeList.push({
              from: fromA,
              to: toA,
              insert: inserted.sliceString(0, inserted.length),
            });
          });
          // 倒序应用到 Y.Text
          for (let i = changeList.length - 1; i >= 0; i--) {
            const c = changeList[i];
            if (c.to > c.from) ytext.delete(c.from, c.to - c.from);
            if (c.insert.length > 0) ytext.insert(c.from, c.insert);
          }
        }, ORIGIN_LOCAL);
      } finally {
        applyingToY = false;
      }
    }
  });

  const state = EditorState.create({ doc: "", extensions: [updateListener] });
  const view = new EditorView({ state, parent });

  // 第一次输入
  view.dispatch({ changes: { from: 0, insert: "Hello" } });
  if (ytext.toString() !== "Hello") {
    throw new Error(`第一次输入后 Y.Text 错误: "${ytext.toString()}"`);
  }

  // 第二次输入(中间插入)
  view.dispatch({ changes: { from: 5, insert: " World" } });
  if (ytext.toString() !== "Hello World") {
    throw new Error(`第二次输入后 Y.Text 错误: "${ytext.toString()}"`);
  }

  // 删除
  view.dispatch({ changes: { from: 5, to: 11 } });
  if (ytext.toString() !== "Hello") {
    throw new Error(`删除后 Y.Text 错误: "${ytext.toString()}"`);
  }

  // 验证 origin 正确
  let capturedOrigin = null;
  ytext.observe((event, tr) => { capturedOrigin = tr.origin; });
  view.dispatch({ changes: { from: 5, insert: "!" } });
  if (capturedOrigin !== ORIGIN_LOCAL) {
    throw new Error(`origin 错误: 期望 ${ORIGIN_LOCAL}, 实际 ${capturedOrigin}`);
  }

  view.destroy();
});

test("方向 B:Y.Text 外部变化 → 编辑器更新(精确增量)", () => {
  const doc = new Y.Doc();
  const ytext = doc.getText("source");
  ytext.insert(0, "ABCDEFG");

  const ORIGIN_LOCAL = "local-input";
  let applyingToEditor = false;

  // Y.Text → 编辑器
  const yObserver = (event, tr) => {
    if (tr.origin === ORIGIN_LOCAL) return; // 跳过本地
    applyingToEditor = true;
    try {
      const changes = yDeltaToCmChanges(event.delta);
      if (changes.length > 0) {
        view.dispatch({ changes });
      }
    } finally {
      applyingToEditor = false;
    }
  };

  const state = EditorState.create({ doc: "ABCDEFG" });
  const view = new EditorView({ state, parent });

  ytext.observe(yObserver);

  // 远程插入
  doc.transact(() => {
    ytext.insert(3, "XXX");
  }, "remote");

  if (view.state.doc.toString() !== "ABCXXXDEFG") {
    throw new Error(`远程插入后编辑器错误: "${view.state.doc.toString()}"`);
  }

  // 远程删除
  doc.transact(() => {
    ytext.delete(0, 3);
  }, "remote2");

  if (view.state.doc.toString() !== "XXXDEFG") {
    throw new Error(`远程删除后编辑器错误: "${view.state.doc.toString()}"`);
  }

  // 远程替换(删 + 插)
  doc.transact(() => {
    ytext.delete(0, 3);
    ytext.insert(0, "YYY");
  }, "remote3");

  if (view.state.doc.toString() !== "YYYDEFG") {
    throw new Error(`远程替换后编辑器错误: "${view.state.doc.toString()}"`);
  }

  ytext.unobserve(yObserver);
  view.destroy();
});

test("防环验证:本地输入不反射回编辑器", () => {
  const doc = new Y.Doc();
  const ytext = doc.getText("source");

  const ORIGIN_LOCAL = "local-input";
  let applyingToY = false;
  let applyingToEditor = false;
  let yUpdateCount = 0;
  let editorUpdateFromYCount = 0;

  // 编辑器 → Y.Text
  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged && !applyingToEditor) {
      applyingToY = true;
      yUpdateCount++;
      try {
        doc.transact(() => {
          const changeList = [];
          update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
            changeList.push({
              from: fromA,
              to: toA,
              insert: inserted.sliceString(0, inserted.length),
            });
          });
          for (let i = changeList.length - 1; i >= 0; i--) {
            const c = changeList[i];
            if (c.to > c.from) ytext.delete(c.from, c.to - c.from);
            if (c.insert.length > 0) ytext.insert(c.from, c.insert);
          }
        }, ORIGIN_LOCAL);
      } finally {
        applyingToY = false;
      }
    }
  });

  // Y.Text → 编辑器
  const yObserver = (event, tr) => {
    if (tr.origin === ORIGIN_LOCAL) return;
    if (applyingToY) return;
    applyingToEditor = true;
    editorUpdateFromYCount++;
    try {
      const changes = yDeltaToCmChanges(event.delta);
      if (changes.length > 0) {
        view.dispatch({ changes });
      }
    } finally {
      applyingToEditor = false;
    }
  };

  const state = EditorState.create({ doc: "", extensions: [updateListener] });
  const view = new EditorView({ state, parent });
  ytext.observe(yObserver);

  // 本地输入:Y.Text 更新,但编辑器不应该被 Y.Text 回写
  const editorUpdatesBefore = editorUpdateFromYCount;
  view.dispatch({ changes: { from: 0, insert: "Hello" } });

  if (yUpdateCount !== 1) {
    throw new Error(`Y.Text 应该更新 1 次,实际: ${yUpdateCount}`);
  }
  if (editorUpdateFromYCount !== editorUpdatesBefore) {
    throw new Error(`本地输入触发了编辑器回写! 次数: ${editorUpdateFromYCount}`);
  }
  if (ytext.toString() !== "Hello") {
    throw new Error(`Y.Text 内容错误: "${ytext.toString()}"`);
  }
  if (view.state.doc.toString() !== "Hello") {
    throw new Error(`编辑器内容错误: "${view.state.doc.toString()}"`);
  }

  console.log("     ✓ 本地输入不回环");

  // 远程改动:编辑器应该更新,且不触发 Y.Text 二次更新
  const yUpdatesBefore = yUpdateCount;
  doc.transact(() => {
    ytext.insert(5, " World");
  }, "remote");

  if (editorUpdateFromYCount <= editorUpdatesBefore) {
    throw new Error("远程改动未触发编辑器更新");
  }
  if (yUpdateCount !== yUpdatesBefore) {
    throw new Error(`远程改动触发了 Y.Text 二次更新! 从 ${yUpdatesBefore} 变成 ${yUpdateCount}`);
  }
  if (view.state.doc.toString() !== "Hello World") {
    throw new Error(`编辑器内容错误: "${view.state.doc.toString()}"`);
  }
  if (ytext.toString() !== "Hello World") {
    throw new Error(`Y.Text 内容错误: "${ytext.toString()}"`);
  }

  console.log("     ✓ 远程改动正确更新编辑器,且不回环");

  ytext.unobserve(yObserver);
  view.destroy();
});

test("初始同步:Y.Text 为准,编辑器内容同步为 Y.Text", () => {
  const doc = new Y.Doc();
  const ytext = doc.getText("source");
  ytext.insert(0, "来自 CRDT 的内容");

  const state = EditorState.create({ doc: "编辑器默认内容" });
  const view = new EditorView({ state, parent });

  // 模拟绑定时的初始同步
  const yContent = ytext.toString();
  const editorContent = view.state.doc.toString();
  if (yContent !== editorContent) {
    view.dispatch({
      changes: { from: 0, to: editorContent.length, insert: yContent },
    });
  }

  if (view.state.doc.toString() !== "来自 CRDT 的内容") {
    throw new Error(`初始同步后编辑器内容错误: "${view.state.doc.toString()}"`);
  }

  view.destroy();
});

test("解绑后 Y.Text 变化不影响编辑器", () => {
  const doc = new Y.Doc();
  const ytext = doc.getText("source");
  ytext.insert(0, "绑定中");

  let applyingToEditor = false;
  const yObserver = (event, tr) => {
    if (applyingToEditor) return;
    applyingToEditor = true;
    try {
      const changes = yDeltaToCmChanges(event.delta);
      view.dispatch({ changes });
    } finally {
      applyingToEditor = false;
    }
  };

  const state = EditorState.create({ doc: "绑定中" });
  const view = new EditorView({ state, parent });
  ytext.observe(yObserver);

  // 绑定时:Y.Text 变化 → 编辑器更新
  doc.transact(() => { ytext.insert(2, "!"); }, "remote");
  if (view.state.doc.toString() !== "绑定!中") {
    throw new Error(`绑定时未同步: "${view.state.doc.toString()}"`);
  }

  // 解绑
  ytext.unobserve(yObserver);

  // 解绑后:Y.Text 变化 → 编辑器不变
  doc.transact(() => { ytext.insert(0, "前缀"); }, "remote2");
  if (view.state.doc.toString() !== "绑定!中") {
    throw new Error(`解绑后编辑器不该变化: "${view.state.doc.toString()}"`);
  }
  if (ytext.toString() !== "前缀绑定!中") {
    throw new Error(`Y.Text 应该变化: "${ytext.toString()}"`);
  }

  view.destroy();
});

test("完整场景:多次交替编辑后两边一致", () => {
  const doc = new Y.Doc();
  const ytext = doc.getText("source");

  const ORIGIN_LOCAL = "local-input";
  let applyingToY = false;
  let applyingToEditor = false;

  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged && !applyingToEditor) {
      applyingToY = true;
      try {
        doc.transact(() => {
          const changeList = [];
          update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
            changeList.push({
              from: fromA,
              to: toA,
              insert: inserted.sliceString(0, inserted.length),
            });
          });
          for (let i = changeList.length - 1; i >= 0; i--) {
            const c = changeList[i];
            if (c.to > c.from) ytext.delete(c.from, c.to - c.from);
            if (c.insert.length > 0) ytext.insert(c.from, c.insert);
          }
        }, ORIGIN_LOCAL);
      } finally {
        applyingToY = false;
      }
    }
  });

  const yObserver = (event, tr) => {
    if (tr.origin === ORIGIN_LOCAL) return;
    if (applyingToY) return;
    applyingToEditor = true;
    try {
      const changes = yDeltaToCmChanges(event.delta);
      if (changes.length > 0) view.dispatch({ changes });
    } finally {
      applyingToEditor = false;
    }
  };

  const state = EditorState.create({ doc: "初始内容", extensions: [updateListener] });
  const view = new EditorView({ state, parent });

  // 先同步 Y.Text 初始值
  doc.transact(() => {
    ytext.insert(0, "初始内容");
  }, "init");

  ytext.observe(yObserver);

  // 序列:本地输入 → 远程插入 → 本地删除 → 远程替换 → 本地追加
  view.dispatch({ changes: { from: 4, insert: "本地" } });
  doc.transact(() => { ytext.insert(0, "远程前缀-"); }, "remote1");
  view.dispatch({ changes: { from: 7, to: 9 } }); // 删"本地"
  doc.transact(() => {
    ytext.delete(ytext.toString().length - 2, 2);
    ytext.insert(ytext.toString().length - 2, "结尾");
  }, "remote2");
  view.dispatch({ changes: { from: view.state.doc.length, insert: "!" } });

  const editorFinal = view.state.doc.toString();
  const yFinal = ytext.toString();

  if (editorFinal !== yFinal) {
    throw new Error(
      `多次交替后不一致!\n编辑器: "${editorFinal}"\nY.Text: "${yFinal}"`
    );
  }

  console.log(`     最终内容: "${editorFinal}"`);
  console.log("     ✓ 多次交替后仍完全一致");

  ytext.unobserve(yObserver);
  view.destroy();
});

console.log();
console.log("=".repeat(60));
console.log(`  测试完成: ${passed} 通过, ${failed} 失败`);
console.log("=".repeat(60));

if (failed > 0) {
  process.exit(1);
}
