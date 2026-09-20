// revise.mjs 端到端离线测试:本地裸仓库当远端 + 假 gh(回放 review 评论与线程)+ 本机 mock 大模型。
// 覆盖:一次 review 多条意见 → 一次调模型、一个提交、逐线程回复并解决;推送被另一次运行抢先 → 变基重试成功;
// 同一处冲突 → 如实回帖「推送失败」;回帖被拒(403)也不静默;没有待处理意见 → 不调模型;老 workflow 的单条模式照常工作。
// 跑:node --test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFakeBin, startMockLLM, gitIn, put, runNode, readLog } from "./fakes.mjs";

const REVISE = fileURLToPath(new URL("../scripts/revise.mjs", import.meta.url));
const BRANCH = "docs/plan-12";
const ZH = "# 内存缓存 Cache\n\n### `get(key)`\n\n读取。\n\n### `size()`\n\n返回数量。\n";
const EN = "# Cache\n\n### `get(key)`\n\nReads.\n\n### `size()`\n\nReturns the count.\n";

let llm;
let beforeReviseReply = () => {}; // 用例在「模型返回之前」插入动作,模拟另一次运行抢先推送
before(async () => {
  llm = await startMockLLM((body) => {
    if (body.model === "bad-x") return { status: 400 }; // 模型接口报错(4xx 不重试)
    if (body.model === "revise-x") {
      beforeReviseReply();
      return {
        content: JSON.stringify({
          edits: [
            { path: "docs/zh/cache.md", old_string: "读取。", new_string: "读取指定键,不存在时返回 undefined。" },
            { path: "docs/zh/cache.md", old_string: "返回数量。", new_string: "返回条目数。" },
          ],
        }),
      };
    }
    if (body.model === "sync-x")
      return {
        content: JSON.stringify({
          edits: [
            { old_string: "Reads.", new_string: "Reads the value for a key; returns undefined if absent." },
            { old_string: "Returns the count.", new_string: "Returns the number of entries." },
          ],
        }),
      };
    if (body.model === "qa-truncated-x") return { content: "- **[Minor] ", finish: "length" };
    return { content: "译文质检:通过" };
  });
});
after(() => llm.close());

const COMMENTS = [
  { id: 90, user: { login: "rui", type: "User" }, path: "docs/zh/cache.md", line: 1, created_at: "2026-09-14T09:00:00Z", body: "旧意见,已处理过" },
  { id: 91, in_reply_to_id: 90, user: { login: "github-actions[bot]", type: "Bot" }, path: "docs/zh/cache.md", created_at: "2026-09-14T09:05:00Z", body: "Done in abc1234 ✅" },
  { id: 101, pull_request_review_id: 500, user: { login: "rui", type: "User" }, path: "docs/zh/cache.md", line: 5, created_at: "2026-09-15T10:00:01Z", body: "get 的说明补上键不存在时的返回值" },
  { id: 102, pull_request_review_id: 500, user: { login: "rui", type: "User" }, path: "docs/zh/cache.md", line: 9, created_at: "2026-09-15T10:00:02Z", body: "size 改成「条目数」" },
  { id: 103, pull_request_review_id: 500, user: { login: "rui", type: "User" }, path: "docs/zh/cache.md", line: 9, created_at: "2026-09-15T10:00:03Z", body: "/skip 这条是指令" },
];
const THREADS = {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: [
            { id: "T90", isResolved: true, comments: { nodes: [{ databaseId: 90 }, { databaseId: 91 }] } },
            { id: "T101", isResolved: false, comments: { nodes: [{ databaseId: 101 }] } },
            { id: "T102", isResolved: false, comments: { nodes: [{ databaseId: 102 }] } },
            { id: "T103", isResolved: false, comments: { nodes: [{ databaseId: 103 }] } },
          ],
        },
      },
    },
  },
};
const rules = (comments = COMMENTS) =>
  JSON.stringify([
    ["resolveReviewThread", "{}"],
    ["^api graphql .*reviewThreads", JSON.stringify(THREADS)],
    ["pulls/9/comments\\?per_page=100$", JSON.stringify([comments])],
  ]);

// 每个用例一套:remote.git + 本次运行的克隆 repo(在文档分支上)+ 另一次运行的克隆 other
function setup() {
  const root = mkdtempSync(join(tmpdir(), "doc-agent-revise-"));
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  const other = join(root, "other");
  const bin = join(root, "bin");
  writeFakeBin(bin);
  gitIn(root, "init", "-q", "--bare", "-b", "main", remote);
  gitIn(root, "clone", "-q", remote, repo);
  gitIn(repo, "config", "user.email", "t@example.com");
  gitIn(repo, "config", "user.name", "t");
  gitIn(repo, "symbolic-ref", "HEAD", `refs/heads/${BRANCH}`);
  put(repo, "docs/zh/cache.md", ZH);
  put(repo, "docs/en/cache.md", EN);
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-qm", "docs: init");
  gitIn(repo, "push", "-q", "-u", "origin", BRANCH);
  gitIn(root, "clone", "-q", "-b", BRANCH, remote, other);
  gitIn(other, "config", "user.email", "o@example.com");
  gitIn(other, "config", "user.name", "other");
  return { root, remote, repo, other, bin };
}

let runs = 0;
function runRevise(ctx, env = {}) {
  const log = join(ctx.root, `gh-${++runs}.log`);
  const seen = llm.requests.length;
  return runNode(REVISE, {
    cwd: ctx.repo,
    env: {
      ...process.env,
      PATH: `${ctx.bin}:${process.env.PATH}`,
      TMPDIR: ctx.root,
      FAKE_GH_LOG: log,
      FAKE_GH_RULES: rules(),
      GITHUB_REPOSITORY: "o/r",
      PR_NUMBER: "9",
      REVIEW_ID: "500",
      LLM_API_KEY: "test-key",
      LLM_BASE_URL: llm.url,
      LLM_MODEL: "strong-x",
      LLM_MODEL_REVISE: "revise-x",
      LLM_MODEL_SYNC: "sync-x",
      LLM_FAST_MODEL: "fast-x",
      ...env,
    },
  }).then((r) => ({ ...r, gh: readLog(log), llm: llm.requests.slice(seen) }));
}

test("revise 批量:一次 review 两条意见 → 一次调模型、一个提交;推送被另一次运行抢先 → 变基重试成功;逐线程回复并解决", async () => {
  const ctx = setup();
  beforeReviseReply = () => {
    put(ctx.other, "docs/zh/other.md", "# 另一篇\n");
    gitIn(ctx.other, "add", "-A");
    gitIn(ctx.other, "commit", "-qm", "docs: 另一次运行的提交");
    gitIn(ctx.other, "push", "-q", "origin", BRANCH);
  };
  const r = await runRevise(ctx);
  beforeReviseReply = () => {};
  assert.equal(r.code, 0, r.stderr);

  const revise = r.llm.filter((b) => b.model === "revise-x");
  assert.equal(revise.length, 1); // 两条意见一次处理
  const user = revise[0].messages[1].content;
  assert.match(user, /reviewer 留了 2 条待处理意见/);
  assert.match(user, /get 的说明补上键不存在时的返回值/);
  assert.match(user, /size 改成「条目数」/);
  assert.doesNotMatch(user, /旧意见|\/skip/);
  assert.match(r.stdout, /推送 docs\/plan-12 被拒.*拉取变基后重试/);

  // 远端:另一次运行的提交在下,本次一个提交在上,同时含中文两处改动与英文同步
  assert.deepEqual(gitIn(ctx.remote, "log", "--format=%s", BRANCH).split("\n"), [
    "docs: address review comments",
    "docs: 另一次运行的提交",
    "docs: init",
  ]);
  assert.deepEqual(gitIn(ctx.remote, "show", "--name-only", "--format=", BRANCH).split("\n").filter(Boolean).sort(), [
    "docs/en/cache.md",
    "docs/zh/cache.md",
  ]);
  const zh = gitIn(ctx.remote, "show", `${BRANCH}:docs/zh/cache.md`);
  assert.match(zh, /读取指定键,不存在时返回 undefined。/);
  assert.match(zh, /返回条目数。/);
  assert.match(gitIn(ctx.remote, "show", `${BRANCH}:docs/en/cache.md`), /Returns the number of entries\./);

  // 101、102 各回一条(sha = 远端最新提交,带标记),解决 T101 / T102;不碰已处理的 90 与指令 103
  const head = gitIn(ctx.remote, "rev-parse", BRANCH);
  for (const id of [101, 102]) {
    const m = r.gh.match(new RegExp(`comments/${id}/replies -F body=@\\S+\\nDone in ([0-9a-f]+) ✅\\n\\n<!-- doc-agent:reply -->`));
    assert.ok(m, `缺少对 ${id} 的回复`);
    assert.ok(head.startsWith(m[1]));
  }
  assert.doesNotMatch(r.gh, /comments\/(90|103)\/replies/);
  assert.match(r.gh, /-f id=T101/);
  assert.match(r.gh, /-f id=T102/);
  assert.doesNotMatch(r.gh, /-f id=T(90|103)\b/);
});

test("revise 批量:意见都已答复或是指令 → 不调模型、不提交,退出 0", async () => {
  const ctx = setup();
  const r = await runRevise(ctx, { FAKE_GH_RULES: rules([COMMENTS[0], COMMENTS[1], COMMENTS[4]]) });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /没有待处理的行内 review 意见/);
  assert.equal(r.llm.length, 0);
  assert.equal(gitIn(ctx.remote, "log", "-1", "--format=%s", BRANCH), "docs: init");
  assert.doesNotMatch(r.gh, /replies/);
});

test("revise 批量:另一次运行改了同一处 → 变基冲突,在每个待处理线程下回帖「推送失败」并失败退出,不留半截变基", async () => {
  const ctx = setup();
  beforeReviseReply = () => {
    put(ctx.other, "docs/zh/cache.md", ZH.replace("读取。", "读取(另一次运行改的)。"));
    gitIn(ctx.other, "commit", "-qam", "docs: 另一次运行改了同一处");
    gitIn(ctx.other, "push", "-q", "origin", BRANCH);
  };
  const r = await runRevise(ctx);
  beforeReviseReply = () => {};
  assert.equal(r.code, 1);
  assert.match(r.gh, /comments\/101\/replies -F body=@\S+\n⚠️ 按这条评论返工失败\(原因类别:\*\*推送失败\*\*\)/);
  assert.match(r.gh, /comments\/102\/replies -F body=@\S+\n⚠️ 按这条评论返工失败/);
  assert.doesNotMatch(r.gh, /Done in/);
  assert.equal(gitIn(ctx.remote, "log", "-1", "--format=%s", BRANCH), "docs: 另一次运行改了同一处");
  assert.ok(!existsSync(join(ctx.repo, ".git", "rebase-merge")) && !existsSync(join(ctx.repo, ".git", "rebase-apply")));
});

test("revise 批量:线程回帖与 PR 回帖都被拒(HTTP 403)→ 不静默:日志与 Step Summary 写明原因类别 + pull-requests: write 权限提示,仍失败退出", async () => {
  const ctx = setup();
  const summary = join(ctx.root, "summary.md");
  const denied = "gh: Resource not accessible by integration (HTTP 403)\n";
  const r = await runRevise(ctx, {
    LLM_MODEL_REVISE: "bad-x",
    GITHUB_STEP_SUMMARY: summary,
    FAKE_GH_RULES: JSON.stringify([["/replies ", denied, 1], ["^pr comment 9", denied, 1], ...JSON.parse(rules())]),
  });
  assert.equal(r.code, 1);
  assert.match(r.gh, /comments\/101\/replies/);
  assert.match(r.gh, /comments\/102\/replies/);
  assert.match(r.gh, /pr comment 9 --body-file/); // 线程一条都没回上 → 退到 PR 下回帖
  const hint = "无法在 PR #9 下回帖:Resource not accessible by integration (HTTP 403),请检查 workflow 的 pull-requests: write 权限";
  assert.ok(r.stderr.includes(hint), r.stderr);
  assert.ok(readLog(summary).includes(`(本次失败原因类别:**模型接口报错**)——${hint}`));
});

test("revise 批量:译文质检失败 → 不吞掉,PR 下回帖「译文质检未完成」;文档审核只查本次改到的两篇;返工仍判成功", async () => {
  const ctx = setup();
  const summary = join(ctx.root, "summary.md");
  const r = await runRevise(ctx, { GITHUB_STEP_SUMMARY: summary, LLM_MODEL_QA: "qa-truncated-x" });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.gh, /comments\/101\/replies -F body=@\S+\nDone in [0-9a-f]+ ✅/); // 返工本身照常完成
  assert.match(r.gh, /pr comment 9 --body-file \S+\n⚠️ 译文质检未完成\(原因类别:\*\*模型输出被截断\*\*\)/);
  assert.doesNotMatch(r.gh, /🌐 \*\*译文质检\*\*/);
  assert.match(readLog(summary), /译文质检未完成\(原因类别:\*\*模型输出被截断\*\*\)/);
  assert.match(r.stdout, /文档审核:只查本次改动的 2 个文档/);
});

test("revise 单条(老 workflow 的 pull_request_review_comment 触发):只处理触发的那条,沿用历史提交说明", async () => {
  const ctx = setup();
  const r = await runRevise(ctx, {
    REVIEW_ID: "",
    COMMENT_ID: "102",
    COMMENT_PATH: "docs/zh/cache.md",
    COMMENT_LINE: "9",
    COMMENT_BODY: "size 改成「条目数」",
  });
  assert.equal(r.code, 0, r.stderr);
  const user = r.llm.find((b) => b.model === "revise-x").messages[1].content;
  assert.match(user, /reviewer 留了 1 条待处理意见/);
  assert.doesNotMatch(user, /get 的说明/);
  assert.doesNotMatch(r.gh, /pulls\/9\/comments\?per_page/); // 单条模式不拉评论列表
  assert.equal(gitIn(ctx.remote, "log", "-1", "--format=%B", BRANCH), "docs: address review comment\n\nReply to review comment 102.");
  assert.match(r.gh, /comments\/102\/replies -F body=@\S+\nDone in [0-9a-f]+ ✅/);
  assert.match(r.gh, /-f id=T102/);
});
