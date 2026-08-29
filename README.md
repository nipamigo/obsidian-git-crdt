# obsidian-git-crdt

> CRDT + Git 同步 — 无冲突的多人协作 Obsidian 插件。
>
> 灵感来自 [OpenKnowledge](https://github.com/inkeep/open-knowledge) 的架构,把它带到 Obsidian。

---

## 最新版本:v0.6.0

**v0.6.0 新功能**:Shadow repo 隔离!所有 Git 操作(fetch / commit / push)都在 sidecar 目录下的 shadow repo 中进行,vault 的 `.git` 完全不被触碰。用户可以同时用自己的 Git 管理 vault,插件不会污染 staging area。

**v0.5.0**:合并历史 + 回退 UI!每次 Sync 合并文件后自动记录历史(合并前/后内容、来源、警告)。在 Obsidian 里打开合并历史列表,查看行级 diff 预览,一键回退到合并前状态,不用碰 Git 命令。

**v0.4.0**:块级结构化合并。把 Markdown 解析为块(标题/段落/列表/代码块),以块为单位做三路 diff(LCS 算法),块内冲突再降级到字符级文本合并。

**v0.3.0**:编辑器实时 CRDT 绑定。打开 Markdown 文件时,Y.Text 自动绑定到 CodeMirror 6 编辑器。

**v0.2.0**:深入研究 OpenKnowledge 源码后,对齐了核心设计——Git pull 用三路文本合并(而非 CRDT 合并)。

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
│  Merge Layer                              │  ← Git pull 合并发生在这里
│  ╔═══════════════════════════════════╗   │
│  ║ Block Merge (v0.4)               ║   │
│  ║ - Markdown → 块(标题/段落/列表)  ║   │
│  ║ - LCS 块级 diff                   ║   │
│  ║ - 块内冲突 → 文本级 fallback      ║   │
│  ╚═══════════════════════════════════╝   │
│  - diff-match-patch 字符级补丁合并      │
│  - assertContentPreservation 内容保全   │
├─────────────────────────────────────────┤
│  History Layer (v0.5)                   │
│  - 每次合并自动记录(before/after)      │
│  - 行级 diff 预览 + 一键回退            │
│  - 自动清理(maxRecords)               │
├─────────────────────────────────────────┤
│  Git Layer (isomorphic-git)             │
│  ╔═══════════════════════════════════╗   │
│  ║ Shadow Repo (v0.6)              ║   │
│  ║ - sidecar/shadow-git/ 独立仓库  ║   │
│  ║ - vault .git 完全不被触碰       ║   │
│  ║ - 只同步 .md 文件               ║   │
│  ╚═══════════════════════════════════╝   │
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
- ✅ **Merge history + revert** — 每次合并自动记录历史,支持行级 diff 预览和一键回退

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
| `Git CRDT: Show merge history (all files)` | 查看所有文件的合并历史 |
| `Git CRDT: Show merge history (current file)` | 查看当前文件的合并历史 |

也可以点击**右下角状态栏**("Git CRDT: ready")快速同步。

## 架构详解

### 核心模块

| 文件 | 行数 | 职责 | 参考 OK 的部分 |
|:---|:---|:---|:---|
| `src/main.ts` | 377 | 插件入口、设置面板、状态栏、命令 | - |
| `src/block-parser.ts` | 230 | Markdown 块解析器(标题/段落/列表/代码块/引用/表格) | mdast 映射思路 |
| `src/block-merge.ts` | 280 | 块级三路合并(LCS + 相似度 + 块内 fallback) | 块级合并架构 |
| `src/merge.ts` | 240 | 字符级三路文本合并 + 内容保全检测 | `bridge/merge-three-way.ts` |
| `src/apply-diff.ts` | 124 | 行级快速 diff + 增量 Yjs 更新 | `bridge/apply-diff.ts` |
| `src/crdt.ts` | 176 | Yjs CRDT 管理 + sidecar 持久化 | Y.Text-is-truth 设计 |
| `src/editor-binding.ts` | 218 | CodeMirror 6 ↔ Y.Text 双向绑定 | - |
| `src/history.ts` | 170 | 合并历史存储引擎(记录/查询/清理) | - |
| `src/history-ui.ts` | 250 | 历史列表 + diff 预览 + 回退 Modal | - |
| `src/git.ts` | 273 | isomorphic-git 封装 | sync-engine 思路 |
| `src/sync.ts` | 260 | 同步编排引擎(块级合并 → CRDT 更新 → push) | pull → merge → commit → push |

### 合并算法

1. **块级 diff(v0.4)**:Markdown 解析为块,LCS 算法做块级三路 diff
2. **块内字符级补丁**:块内冲突用 diff-match-patch 做字符级精细合并
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
    → mergeBlocksThreeWayV2(baseline, ours, theirs)
    → assertContentPreservation(仅警告)
    → applyFastDiff 到 CRDT(保留未变行身份)
    → 写回文件
    → 记录合并历史(before/after/remote/source)  ← v0.5
    ↓
commit merged result
    ↓
push to remote
```

## Roadmap

- ✅ **v0.1**:MVP 核心功能(Git + CRDT 基础)
- ✅ **v0.2**:三路文本合并 + 内容保全检测(对齐 OpenKnowledge)
- ✅ **v0.3**:编辑器实时 CRDT 绑定(CodeMirror 6 + Yjs,打字即 Yjs 操作)
- ✅ **v0.4**:块级结构化合并(Markdown 块解析 + LCS 块级 diff + 块内文本级 fallback)
- ✅ **v0.5**:合并历史 + 回退 UI(每次合并自动记录,一键回退到合并前)
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
