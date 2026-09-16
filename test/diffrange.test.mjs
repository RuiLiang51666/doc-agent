// 取 diff 区间的离线单测:临时 git 仓库里分别造 merge / squash / rebase 三种合并(PR 都是两个提交,
// 且目标分支在 PR 期间合进了别人的改动),注入假的 GitHub 数据。纯本地,零网络。
// 跑:node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitIn, put } from "./fakes.mjs";
import { resolveDiffRange, changedFiles, describeRange } from "../scripts/diff.mjs";

const repo = mkdtempSync(join(tmpdir(), "doc-agent-range-"));
process.chdir(repo); // diff.mjs 在当前目录跑 git
const g = (...a) => gitIn(repo, ...a);
g("init", "-q", "-b", "main");
g("config", "user.email", "t@example.com");
g("config", "user.name", "t");
put(repo, "src/a.js", "a1\n");
put(repo, "src/b.js", "b1\n");
g("add", "-A");
g("commit", "-qm", "init");
const B0 = g("rev-parse", "HEAD");

// PR 分支:两个提交
g("checkout", "-q", "-b", "feature");
put(repo, "src/a.js", "a2\n");
g("commit", "-qam", "feat: a");
put(repo, "src/b.js", "b2\n");
g("commit", "-qam", "feat: b");
const F = g("rev-list", "--reverse", `${B0}..feature`).split("\n");

// 目标分支在 PR 期间合进了别人的改动,再按三种方式合并
const otherWork = (branch) => {
  g("checkout", "-q", "-b", branch, B0);
  put(repo, "src/other.js", `${branch}\n`);
  g("add", "-A");
  g("commit", "-qm", `other work on ${branch}`);
};
otherWork("m");
g("merge", "-q", "--no-ff", "-m", "Merge pull request #7 from feature", "feature");
const M_MERGE = g("rev-parse", "HEAD");
otherWork("s");
g("merge", "-q", "--squash", "feature");
g("commit", "-qm", "feat: a and b (#7)");
const M_SQUASH = g("rev-parse", "HEAD");
otherWork("r");
g("cherry-pick", F[0], F[1]); // 与 GitHub rebase 合并一样:逐个重放,保留提交说明与作者时间
const M_REBASE = g("rev-parse", "HEAD");

const meta = (sha) => {
  const [date, ...msg] = g("log", "-1", "--format=%aI%n%B", sha).split("\n");
  return { sha, commit: { message: msg.join("\n").trim(), author: { date } } };
};
const PR_COMMITS = F.map(meta);
const FILES = [{ filename: "src/a.js" }, { filename: "src/b.js" }];
const api = ({ pr = {}, files = FILES } = {}) => ({
  get: () => ({ number: 7, commits: 2, ...pr }),
  list: (p) => (p.includes("/commits") ? PR_COMMITS : files),
});
const run = (sha, a) => {
  const logs = [];
  const range = resolveDiffRange({ sha, prNumber: 7, repo: "o/r", api: a, log: (m) => logs.push(m) });
  return { range, files: changedFiles(range).sort(), logs: logs.join("\n") };
};

test("resolveDiffRange:rebase 合并 → M~k..M,含 PR 全部提交;旧口径 M^1 只剩最后一个提交", () => {
  const { range, files, logs } = run(M_REBASE, api());
  assert.equal(range.how, "rebase");
  assert.equal(range.base, `${M_REBASE}~2`);
  assert.deepEqual(files, ["src/a.js", "src/b.js"]);
  assert.match(logs, /与 GitHub PR 文件列表一致/);
  assert.deepEqual(changedFiles({ base: `${M_REBASE}^1`, head: M_REBASE }), ["src/b.js"]); // 旧口径漏掉 a.js
  assert.match(describeRange(range), /^rebase 合并:[0-9a-f]{12}~2\.\.[0-9a-f]{12}$/);
});

test("resolveDiffRange:squash 合并(PR 有 2 个提交)不被误判为 rebase → M^1..M,不含别人的改动", () => {
  const { range, files } = run(M_SQUASH, api());
  assert.equal(range.how, "squash");
  assert.equal(range.base, `${M_SQUASH}^1`);
  assert.deepEqual(files, ["src/a.js", "src/b.js"]);
  assert.equal(run(M_SQUASH, api({ pr: { commits: 1 } })).range.how, "squash"); // 单提交 PR 不必查提交列表
});

test("resolveDiffRange:merge 合并(两个父)→ M^1..M,不含目标分支上别人的改动", () => {
  const { range, files } = run(M_MERGE, api());
  assert.equal(range.how, "merge");
  assert.deepEqual(files, ["src/a.js", "src/b.js"]);
});

test("resolveDiffRange:拿不到 GitHub 数据 → 退回 M^1 并写明原因;本地区间与 GitHub 文件列表对不上 → 警告", () => {
  const offline = run(M_REBASE, {
    get: () => {
      throw new Error("gh: Not Found (HTTP 404)");
    },
    list: () => [],
  });
  assert.equal(offline.range.how, "fallback");
  assert.equal(offline.range.base, `${M_REBASE}^1`);
  assert.match(offline.logs, /读取 GitHub 上 PR #7 失败\(gh: Not Found \(HTTP 404\)\);退回 .*rebase 合并下只含 PR 的最后一个提交/);

  const logs = [];
  assert.equal(resolveDiffRange({ sha: M_SQUASH, prNumber: "", repo: "", log: (m) => logs.push(m) }).how, "fallback");
  assert.match(logs.join("\n"), /没有仓库名或 PR 号/);

  const mismatch = run(M_SQUASH, api({ files: [{ filename: "src/a.js" }] }));
  assert.match(mismatch.logs, /警告:.*不一致;只在本地:src\/b\.js;只在 GitHub:无/);
});
