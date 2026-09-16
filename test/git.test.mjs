// 显式 add 提交与「推送被拒 → 变基重试」的离线测试:本地裸仓库当远端,两个克隆模拟两次并发运行。零网络。
// 跑:node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { gitIn, put } from "./fakes.mjs";
import { commitPaths, pushWithRebase, currentBranch } from "../scripts/git.mjs";
import { classifyError } from "../scripts/errors.mjs";

const ZH = "# 缓存\n\n读取。\n\n## 大小\n\n返回数量。\n";
const inRepo = (dir) => (args) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const quiet = { log: () => {}, sleep: () => {} };

// 每个用例一套:remote.git + 克隆 a(先推一个初始提交)+ 克隆 b
function setup() {
  const root = mkdtempSync(join(tmpdir(), "doc-agent-git-"));
  const remote = join(root, "remote.git");
  gitIn(root, "init", "-q", "--bare", "-b", "main", remote);
  const clone = (name) => {
    const dir = join(root, name);
    gitIn(root, "clone", "-q", remote, dir);
    gitIn(dir, "config", "user.email", `${name}@example.com`);
    gitIn(dir, "config", "user.name", name);
    return dir;
  };
  const a = clone("a");
  gitIn(a, "symbolic-ref", "HEAD", "refs/heads/main");
  put(a, "docs/zh/cache.md", ZH);
  gitIn(a, "add", "-A");
  gitIn(a, "commit", "-qm", "init");
  gitIn(a, "push", "-q", "origin", "HEAD:refs/heads/main");
  const b = clone("b");
  return { remote, a, b };
}
// 在克隆 dir 上改一个文件并推送(模拟另一次运行先推)
function otherRunPushes(dir, path, text, msg) {
  put(dir, path, text);
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-qm", msg);
  gitIn(dir, "push", "-q", "origin", "HEAD:refs/heads/main");
}

test("commitPaths:只提交给定路径,新建的未跟踪文件也进提交(commit -a 做不到);无改动时报错", () => {
  const { a } = setup();
  put(a, "docs/zh/guide/new.md", "# 新文档\n");
  put(a, "docs/en/guide/new.md", "# New\n");
  put(a, "docs/zh/cache.md", ZH.replace("读取。", "读取指定键。"));
  put(a, "notes.txt", "没点名的未跟踪文件\n");
  const paths = ["docs/zh/cache.md", "docs/zh/guide/new.md", "docs/en/guide/new.md", "docs/zh/cache.md"];
  assert.match(commitPaths(paths, ["docs: 标题", "正文段"], { git: inRepo(a) }), /^[0-9a-f]{7,}$/);
  assert.deepEqual(gitIn(a, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort(), [
    "docs/en/guide/new.md",
    "docs/zh/cache.md",
    "docs/zh/guide/new.md",
  ]);
  assert.equal(gitIn(a, "log", "-1", "--format=%B"), "docs: 标题\n\n正文段");
  assert.match(gitIn(a, "status", "--porcelain"), /\?\? notes\.txt/); // 没点名的不碰
  assert.throws(() => commitPaths(["docs/zh/cache.md"], "x", { git: inRepo(a) }), /没有可提交的改动/);
  assert.equal(currentBranch({ git: inRepo(a) }), "main");
});

test("pushWithRebase:远端已被另一次运行更新(改的是别处)→ 拉取变基后重试成功,两边改动都在", () => {
  const { remote, a, b } = setup();
  otherRunPushes(b, "docs/zh/other.md", "# 另一篇\n", "other run");
  put(a, "docs/zh/cache.md", ZH.replace("读取。", "读取指定键。"));
  commitPaths(["docs/zh/cache.md"], "this run", { git: inRepo(a) });
  const logs = [];
  assert.equal(pushWithRebase("main", { git: inRepo(a), log: (m) => logs.push(m), sleep: () => {} }), 2);
  assert.match(logs.join("\n"), /推送 main 被拒.*拉取变基后重试/);
  assert.deepEqual(gitIn(remote, "log", "--format=%s", "main").split("\n"), ["this run", "other run", "init"]);
});

test("pushWithRebase:同一处被另一次运行改过 → 变基冲突,abort 还原后抛 PushError(归类「推送失败」)", () => {
  const { remote, a, b } = setup();
  otherRunPushes(b, "docs/zh/cache.md", ZH.replace("读取。", "读取(另一次运行)。"), "other run");
  put(a, "docs/zh/cache.md", ZH.replace("读取。", "读取(本次运行)。"));
  commitPaths(["docs/zh/cache.md"], "this run", { git: inRepo(a) });
  assert.throws(
    () => pushWithRebase("main", { git: inRepo(a), ...quiet }),
    (e) => e.code === "DOC_AGENT_PUSH" && classifyError(e).label === "推送失败" && /变基时失败/.test(e.message)
  );
  assert.ok(!existsSync(join(a, ".git", "rebase-merge")) && !existsSync(join(a, ".git", "rebase-apply")));
  assert.equal(gitIn(a, "log", "-1", "--format=%s"), "this run");
  assert.equal(gitIn(remote, "log", "-1", "--format=%s", "main"), "other run");
});

test("pushWithRebase:一直被拒 → 最多尝试 3 次后抛错;鉴权等非被拒、非网络的错误不重试", () => {
  const calls = [];
  const alwaysRejected = (args) => {
    calls.push(args[0]);
    if (args[0] !== "push") return "";
    const e = new Error("Command failed: git push");
    e.stderr = " ! [rejected]        HEAD -> main (fetch first)\nerror: failed to push some refs";
    throw e;
  };
  assert.throws(() => pushWithRebase("main", { git: alwaysRejected, ...quiet }), /远端分支已被其他运行更新,已尝试 3 次/);
  assert.deepEqual(calls, ["push", "pull", "push", "pull", "push"]);

  let n = 0;
  const denied = () => {
    n++;
    const e = new Error("Command failed: git push");
    e.stderr = "remote: Permission to o/r.git denied to docs-bot.\nfatal: unable to access";
    throw e;
  };
  assert.throws(() => pushWithRebase("main", { git: denied, ...quiet }), (e) => e.code === "DOC_AGENT_PUSH" && /unable to access/.test(e.message));
  assert.equal(n, 1);
});
