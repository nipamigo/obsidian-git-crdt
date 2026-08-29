# obsidian-git-crdt

> CRDT + Git 同步 — 无冲突的多人协作 Obsidian 插件。
>
> 灵感来自 [OpenKnowledge](https://github.com/inkeep/open-knowledge) 的架构,把它带到 Obsidian。

---

## 最新版本:v0.3.0

**v0.3.0 重大更新**:编辑器实时 CRDT 绑定!打开 Markdown 文件时,Y.Text 自动绑定到 CodeMirror 6 编辑器,每一次按键都精确地转化为 Yjs 操作,保留完整的 CRDT 操作历史。同步后编辑器自动刷新,无需手动重载。

**v0.2.0 重大更新**:深入研究了 OpenKnowledge 源码后,对齐了它的核心设计——**Git pull 用三路文本合并(而非 CRDT 合并)**,原因是 Git 场景下两边没有共享的 CRDT 操作历史,三路文本合并反而更可靠。CRDT 保留用于编辑器增量更新和实时协作。

---

## 它解决什么问题

你和同事用 Git 同步 Obsidian 笔记库,两个人同时改了同一篇笔记,push 时出现 `<<<<<<< HEAD` 冲突标记,手动解决很痛苦。

**Git CRDT 插件让 Git 不再产生冲突标记。**

## How it works

```
┌─────────────────────────────────────────┐
│  Obsidian Editor (CodeMirror 6)         │
│  ╔═══════════════════════════════════╗   │
│  ║  CRDT Editor Binding (v0.3)      ║   │
│  ║  - 双向同步:打字 → Yjs 操作      ║   │
│  ║  - origin 防环机制               ║   │
│  ║  - Sidecar 持久化 CRDT 身份      ║   │
│  ╚═══════════════════════════════════╝   │
├─────────────────────────────────────────┤
│  CRDT Layer (Yjs Y.Text)                │
│  - applyFastDiff: 行级增量更新          │
│  - 保留未变行的 Yjs Item 身份           │
│  - Sidecar 持久化操作历史               │
├─────────────────────────────────────────┤
│  Merge Layer (three-way text merge)     │  ← Git pull 合并发生在这里
│  - diff-match-patch 字符级补丁合并      │
│  - assertContentPreservation 内容保全   │
├─────────────────────────────────────────┤
│  Git Layer (isomorphic-git)             │
│  - fetch / commit / push                │
│  - 纯 JS,不需要系统装 git               │
└─────────────────────────────────────────┘
```

**核心思想(与 OpenKnowledge 一致)**:
- **Git 只负责传输和历史**,合并交给上层
- **Git pull 用三路文本合并**(diff3 + diff-match-patch),不是 CRDT 合并
- **CRDT 负责编辑器层面的增量更新**,保留操作历史
- 永远不会出现 `<<<<<<< HEAD`

## 为什么 Git pull 不用 CRDT 合并

这是研究 OK 源码后纠正的一个认知:

> Git pull 是"两个完整版本的合并",两边没有共享的 CRDT 操作历史,Yjs 拿不到对方的 state vector,做不了真正的 CRDT 合并。三路文本合并在这种场景下反而更可靠。
>
> CRDT 的用武之地是:**多客户端实时编辑**(通过 WebSocket 共享操作历史)。

## Features

- ✅ **No Git conflict markers** — 再也不用手动解决 Markdown 冲突
- ✅ **Zero server setup** — 用 Git 做同步通道,和 Obsidian Git 一样
- ✅ **No system git required** — 基于 isomorphic-git(纯 JS)
- ✅ **Three-way merge** — 基于 diff-match-patch 的字符级精细合并
- ✅ **Content preservation checks** — 子串/顺序/增长三层检测,确保合并不丢内容
- ✅ **Fast diff incremental update** — 行对齐增量更新,保留 CRDT 操作历史
- ✅ **Status bar + commands** — 状态栏快速同步,命令面板全功能
- ✅ **Auto sync** — 可配置自动同步间隔
- ✅ **Sidecar files** — `.yjs` sidecar 保留 CRDT 身份

## Installation

### 手动安装

1. 下载 release: `main.js` + `manifest.json`
2. 在 vault 中创建目录: `.obsidian/plugins/git-crdt/`
3. 放入两个文件
4. 重启 Obsidian → Settings → Community plugins → 启用 "Git CRDT"

### 源码构建

```bash
npm install
npm run build
# 输出: main.js + manifest.json
```

## Setup

1. 打开 **Settings → Git CRDT**
2. 填写 **Git Remote URL**(如 `https://github.com/you/my-vault.git`)
3. 填写 **Git Token**(Personal Access Token,repo 权限)
4. 填写 **Author Name** 和 **Author Email**
5. 点击 **Init** 初始化 Git 仓库
6. 点击 **Sync** 执行首次同步

## Commands

命令面板(Ctrl/Cmd+P)中输入:

| Command | 说明 |
|:---|:---|
| `Git CRDT: Sync` | Pull → 三路合并 → commit → push |
| `Git CRDT: Pull only` | 只拉取合并,不提交不推送 |
| `Git CRDT: Commit & push` | 提交所有变更并推送 |
| `Git CRDT: Initialize Git repo` | 初始化 Git 仓库 |

也可以点击**右下角状态栏**("Git CRDT: ready")快速同步。

## 架构详解

### 核心模块

| 文件 | 行数 | 职责 | 参考 OK 的部分 |
|:---|:---|:---|:---|
| `src/main.ts` | 377 | 插件入口、设置面板、状态栏、命令 | - |
| `src/merge.ts` | 240 | 三路文本合并 + 内容保全检测 | `bridge/merge-three-way.ts` |
| `src/apply-diff.ts` | 124 | 行级快速 diff + 增量 Yjs 更新 | `bridge/apply-diff.ts` |
| `src/crdt.ts` | 176 | Yjs CRDT 管理 + sidecar 持久化 | Y.Text-is-truth 设计 |
| `src/git.ts` | 273 | isomorphic-git 封装 | sync-engine 思路 |
| `src/sync.ts` | 254 | 同步编排引擎 | pull → merge → commit → push |

### 合并算法

1. **行级 diff3 框架**:按行比较 baseline / ours / theirs
2. **冲突区域字符级补丁**:冲突行用 diff-match-patch 做字符级精细合并
3. **内容保全三层检测**:
   - 子串检查:两边新增的内容必须都在结果中
   - 顺序检查:新增片段的相对顺序必须保持
   - 增长检查:结果中任何行的出现次数不能超过输入中的最大值

### Sync 流程

```
用户点击 Sync
    ↓
git fetch origin
    ↓
对比本地 HEAD 与远端,找出变更的 .md 文件
    ↓
for each changed file:
    read baseline (HEAD 版本)
    read ours (working tree)
    read theirs (remote)
    → mergeThreeWay(baseline, ours, theirs)
    → assertContentPreservation(仅警告)
    → applyFastDiff 到 CRDT(保留未变行身份)
    → 写回文件
    ↓
commit merged result
    ↓
push to remote
```

## Roadmap

- ✅ **v0.1**:MVP 核心功能(Git + CRDT 基础)
- ✅ **v0.2**:三路文本合并 + 内容保全检测(对齐 OpenKnowledge)
- ✅ **v0.3**:编辑器实时 CRDT 绑定(CodeMirror 6 + Yjs,打字即 Yjs 操作)
- **v0.4**:块级结构化合并(Y.XmlFragment + mdast AST 映射)
- **v0.5**:Merge history + revert UI
- **v0.6**:Shadow repo 隔离(不触碰用户 staging area)
- **v1.0**:提交官方社区插件市场

## 与其他方案对比

| 方案 | 无冲突标记 | 实时协作 | 需要服务端 | Git 历史 | 编辑器生态 |
|:---|:---|:---|:---|:---|:---|
| **obsidian-git-crdt** | ✅ | ❌(规划中) | ❌ | ✅ | ✅ Obsidian |
| Obsidian Git | ❌(手动解决) | ❌ | ❌ | ✅ | ✅ Obsidian |
| Qollab + Syncthing | ✅ | ❌ | ❌ | ❌ | ✅ Obsidian |
| obsidian-crdt-coeditor | ✅ | ✅ | ⚠️(多人需要) | ❌ | ✅ Obsidian |
| OpenKnowledge | ✅ | ✅ | ❌(Git-based) | ✅ | ❌ 自带编辑器 |

## Known limitations

1. **Only `.md` files** 走合并逻辑。其他格式走普通 Git。
2. **MVP baseline 用本地 HEAD**。严格来说应该用 merge-base,后续版本改进。
3. **字符级合并**对 Markdown 语法可能有小瑕疵(如列表标记、标题层级)。
4. **No mobile support**(isomorphic-git 在移动端未测试)。
5. **Sidecar 文件**存在 `.obsidian/plugins/git-crdt/sidecar/`,建议加入 `.gitignore`。

## License

MIT
