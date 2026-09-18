// draft.mjs 端到端离线测试:本地裸仓库当远端 + 假 gh + 本机 mock 大模型。
// 覆盖:计划含新建文档 → 新建的中文文档与新生成的英文译文都进提交并推送;取 diff 按 rebase 合并口径含 PR 全部提交;
// 模型要在源文档目录外新建 → 拒绝落盘,在计划 Issue 下回帖「模型输出校验失败」,不推送、不建 PR;回帖被拒(403)也不静默;
// 本阶段模型用量逐次打日志、合计写进 Step Summary。
// 跑:node --test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFakeBin, startMockLLM, gitIn, put, runNode, readLog } from "./fakes.mjs";
import { embedContract } from "../scripts/contract.mjs";

const DRAFT = fileURLToPath(new URL("../scripts/draft.mjs", import.meta.url));

let llm;
let draftReply;
before(async () => {
  // 用量:翻译(translate-x)故意不返回 usage,验「接口未返回」的汇总加注
  const usage = (p, c) => ({ prompt_tokens: p, completion_tokens: c, total_tokens: p + c });
  llm = await startMockLLM((body) => {
    if (body.model === "draft-x") return { content: JSON.stringify(draftReply), usage: usage(3000, 200) };
    if (body.model === "sync-x")
      return {
        content: JSON.stringify({
          edits: [{ old_string: "Reads.", new_string: "Reads. Supports TTL; see [Expiration](guide/ttl.md)." }],
        }),
        usage: usage(1000, 50),
      };
    if (body.model === "translate-x") return { content: "# Expiration\n\nSet a TTL with `setTtl(ms)`." };
    return { content: "译文质检:通过", usage: usage(2000, 100) };
  });
});
after(() => llm.close());

// remote.git + 克隆 repo(main 上:初始提交 + 源 PR #7 以 rebase 合并落下的两个提交)
function setup() {
  const root = mkdtempSync(join(tmpdir(), "doc-agent-draft-"));
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  writeFakeBin(bin);
  gitIn(root, "init", "-q", "--bare", "-b", "main", remote);
  gitIn(root, "clone", "-q", remote, repo);
  gitIn(repo, "config", "user.email", "t@example.com");
  gitIn(repo, "config", "user.name", "t");
  gitIn(repo, "symbolic-ref", "HEAD", "refs/heads/main");
  put(repo, "src/cache.js", "export class Cache {}\n");
  put(repo, "docs/zh/cache.md", "# 缓存\n\n读取。\n");
  put(repo, "docs/en/cache.md", "# Cache\n\nReads.\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-qm", "init");
  put(repo, "src/cache.js", "export class Cache {\n  setTtl(ms) {}\n}\n");
  gitIn(repo, "commit", "-qam", "feat: setTtl()");
  const c1 = gitIn(repo, "rev-parse", "HEAD");
  put(repo, "src/ttl.js", "export const DEFAULT_TTL_MS = 0;\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-qm", "feat: DEFAULT_TTL_MS");
  const c2 = gitIn(repo, "rev-parse", "HEAD");
  gitIn(repo, "push", "-q", "-u", "origin", "main");
  const meta = (sha) => {
    const [date, ...msg] = gitIn(repo, "log", "-1", "--format=%aI%n%B", sha).split("\n");
    return { commit: { message: msg.join("\n").trim(), author: { date } } };
  };
  return { root, remote, repo, bin, c2, commits: [meta(c1), meta(c2)] };
}

const items = [
  { file: "docs/zh/cache.md", change: "补充 TTL 说明" },
  { file: "docs/zh/guide/ttl.md", change: "新建过期策略文档", create: true },
];
const issueBody = (ctx) =>
  `源代码变更:#7 @ ${ctx.c2}\n\n**必须更新**\n- [ ] \`docs/zh/cache.md\` — 补充 TTL 说明\n- [ ] \`docs/zh/guide/ttl.md\`(新建) — 新建过期策略文档\n\n` +
  embedContract("plan", { sourcePr: 7, mergeSha: ctx.c2, items, skipped: [] });
const rules = (ctx) =>
  JSON.stringify([
    ["^pr list --head docs/plan-12", "0"],
    ["^repo view", "main"],
    ["^pr view 7 --json title", "feat: TTL"],
    ["^issue view 12 --json title", "📝 docs: 记录 TTL 配置 (#7)"],
    ["^pr create", "https://github.com/o/r/pull/13\n"],
    ["^api repos/o/r/pulls/7$", JSON.stringify({ number: 7, commits: 2, merge_commit_sha: ctx.c2 })],
    ["^api --paginate --slurp repos/o/r/pulls/7/commits\\?per_page=100$", JSON.stringify([ctx.commits])],
    ["^api --paginate --slurp repos/o/r/pulls/7/files\\?per_page=100$", JSON.stringify([[{ filename: "src/cache.js" }, { filename: "src/ttl.js" }]])],
  ]);

function runDraft(ctx, env = {}) {
  const log = join(ctx.root, "gh.log");
  const seen = llm.requests.length;
  return runNode(DRAFT, {
    cwd: ctx.repo,
    env: {
      ...process.env,
      PATH: `${ctx.bin}:${process.env.PATH}`,
      TMPDIR: ctx.root,
      FAKE_GH_LOG: log,
      FAKE_GH_RULES: rules(ctx),
      GITHUB_REPOSITORY: "o/r",
      ISSUE_NUMBER: "12",
      ISSUE_BODY: issueBody(ctx),
      LLM_API_KEY: "test-key",
      LLM_BASE_URL: llm.url,
      LLM_MODEL: "strong-x",
      LLM_MODEL_DRAFT: "draft-x",
      LLM_MODEL_SYNC: "sync-x",
      LLM_MODEL_TRANSLATE: "translate-x",
      LLM_FAST_MODEL: "fast-x",
      ...env,
    },
  }).then((r) => ({ ...r, gh: readLog(log), llm: llm.requests.slice(seen) }));
}

test("draft:计划含新建文档 → 新建中文文档与新生成的英文译文都进提交并推送;diff 按 rebase 合并口径含 PR 全部提交", async () => {
  const ctx = setup();
  draftReply = {
    edits: [
      { path: "docs/zh/cache.md", old_string: "读取。", new_string: "读取。支持 TTL,见[过期策略](guide/ttl.md)。" },
      { path: "docs/zh/guide/ttl.md", create: true, content: "# 过期策略\n\n用 `setTtl(ms)` 设置过期时间,默认 `DEFAULT_TTL_MS = 0`(不过期)。" },
    ],
  };
  const r = await runDraft(ctx);
  assert.equal(r.code, 0, r.stderr);

  const user = r.llm.find((b) => b.model === "draft-x").messages[1].content;
  assert.match(user, /rebase 合并/);
  assert.match(user, /setTtl\(ms\)/); // PR 的第一个提交
  assert.match(user, /DEFAULT_TTL_MS/); // PR 的第二个提交
  assert.match(user, /=== docs\/zh\/guide\/ttl\.md ===\n\(新建文件/);

  const files = gitIn(ctx.remote, "show", "--name-only", "--format=", "docs/plan-12").split("\n").filter(Boolean).sort();
  assert.deepEqual(files, ["docs/en/cache.md", "docs/en/guide/ttl.md", "docs/zh/cache.md", "docs/zh/guide/ttl.md"]);
  assert.match(gitIn(ctx.remote, "show", "docs/plan-12:docs/en/guide/ttl.md"), /^# Expiration/);
  assert.equal(gitIn(ctx.repo, "status", "--porcelain"), ""); // 没有漏在工作区里的新文件
  assert.match(r.gh, /pr create --base main --head docs\/plan-12/);
  assert.match(r.gh, /`docs\/zh\/guide\/ttl\.md`\(新建\) — 新建过期策略文档/);
});

test("draft:模型要在源文档目录外新建 → 拒绝落盘,计划 Issue 下回帖「模型输出校验失败」,不推送、不建 PR", async () => {
  const ctx = setup();
  draftReply = { edits: [{ path: "docs/zh/../../escape.md", create: true, content: "x" }] };
  const r = await runDraft(ctx);
  assert.equal(r.code, 1);
  assert.match(r.gh, /issue comment 12 --body-file \S+\n⚠️ 自动写初稿失败\(原因类别:\*\*模型输出校验失败\*\*\)/);
  assert.doesNotMatch(r.gh, /pr create/);
  assert.ok(!existsSync(join(ctx.root, "escape.md")));
  assert.equal(gitIn(ctx.remote, "branch", "--list", "docs/plan-12"), "");
});

test("draft:失败回帖被拒(HTTP 403)→ 不静默:日志与 Step Summary 写明原因类别 + issues: write 权限提示,仍失败退出", async () => {
  const ctx = setup();
  draftReply = { edits: [{ path: "docs/zh/../../escape.md", create: true, content: "x" }] };
  const summary = join(ctx.root, "summary.md");
  const r = await runDraft(ctx, {
    GITHUB_STEP_SUMMARY: summary,
    FAKE_GH_RULES: JSON.stringify([
      ["^issue comment 12", "gh: Resource not accessible by integration (HTTP 403)\n", 1],
      ...JSON.parse(rules(ctx)),
    ]),
  });
  assert.equal(r.code, 1);
  assert.match(r.gh, /issue comment 12 --body-file/); // 确实试过回帖
  const hint = "无法在 Issue #12 下回帖:Resource not accessible by integration (HTTP 403),请检查 workflow 的 issues: write 权限";
  assert.ok(r.stderr.includes(hint), r.stderr);
  assert.ok(readLog(summary).includes(`(本次失败原因类别:**模型输出校验失败**)——${hint}`));
});

test("draft:本阶段全部模型调用(初稿 + 译文同步 + 整篇翻译 + 译文质检)逐次打日志,合计按模型写进 Step Summary", async () => {
  const ctx = setup();
  draftReply = {
    edits: [
      { path: "docs/zh/cache.md", old_string: "读取。", new_string: "读取。支持 TTL,见[过期策略](guide/ttl.md)。" },
      { path: "docs/zh/guide/ttl.md", create: true, content: "# 过期策略\n\n用 `setTtl(ms)` 设置过期时间。" },
    ],
  };
  const summary = join(ctx.root, "summary.md");
  const r = await runDraft(ctx, { GITHUB_STEP_SUMMARY: summary });
  assert.equal(r.code, 0, r.stderr);
  for (const line of [
    "[llm] draft · draft-x:token 用量 输入 3000 / 输出 200 / 合计 3200;重试 0 次,累计等待 0s",
    "[llm] sync · sync-x:token 用量 输入 1000 / 输出 50 / 合计 1050;重试 0 次,累计等待 0s",
    "[llm] translate · translate-x:token 用量 接口未返回;重试 0 次,累计等待 0s",
    "[llm] qa · fast-x:token 用量 输入 2000 / 输出 100 / 合计 2100;重试 0 次,累计等待 0s",
  ])
    assert.ok(r.stdout.includes(line), line);
  // 同步与翻译并行,行序不定:逐行核对
  const md = readLog(summary);
  for (const row of [
    "**doc-agent 模型用量(draft 阶段合计)**",
    "| draft-x | 1 | 3000 | 200 | 3200 | 0 | 0s |",
    "| sync-x | 1 | 1000 | 50 | 1050 | 0 | 0s |",
    "| translate-x | 1 | 0 | 0 | 0 | 0 | 0s |",
    "| fast-x | 1 | 2000 | 100 | 2100 | 0 | 0s |",
    "| **合计** | 4 | 6000 | 350 | 6350 | 0 | 0s |",
    "其中 1 次接口未返回 usage(token 数未计入这几次)。",
  ])
    assert.ok(md.includes(row), `${row}\n---\n${md}`);
});
