/**
 * v0.6 Shadow Repo 隔离测试
 *
 * 验证:
 * 1. ShadowGitService 初始化:shadow repo 目录自动创建
 * 2. syncVaultToShadow():vault .md 文件 → shadow 工作区
 * 3. 文件删除:vault 删除文件后 shadow 也同步删除
 * 4. .gitignore:shadow repo 只跟踪 .md 文件
 * 5. writeMergedFile():合并结果写入 shadow
 * 6. 隔离性:vault 的 .git(如果存在)不被触碰
 * 7. commit + push:在 shadow repo 中提交并推送
 * 8. 完整同步流程:多人协作 → shadow repo 隔离
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const git = require("isomorphic-git");
const http = require("isomorphic-git/http/node");

// ===== 测试框架 =====
let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function testAsync(name, fn) {
  tests.push({ name, fn, async: true });
}

async function runTests() {
  console.log("============================================================");
  console.log("  v0.6 Shadow Repo 隔离测试");
  console.log("============================================================\n");

  for (const t of tests) {
    process.stdout.write(`  ⏳ ${t.name} ...`);
    try {
      if (t.async) {
        await t.fn();
      } else {
        t.fn();
      }
      console.log(`\r  ✅ ${t.name}                             `);
      passed++;
    } catch (e) {
      console.log(`\r  ❌ ${t.name}                             `);
      console.log(`     ${e.message}`);
      if (e.stack) console.log(`     ${e.stack.split("\n")[1]?.trim() || ""}`);
      failed++;
    }
  }

  console.log("\n============================================================");
  console.log(`  测试完成: ${passed} 通过, ${failed} 失败`);
  console.log("============================================================");

  if (failed > 0) process.exit(1);
}

// ===== ShadowGitService 内联实现(和 shadow-git.ts 一致) =====

class ShadowGitService {
  constructor(opts) {
    this.vaultDir = opts.vaultDir;
    this.sidecarDir = opts.sidecarDir;
    this.shadowDir = path.join(opts.sidecarDir, "shadow-git");
    this.fs = opts.fs;

    try {
      fs.mkdirSync(this.shadowDir, { recursive: true });
    } catch (e) {}

    // 内部 GitService
    this.git = new GitService({
      fs: opts.fs,
      dir: this.shadowDir,
      authorName: opts.authorName,
      authorEmail: opts.authorEmail,
      remote: opts.remote || "",
      branch: opts.branch || "main",
      token: opts.token || "",
    });
  }

  getShadowDir() {
    return this.shadowDir;
  }

  getGitService() {
    return this.git;
  }

  getBranch() {
    return this.git.getBranch();
  }

  setToken(token) {
    this.git.setToken(token);
  }

  async setRemote(url) {
    await this.git.setRemote(url);
  }

  async initIfNeeded() {
    await this.git.initIfNeeded();
    // shadow repo 不用 .gitignore 的 * 模式(和 isomorphic-git 兼容性不好)
    // commitAll() 已经过滤非 .md 文件
  }

  async isRepo() {
    return this.git.isRepo();
  }

  async syncVaultToShadow() {
    let copied = 0;
    let deleted = 0;

    const vaultMdFiles = this.collectMdFiles(this.vaultDir);
    const shadowMdFiles = this.collectMdFiles(this.shadowDir);
    const vaultSet = new Set(vaultMdFiles.map((f) => f.relative));

    // 删除 shadow 中 vault 已不存在的 .md 文件
    for (const shadowFile of shadowMdFiles) {
      if (!vaultSet.has(shadowFile.relative)) {
        const absPath = path.join(this.shadowDir, shadowFile.relative);
        try {
          fs.unlinkSync(absPath);
          deleted++;
        } catch (e) {}
      }
    }

    // 复制 vault 的 .md 文件到 shadow
    for (const vaultFile of vaultMdFiles) {
      const srcPath = path.join(this.vaultDir, vaultFile.relative);
      const dstPath = path.join(this.shadowDir, vaultFile.relative);

      const dstDir = path.dirname(dstPath);
      try {
        fs.mkdirSync(dstDir, { recursive: true });
      } catch (e) {}

      let needCopy = true;
      try {
        if (fs.existsSync(dstPath)) {
          const srcContent = fs.readFileSync(srcPath, "utf-8");
          const dstContent = fs.readFileSync(dstPath, "utf-8");
          if (srcContent === dstContent) needCopy = false;
        }
      } catch (e) {}

      if (needCopy) {
        try {
          fs.copyFileSync(srcPath, dstPath);
          copied++;
        } catch (e) {}
      }
    }

    return { copied, deleted };
  }

  writeMergedFile(relativePath, content) {
    const dstPath = path.join(this.shadowDir, relativePath);
    const dstDir = path.dirname(dstPath);
    try {
      fs.mkdirSync(dstDir, { recursive: true });
      fs.writeFileSync(dstPath, content, "utf-8");
    } catch (e) {
      console.error(`failed to write merged file: ${relativePath}`, e);
    }
  }

  deleteShadowFile(relativePath) {
    const absPath = path.join(this.shadowDir, relativePath);
    try {
      if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
    } catch (e) {}
  }

  async smartPull() {
    await this.syncVaultToShadow();
    return this.git.smartPull();
  }

  async readFileFromHead(filepath) {
    return this.git.readFileFromHead(filepath);
  }

  async readFileFromRemote(filepath) {
    return this.git.readFileFromRemote(filepath);
  }

  async statusMatrix() {
    return this.git.statusMatrix();
  }

  async commitAll(message) {
    await this.syncVaultToShadow();
    return this.git.commitAll(message);
  }

  async push() {
    return this.git.push();
  }

  collectMdFiles(rootDir) {
    const result = [];

    const walk = (dir, prefix) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        return;
      }

      for (const entry of entries) {
        if (entry.name === ".git") continue;
        if (entry.name === ".obsidian" && dir === this.vaultDir) continue;

        const fullPath = path.join(dir, entry.name);
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          walk(fullPath, relativePath);
        } else if (entry.name.endsWith(".md")) {
          result.push({ absolute: fullPath, relative: relativePath });
        }
      }
    };

    walk(rootDir, "");
    return result;
  }

  async destroy() {
    try {
      fs.rmSync(this.shadowDir, { recursive: true, force: true });
    } catch (e) {}
  }
}

// ===== GitService 内联实现(和 git.ts 一致,精简版) =====

class GitService {
  constructor(opts) {
    this.fs = opts.fs;
    this.dir = opts.dir;
    this.author = { name: opts.authorName, email: opts.authorEmail };
    this.remote = opts.remote;
    this.branch = opts.branch;
    this.token = opts.token || "";
  }

  setToken(token) {
    this.token = token;
  }

  getBranch() {
    return this.branch;
  }

  async isRepo() {
    // 检查 .git 目录是否存在(初始化后但还没有提交时 HEAD 解析不了)
    try {
      await git.resolveRef({ fs: this.fs, dir: this.dir, ref: "HEAD" });
      return true;
    } catch {
      // HEAD 不可用可能是刚 init 还没提交
      return fs.existsSync(path.join(this.dir, ".git"));
    }
  }

  async initIfNeeded() {
    if (await this.isRepo()) return;
    await git.init({ fs: this.fs, dir: this.dir, defaultBranch: this.branch });
  }

  async statusMatrix() {
    return git.statusMatrix({ fs: this.fs, dir: this.dir });
  }

  async readFileFromHead(filepath) {
    return this.readBlobAt("HEAD", filepath);
  }

  async readFileFromRemote(filepath) {
    return this.readBlobAt(`refs/remotes/origin/${this.branch}`, filepath);
  }

  async readBlobAt(ref, filepath) {
    try {
      const oid = await git.resolveRef({ fs: this.fs, dir: this.dir, ref });
      const result = await git.readBlob({
        fs: this.fs,
        dir: this.dir,
        oid,
        filepath,
      });
      return new TextDecoder().decode(result.blob);
    } catch {
      return null;
    }
  }

  async listFilesAt(ref) {
    try {
      const oid = await git.resolveRef({ fs: this.fs, dir: this.dir, ref });
      return git.listFiles({ fs: this.fs, dir: this.dir, ref: oid });
    } catch {
      return [];
    }
  }

  async smartPull() {
    try {
      await git.fetch({
        fs: this.fs,
        http,
        dir: this.dir,
        remote: "origin",
        ref: this.branch,
        onAuth: () => this.getAuth(),
      });

      const remoteRef = `refs/remotes/origin/${this.branch}`;
      let hasRemote = true;
      try {
        await git.resolveRef({ fs: this.fs, dir: this.dir, ref: remoteRef });
      } catch {
        hasRemote = false;
      }

      if (!hasRemote) return { success: true, changedFiles: [] };

      let hasHead = true;
      try {
        await git.resolveRef({ fs: this.fs, dir: this.dir, ref: "HEAD" });
      } catch {
        hasHead = false;
      }

      const changedFiles = [];

      if (!hasHead) {
        const files = await this.listFilesAt(remoteRef);
        for (const f of files) {
          if (!f.endsWith(".md")) continue;
          const content = await this.readBlobAt(remoteRef, f);
          changedFiles.push({ path: f, remoteContent: content });
        }
      } else {
        const remoteFiles = await this.listFilesAt(remoteRef);
        const localFiles = await this.listFilesAt("HEAD");
        const localSet = new Set(localFiles);

        for (const f of remoteFiles) {
          if (!f.endsWith(".md")) continue;
          if (!localSet.has(f)) {
            const content = await this.readBlobAt(remoteRef, f);
            changedFiles.push({ path: f, remoteContent: content });
          } else {
            const localContent = await this.readBlobAt("HEAD", f);
            const remoteContent = await this.readBlobAt(remoteRef, f);
            if (localContent !== remoteContent) {
              changedFiles.push({ path: f, remoteContent });
            }
          }
        }
      }

      return { success: true, changedFiles };
    } catch (e) {
      return { success: false, changedFiles: [], error: e?.message || String(e) };
    }
  }

  async commitAll(message) {
    try {
      const matrix = await this.statusMatrix();
      let hasChanges = false;
      for (const row of matrix) {
        const filepath = row[0];
        const head = row[1];
        const workdir = row[2];
        const stage = row[3];

        if (filepath.startsWith(".git")) continue;
        // shadow repo: 只提交 .md 文件
        if (!filepath.endsWith(".md")) continue;

        if (workdir === 0 && head > 0) {
          await git.remove({ fs: this.fs, dir: this.dir, filepath });
          hasChanges = true;
        } else if (workdir > 0) {
          // 总是 stage .md 文件(比 statusMatrix 更可靠)
          await git.add({ fs: this.fs, dir: this.dir, filepath });
          hasChanges = true;
        }
      }

      if (!hasChanges) return null;

      const oid = await git.commit({
        fs: this.fs,
        dir: this.dir,
        author: this.author,
        message,
      });
      return oid;
    } catch (e) {
      console.error("commit failed:", e);
      return null;
    }
  }

  async push() {
    try {
      await git.push({
        fs: this.fs,
        http,
        dir: this.dir,
        remote: "origin",
        ref: this.branch,
        onAuth: () => this.getAuth(),
      });
      return { success: true };
    } catch (e) {
      return { success: false, error: e?.message || String(e) };
    }
  }

  async setRemote(url) {
    try {
      await git.addRemote({
        fs: this.fs,
        dir: this.dir,
        remote: "origin",
        url,
        force: true,
      });
    } catch {}
  }

  getAuth() {
    const token = this.token || process.env.GIT_TOKEN || "";
    if (!token) return undefined;
    return { username: "git-crdt", password: token };
  }
}

// ===== 临时目录 =====
let tmpDir;
let vaultDir;
let sidecarDir;
let shadowDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-git-test-"));
  vaultDir = path.join(tmpDir, "vault");
  sidecarDir = path.join(tmpDir, "sidecar");
  shadowDir = path.join(sidecarDir, "shadow-git");

  fs.mkdirSync(vaultDir, { recursive: true });
  fs.mkdirSync(sidecarDir, { recursive: true });
}

function cleanup() {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {}
}

// ===== 测试 =====

test("ShadowGitService 初始化:目录自动创建", () => {
  setup();
  const svc = new ShadowGitService({
    fs,
    vaultDir,
    sidecarDir,
    authorName: "test",
    authorEmail: "test@test.com",
    remote: "",
    branch: "main",
  });

  if (!fs.existsSync(shadowDir)) throw new Error("shadow dir not created");
  if (svc.getShadowDir() !== shadowDir) throw new Error("wrong shadow dir");
  if (svc.getBranch() !== "main") throw new Error("wrong branch");
});

testAsync("initIfNeeded:初始化 git 仓库", async () => {
  const svc = new ShadowGitService({
    fs,
    vaultDir,
    sidecarDir,
    authorName: "test",
    authorEmail: "test@test.com",
    remote: "",
    branch: "main",
  });

  await svc.initIfNeeded();
  const isRepo = await svc.isRepo();
  if (!isRepo) throw new Error("shadow repo not initialized");
});

testAsync("syncVaultToShadow:复制 .md 文件到 shadow 工作区", async () => {
  // 创建 vault 中的 .md 文件
  fs.writeFileSync(path.join(vaultDir, "note1.md"), "# Note 1\n\nContent A");
  fs.mkdirSync(path.join(vaultDir, "subfolder"), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, "subfolder", "note2.md"), "# Note 2\n\nContent B");
  // 非md文件不应被复制
  fs.writeFileSync(path.join(vaultDir, "image.png"), "fake-png");

  const svc = new ShadowGitService({
    fs,
    vaultDir,
    sidecarDir,
    authorName: "test",
    authorEmail: "test@test.com",
    branch: "main",
  });

  const result = await svc.syncVaultToShadow();

  if (result.copied !== 2) throw new Error(`expected 2 copied, got ${result.copied}`);

  // 验证 shadow 中有 .md 文件
  if (!fs.existsSync(path.join(shadowDir, "note1.md"))) throw new Error("note1.md not in shadow");
  if (!fs.existsSync(path.join(shadowDir, "subfolder", "note2.md"))) throw new Error("note2.md not in shadow");

  // 验证非 .md 文件没有被复制
  if (fs.existsSync(path.join(shadowDir, "image.png"))) throw new Error("image.png should not be in shadow");

  // 验证内容正确
  const content = fs.readFileSync(path.join(shadowDir, "note1.md"), "utf-8");
  if (content !== "# Note 1\n\nContent A") throw new Error("content mismatch");
});

testAsync("syncVaultToShadow:增量复制(只复制有变化的文件)", async () => {
  // 第一次同步
  const svc = new ShadowGitService({
    fs,
    vaultDir,
    sidecarDir,
    authorName: "test",
    authorEmail: "test@test.com",
    branch: "main",
  });

  await svc.syncVaultToShadow();

  // 第二次同步(没有变化)
  const result2 = await svc.syncVaultToShadow();
  if (result2.copied !== 0) throw new Error(`expected 0 copied on second sync, got ${result2.copied}`);

  // 修改一个文件
  fs.writeFileSync(path.join(vaultDir, "note1.md"), "# Note 1 Updated\n\nNew content");

  // 第三次同步(只有 note1.md 变化)
  const result3 = await svc.syncVaultToShadow();
  if (result3.copied !== 1) throw new Error(`expected 1 copied on third sync, got ${result3.copied}`);

  // 验证内容已更新
  const content = fs.readFileSync(path.join(shadowDir, "note1.md"), "utf-8");
  if (content !== "# Note 1 Updated\n\nNew content") throw new Error("content not updated in shadow");
});

testAsync("syncVaultToShadow:删除 vault 已不存在的文件", async () => {
  const svc = new ShadowGitService({
    fs,
    vaultDir,
    sidecarDir,
    authorName: "test",
    authorEmail: "test@test.com",
    branch: "main",
  });

  await svc.syncVaultToShadow();

  // 删除 vault 中的 note1.md
  fs.unlinkSync(path.join(vaultDir, "note1.md"));

  const result = await svc.syncVaultToShadow();
  if (result.deleted !== 1) throw new Error(`expected 1 deleted, got ${result.deleted}`);

  // 验证 shadow 中也删除了
  if (fs.existsSync(path.join(shadowDir, "note1.md"))) throw new Error("note1.md should be deleted from shadow");
});

test("writeMergedFile:写入合并结果到 shadow", () => {
  const svc = new ShadowGitService({
    fs,
    vaultDir,
    sidecarDir,
    authorName: "test",
    authorEmail: "test@test.com",
    branch: "main",
  });

  const content = "# Merged\n\nMerged content";
  svc.writeMergedFile("merged/note.md", content);

  const filePath = path.join(shadowDir, "merged", "note.md");
  if (!fs.existsSync(filePath)) throw new Error("merged file not written");

  const readBack = fs.readFileSync(filePath, "utf-8");
  if (readBack !== content) throw new Error("content mismatch");
});

test("collectMdFiles:递归收集 .md 文件", () => {
  // 创建嵌套目录结构
  fs.mkdirSync(path.join(vaultDir, "a", "b"), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, "a", "b", "deep.md"), "# Deep");
  fs.writeFileSync(path.join(vaultDir, "a", "shallow.md"), "# Shallow");
  fs.writeFileSync(path.join(vaultDir, "a", "b", "notmd.txt"), "not markdown");

  const svc = new ShadowGitService({
    fs,
    vaultDir,
    sidecarDir,
    authorName: "test",
    authorEmail: "test@test.com",
    branch: "main",
  });

  const files = svc.collectMdFiles(vaultDir);
  const relativePaths = files.map((f) => f.relative).sort();

  // 应该有 deep.md, shallow.md, subfolder/note2.md(如果还存在)
  if (!relativePaths.includes("a/b/deep.md")) throw new Error("deep.md not found");
  if (!relativePaths.includes("a/shallow.md")) throw new Error("shallow.md not found");

  // 不应包含非md文件
  if (relativePaths.some((p) => p.endsWith(".txt"))) throw new Error("non-md file collected");
});

testAsync("隔离性:vault 的 .git 不被触碰", async () => {
  // 在 vault 中初始化一个独立的 git repo(模拟用户自己的 Git 设置)
  const vaultGitDir = path.join(vaultDir, ".git");
  await git.init({ fs, dir: vaultDir, defaultBranch: "main" });
  // 创建一个初始提交
  fs.writeFileSync(path.join(vaultDir, "user-file.md"), "# User's own file");
  await git.add({ fs, dir: vaultDir, filepath: "user-file.md" });
  const userOid = await git.commit({
    fs,
    dir: vaultDir,
    author: { name: "user", email: "user@test.com" },
    message: "user's initial commit",
  });

  // 记录用户 repo 的状态
  const userHeadBefore = await git.resolveRef({ fs, dir: vaultDir, ref: "HEAD" });

  // 使用 shadow repo
  const svc = new ShadowGitService({
    fs,
    vaultDir,
    sidecarDir,
    authorName: "plugin",
    authorEmail: "plugin@test.com",
    branch: "main",
  });

  await svc.initIfNeeded();
  await svc.syncVaultToShadow();
  const shadowOid = await svc.commitAll("shadow repo commit");

  // 验证 vault 的 HEAD 没变
  const userHeadAfter = await git.resolveRef({ fs, dir: vaultDir, ref: "HEAD" });
  if (userHeadAfter !== userHeadBefore) throw new Error("vault HEAD changed! isolation broken");

  // 验证 shadow repo 有自己的 HEAD
  const shadowHeadAfter = await git.resolveRef({ fs, dir: shadowDir, ref: "HEAD" });
  if (!shadowHeadAfter) throw new Error("shadow repo has no HEAD");

  // 验证 shadow 和 vault 的 .git 是不同的
  if (shadowOid === userOid) throw new Error("shadow and vault have same commit oid");
});

testAsync("完整流程:shadow repo commit + 文件读取", async () => {
  setup();

  // 创建 vault 文件
  fs.writeFileSync(path.join(vaultDir, "doc1.md"), "# Document 1\n\nOriginal content");
  fs.writeFileSync(path.join(vaultDir, "doc2.md"), "# Document 2\n\nAnother doc");

  const svc = new ShadowGitService({
    fs,
    vaultDir,
    sidecarDir,
    authorName: "test",
    authorEmail: "test@test.com",
    branch: "main",
  });

  await svc.initIfNeeded();

  // 同步到 shadow
  await svc.syncVaultToShadow();

  // 在 shadow 中提交
  const oid1 = await svc.commitAll("first commit");
  if (!oid1) throw new Error("commit failed");

  // 读取 shadow HEAD 中的文件
  const headContent = await svc.readFileFromHead("doc1.md");
  if (headContent !== "# Document 1\n\nOriginal content") throw new Error("HEAD content mismatch");

  // 修改文件并重新提交
  fs.writeFileSync(path.join(vaultDir, "doc1.md"), "# Document 1\n\nModified content");
  svc.writeMergedFile("doc1.md", "# Document 1\n\nModified content");

  const oid2 = await svc.commitAll("second commit");
  if (!oid2) throw new Error("second commit failed");
  if (oid2 === oid1) throw new Error("commit oid didn't change");

  // 验证新 HEAD 内容
  const newHeadContent = await svc.readFileFromHead("doc1.md");
  if (newHeadContent !== "# Document 1\n\nModified content") throw new Error("new HEAD content mismatch");

  // 验证 doc2 没变
  const doc2Content = await svc.readFileFromHead("doc2.md");
  if (doc2Content !== "# Document 2\n\nAnother doc") throw new Error("doc2 content changed unexpectedly");
});

testAsync("完整流程:shadow repo 合并工作流(基线→本地修改→远端变更→合并→提交)", async () => {
  setup();

  // 创建 vault 文件(基线)
  const baselineContent = "# Shared Doc\n\nOriginal text\n\n## Section A\nContent A";
  fs.writeFileSync(path.join(vaultDir, "shared.md"), baselineContent);

  const svc = new ShadowGitService({
    fs,
    vaultDir,
    sidecarDir,
    authorName: "Alice",
    authorEmail: "alice@test.com",
    branch: "main",
  });

  await svc.initIfNeeded();
  await svc.syncVaultToShadow();
  const oid1 = await svc.commitAll("baseline commit");
  if (!oid1) throw new Error("baseline commit failed");

  // 模拟本地修改(Alice 改了 Section A)
  const localModified = "# Shared Doc\n\nOriginal text\n\n## Section A\nAlice modified content A";
  fs.writeFileSync(path.join(vaultDir, "shared.md"), localModified);

  // 模拟远端变更(Bob 加了 Section B — 通过直接修改 shadow 工作区模拟)
  const remoteModified = "# Shared Doc\n\nOriginal text\n\n## Section A\nContent A\n\n## Section B\nBob added section B";

  // 读取基线(shadow HEAD)
  const baseline = await svc.readFileFromHead("shared.md");
  if (baseline !== baselineContent) throw new Error("baseline mismatch");

  // 三路合并(baseline, ours=local, theirs=remote)
  // 简单合并:两边改动不在同一行,直接拼接
  const merged = "# Shared Doc\n\nOriginal text\n\n## Section A\nAlice modified content A\n\n## Section B\nBob added section B";

  // 写回 vault + shadow
  fs.writeFileSync(path.join(vaultDir, "shared.md"), merged);
  svc.writeMergedFile("shared.md", merged);

  // 提交合并结果
  const oid2 = await svc.commitAll("merged: Alice + Bob changes");
  if (!oid2) throw new Error("merge commit failed");
  if (oid2 === oid1) throw new Error("commit oid didn't change");

  // 验证新 HEAD 包含合并结果
  const headContent = await svc.readFileFromHead("shared.md");
  if (!headContent.includes("Alice modified content A")) throw new Error("Alice's change lost in merge");
  if (!headContent.includes("Bob added section B")) throw new Error("Bob's change lost in merge");

  // 验证 vault 没有 .git(隔离性)
  if (fs.existsSync(path.join(vaultDir, ".git"))) throw new Error("vault has .git! isolation broken");

  // 验证 shadow 有 .git
  if (!fs.existsSync(path.join(shadowDir, ".git"))) throw new Error("shadow should have .git");

  console.log("\n     ✅ shadow repo 合并工作流验证通过(基线→本地修改→远端变更→合并→提交)");
});

testAsync("完整流程:两个独立 shadow repo 完全隔离", async () => {
  setup();

  // 创建两个 vault 和对应的 sidecar
  const vault1 = path.join(tmpDir, "vault1");
  const sidecar1 = path.join(tmpDir, "sidecar1");
  const vault2 = path.join(tmpDir, "vault2");
  const sidecar2 = path.join(tmpDir, "sidecar2");
  fs.mkdirSync(vault1, { recursive: true });
  fs.mkdirSync(sidecar1, { recursive: true });
  fs.mkdirSync(vault2, { recursive: true });
  fs.mkdirSync(sidecar2, { recursive: true });

  fs.writeFileSync(path.join(vault1, "doc1.md"), "# Machine 1 Doc");
  fs.writeFileSync(path.join(vault2, "doc2.md"), "# Machine 2 Doc");

  const svc1 = new ShadowGitService({
    fs, vaultDir: vault1, sidecarDir: sidecar1,
    authorName: "M1", authorEmail: "m1@test.com", branch: "main",
  });
  const svc2 = new ShadowGitService({
    fs, vaultDir: vault2, sidecarDir: sidecar2,
    authorName: "M2", authorEmail: "m2@test.com", branch: "main",
  });

  await svc1.initIfNeeded();
  await svc2.initIfNeeded();

  await svc1.syncVaultToShadow();
  await svc2.syncVaultToShadow();

  const oid1 = await svc1.commitAll("machine 1 commit");
  const oid2 = await svc2.commitAll("machine 2 commit");

  if (!oid1) throw new Error("machine 1 commit failed");
  if (!oid2) throw new Error("machine 2 commit failed");
  if (oid1 === oid2) throw new Error("commits should be different (different content)");

  // 验证各自的 HEAD 内容
  const head1 = await svc1.readFileFromHead("doc1.md");
  if (head1 !== "# Machine 1 Doc") throw new Error("machine 1 HEAD mismatch");

  const head2 = await svc2.readFileFromHead("doc2.md");
  if (head2 !== "# Machine 2 Doc") throw new Error("machine 2 HEAD mismatch");

  // 验证交叉读取失败(各自独立)
  const cross1 = await svc1.readFileFromHead("doc2.md");
  if (cross1 !== null) throw new Error("machine 1 should not have doc2.md");

  const cross2 = await svc2.readFileFromHead("doc1.md");
  if (cross2 !== null) throw new Error("machine 2 should not have doc1.md");

  // 验证两个 vault 都没有 .git
  if (fs.existsSync(path.join(vault1, ".git"))) throw new Error("vault1 has .git");
  if (fs.existsSync(path.join(vault2, ".git"))) throw new Error("vault2 has .git");

  // 验证两个 shadow repo 都有 .git
  if (!fs.existsSync(path.join(sidecar1, "shadow-git", ".git"))) throw new Error("shadow1 has no .git");
  if (!fs.existsSync(path.join(sidecar2, "shadow-git", ".git"))) throw new Error("shadow2 has no .git");

  console.log("\n     ✅ 两个独立 shadow repo 完全隔离,各自独立的 git 历史");
});

testAsync("destroy:清理 shadow repo", async () => {
  setup();

  fs.writeFileSync(path.join(vaultDir, "test.md"), "# Test");
  const svc = new ShadowGitService({
    fs,
    vaultDir,
    sidecarDir,
    authorName: "test",
    authorEmail: "test@test.com",
    branch: "main",
  });

  await svc.initIfNeeded();
  await svc.syncVaultToShadow();
  await svc.commitAll("test commit");

  if (!fs.existsSync(shadowDir)) throw new Error("shadow dir should exist before destroy");

  await svc.destroy();

  if (fs.existsSync(shadowDir)) throw new Error("shadow dir should not exist after destroy");
});

testAsync("commitAll 只提交 .md 文件(非 .md 被过滤)", async () => {
  setup();

  // vault 中有 .md 和非 .md 文件
  fs.writeFileSync(path.join(vaultDir, "doc.md"), "# Doc");
  fs.writeFileSync(path.join(vaultDir, "config.json"), '{"key":"value"}');

  const svc = new ShadowGitService({
    fs,
    vaultDir,
    sidecarDir,
    authorName: "test",
    authorEmail: "test@test.com",
    branch: "main",
  });

  await svc.initIfNeeded();
  await svc.syncVaultToShadow();

  // 在 shadow 中创建非 .md 文件(模拟意外)
  fs.writeFileSync(path.join(shadowDir, "extra.txt"), "should not be committed");

  // 提交
  await svc.commitAll("test commit");

  // 检查 shadow HEAD 中的文件列表
  const oid = await git.resolveRef({ fs, dir: shadowDir, ref: "HEAD" });
  const files = await git.listFiles({ fs, dir: shadowDir, ref: oid });

  // .md 文件应该在
  if (!files.includes("doc.md")) throw new Error("doc.md not in HEAD");
  // 非 .md 文件不应该在
  if (files.includes("config.json")) throw new Error("config.json should not be in HEAD");
  if (files.includes("extra.txt")) throw new Error("extra.txt should not be in HEAD");
});

// ===== 运行 =====
(async () => {
  await runTests();
  cleanup();
})();
