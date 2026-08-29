import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { StateEffect, StateField, ChangeSet } from "@codemirror/state";
import * as Y from "yjs";

/**
 * Editor Binding — CodeMirror 6 ↔ Y.Text 双向绑定
 *
 * 设计原则:
 * 1. Y.Text 是真相来源(Y.Text-is-truth,对齐 OpenKnowledge)
 * 2. 编辑器改动 → Y.Text:用 CodeMirror 的 ChangeSet 精确增量应用
 * 3. Y.Text 改动 → 编辑器:用 Y.Text event delta 精确增量应用
 * 4. 用 origin 机制防止回环(自己的改动不反射回自己)
 *
 * Origin 约定:
 * - Symbol("git-crdt-local"): 用户在编辑器中的输入
 * - 其他 origin(或没有):来自远程/同步的改动
 */

/** 本地编辑器输入的 origin — 此来源的 Y.Text 改动不反射回编辑器 */
export const ORIGIN_LOCAL = Symbol("git-crdt-local-editor");

/** 外部写入(如三路合并结果)的 origin */
export const ORIGIN_EXTERNAL = Symbol("git-crdt-external");

/**
 * StateEffect:绑定或解绑 Y.Text
 */
export const bindYTextEffect = StateEffect.define<{ ytext: Y.Text | null }>();

/**
 * StateField:保存当前绑定的 Y.Text 引用
 */
const ytextField = StateField.define<Y.Text | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(bindYTextEffect)) {
        return effect.value.ytext;
      }
    }
    return value;
  },
});

/**
 * ViewPlugin: 双向同步逻辑
 *
 * 两个方向:
 * A. 编辑器 → Y.Text: 用户打字时,用 ChangeSet 精确更新 Y.Text
 * B. Y.Text → 编辑器: Y.Text 因远程/外部原因变化时,用 delta 更新编辑器
 */
const bindingPlugin = ViewPlugin.fromClass(
  class {
    private ytext: Y.Text | null = null;
    private yObserver: ((event: Y.YTextEvent, tr: Y.Transaction) => void) | null = null;
    private applyingToY = false;
    private applyingToEditor = false;

    constructor(private view: EditorView) {}

    update(update: ViewUpdate) {
      const newYText = update.state.field(ytextField, false);
      const oldYText = update.startState.field(ytextField, false);

      // Y.Text 绑定变化
      if (newYText !== oldYText) {
        this.unbind();
        if (newYText) {
          this.bind(newYText);
        }
      }

      // 编辑器内容变化 → 更新 Y.Text(方向 A)
      if (update.docChanged && this.ytext && !this.applyingToEditor) {
        this.applyEditorChangesToY(update.changes);
      }
    }

    /** 绑定 Y.Text:建立观察者 + 初始同步 */
    private bind(ytext: Y.Text) {
      this.ytext = ytext;

      // 方向 B:监听 Y.Text 变化 → 编辑器
      this.yObserver = (event, tr) => {
        // 本地编辑器产生的改动不反射回去
        if (tr.origin === ORIGIN_LOCAL) return;
        // 正在向 Y 写入时也忽略(防重入)
        if (this.applyingToY) return;

        this.applyYChangesToEditor(event);
      };

      ytext.observe(this.yObserver);

      // 初始同步:以 Y.Text 为准,如果内容不同就更新编辑器
      const yContent = ytext.toString();
      const editorContent = this.view.state.doc.toString();
      if (yContent !== editorContent) {
        this.applyingToEditor = true;
        try {
          this.view.dispatch({
            changes: { from: 0, to: editorContent.length, insert: yContent },
          });
        } finally {
          this.applyingToEditor = false;
        }
      }
    }

    /** 解绑 Y.Text */
    private unbind() {
      if (this.ytext && this.yObserver) {
        this.ytext.unobserve(this.yObserver);
      }
      this.ytext = null;
      this.yObserver = null;
    }

    /** 方向 A:编辑器 ChangeSet → Y.Text */
    private applyEditorChangesToY(changes: ChangeSet) {
      if (!this.ytext || !this.ytext.doc) return;

      this.applyingToY = true;
      try {
        this.ytext.doc.transact(() => {
          // 收集所有变更(正序),然后倒序应用
          // 倒序是因为:如果从前往后删/插,前面的操作会影响后面的位置
          const changeList: { from: number; to: number; insert: string }[] = [];
          changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
            changeList.push({
              from: fromA,
              to: toA,
              insert: inserted.sliceString(0, inserted.length),
            });
          });

          // 从后往前应用,保证位置正确
          for (let i = changeList.length - 1; i >= 0; i--) {
            const c = changeList[i];
            if (c.to > c.from) {
              this.ytext!.delete(c.from, c.to - c.from);
            }
            if (c.insert.length > 0) {
              this.ytext!.insert(c.from, c.insert);
            }
          }
        }, ORIGIN_LOCAL);
      } finally {
        this.applyingToY = false;
      }
    }

    /**
     * 方向 B:Y.Text event delta → 编辑器
     *
     * Y.Text delta 格式(Yjs 标准):
     * - { retain: N }  跳过 N 个字符
     * - { insert: "..." }  插入文本
     * - { delete: N }  删除 N 个字符
     *
     * 注意:delta 中操作的位置是**串联**的,即每个操作的位置基于前一个操作后的文档状态。
     * 转换为 CodeMirror 的绝对位置需要在原始文档坐标上计算。
     */
    private applyYChangesToEditor(event: Y.YTextEvent) {
      if (!this.ytext) return;

      this.applyingToEditor = true;
      try {
        const delta = event.delta;
        const cmChanges: { from: number; to?: number; insert?: string }[] = [];

        // pos 追踪当前在原始文档中的位置(CodeMirror 坐标系)
        // 对于 insert:pos 不变(插入后原位置后移,但后续 retain/delete 基于原始坐标)
        // 对于 delete:pos 不变(删除后位置前移,但后续 retain/delete 基于原始坐标)
        // 等等,不对 — Y.Text 的 delta 是串行的,每个操作的位置基于前一个操作后的状态。
        // 而 CodeMirror 的 changes 都基于原始文档的位置。
        //
        // 转换策略:用两个指针追踪
        // - yPos: Yjs delta 中的当前位置(随操作推进)
        // - cmPos: CodeMirror 原始文档中的位置(只随 retain 推进)
        //
        // 实际上更简单:因为 Y.Text delta 是从前到后的顺序,
        // 每个 retain/insert/delete 操作的起始位置 = 之前所有操作影响后的位置。
        // 而 CodeMirror 的 changes 也应该从前到后排列,每个 change 的 from 是原始文档位置。
        //
        // 我们维护一个 cursor 在"原始文档"中移动:
        // - retain N: cursor += N
        // - insert "x": 在 cursor 处插入(insert 不移动原始文档的 cursor)
        // - delete N: 从 cursor 处删除 N 个(delete 不移动原始文档的 cursor,因为删除的是接下来的)
        //
        // 等等,让我重新想...
        //
        // 假设原始文档是 "ABCDEFG"
        // delta: [{retain: 2}, {insert: "X"}, {retain: 1}, {delete: 2}]
        // 含义:
        //   1. 保留前 2 个字符 ("AB")
        //   2. 插入 "X" → 现在是 "ABXCDEFG"
        //   3. 再保留 1 个字符 (这是 "C",原始位置 2)
        //   4. 删除 2 个字符 (删除 "DE",原始位置 3-4)
        //
        // 对应的 CodeMirror changes(基于原始文档):
        //   - { from: 2, insert: "X" }
        //   - { from: 3, to: 5 }
        //
        // 所以 cursor 应该追踪"原始文档"的位置:
        // - retain N → cursor += N
        // - insert → 在 cursor 处插入,cursor 不变(因为 insert 发生在当前位置之前/之上,不影响后续原始文档的位置映射)
        // - delete N → 从 cursor 处删除 N 个,cursor 不变
        //
        // 不对,等一下...
        //
        // 上面的例子:
        // start cursor = 0
        // retain 2 → cursor = 2
        // insert "X" → 在位置 2 插入,cursor 保持 2 (因为 insert 是新增的,不算原始文档的推进)
        // retain 1 → cursor += 1 = 3 (这 1 个是原始文档中的字符)
        // delete 2 → 从位置 3 开始删 2 个(原始文档的 3,4 位置 = "DE")
        //
        // 结果:
        // cmChanges = [{from: 2, insert: "X"}, {from: 3, to: 5}]
        // 这是正确的!
        //
        // 所以规则是:
        // - cursor 始终指向原始文档的位置
        // - retain N → cursor += N (推进原始文档指针)
        // - insert str → 在 cursor 处插入 str,cursor 不变
        // - delete N → 从 cursor 处删除 N 个(到 cursor+N),cursor 不变

        let cursor = 0; // 原始文档中的位置

        for (const op of delta) {
          if (typeof op.retain === "number") {
            cursor += op.retain;
          } else if (typeof op.insert === "string") {
            cmChanges.push({ from: cursor, insert: op.insert });
            // 注意:insert 不移动 cursor,因为后续 retain/delete 引用的是原始文档
          } else if (typeof op.delete === "number") {
            cmChanges.push({ from: cursor, to: cursor + op.delete });
            // delete 也不移动 cursor
          }
        }

        if (cmChanges.length > 0) {
          this.view.dispatch({ changes: cmChanges });
        }
      } finally {
        this.applyingToEditor = false;
      }
    }

    destroy() {
      this.unbind();
    }
  }
);

/** 编辑器绑定扩展:注册到 Obsidian 的 registerEditorExtension */
export const yEditorBindingExtension = [ytextField, bindingPlugin];

/**
 * 辅助函数:给指定 EditorView 绑定 Y.Text
 * @param view CodeMirror EditorView 实例
 * @param ytext Y.Text 实例,传 null 则解绑
 */
export function bindYTextToView(view: EditorView, ytext: Y.Text | null): void {
  view.dispatch({
    effects: bindYTextEffect.of({ ytext }),
  });
}
