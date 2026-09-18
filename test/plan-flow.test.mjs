// plan.mjs 端到端离线测试:临时 git 仓库 + 假 gh(记录每次调用)+ 本机 mock 大模型接口。
// 覆盖:无代码改动不静默、已有计划 Issue 跳过、各类异常(含输出被截断)在 PR 下回帖并失败退出、回帖被拒(403)也不静默、正常开 Issue、
// rebase 合并按 PR 全部提交取 diff、计划里的新建文档与越界路径;「无需更新」也回帖到源 PR(理由相同不重发)、模型用量进日志与 Step Summary。
// 跑:node --test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { embedContract } from "../scripts/contract.mjs";
import { noUpdateComment } from "../scripts/planlib.mjs";

const PLAN = fileURLToPath(new URL("../scripts/plan.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "doc-agent-plan-"));
const repo = join(root, "repo");
const bin = join(root, "bin");
mkdirSync(repo);
mkdirSync(bin);

// ── 临时仓库:init → 只改文档的提交 → 改代码的提交 → 模拟 rebase 合并落下的两个代码提交 ──
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const put = (p, s) => {
  mkdirSync(dirname(join(repo, p)), { recursive: true });
  writeFileSync(join(repo, p), s);
};
git("init", "-q");
git("config", "user.email", "t@example.com");
git("config", "user.name", "t");
put("src/cache.js", "export class Cache {\n  get(key) {}\n}\n");
put("docs/zh/cache.md", "---\ncovers:\n  - src/cache.js\n---\n\n# 内存缓存 Cache\n\n### `get(key)`\n\n读取。\n");
put("docs/en/cache.md", "# Cache\n\n### `get(key)`\n\nReads a value.\n");
put("docs/zh/images/arch.png", "PNG 二进制占位");
git("add", "-A");
git("commit", "-qm", "init");
put("docs/zh/cache.md", "---\ncovers:\n  - src/cache.js\n---\n\n# 内存缓存 Cache\n\n### `get(key)`\n\n读取指定键。\n");
git("commit", "-qam", "docs only");
const DOCS_SHA = git("rev-parse", "HEAD");
put("src/cache.js", "export class Cache {\n  get(key) {}\n  size() {\n    return this.map.size;\n  }\n}\n");
git("commit", "-qam", "feat: size()");
const CODE_SHA = git("rev-parse", "HEAD");
put("src/cache.js", "export class Cache {\n  get(key) {}\n  size() {\n    return this.map.size;\n  }\n  has(key) {\n    return this.map.has(key);\n  }\n}\n");
git("commit", "-qam", "feat: has()");
const HAS_SHA = git("rev-parse", "HEAD");
put("src/store.js", "export class Store {}\n");
git("add", "-A");
git("commit", "-qm", "feat: Store");
const REBASE_SHA = git("rev-parse", "HEAD");
const meta = (sha) => {
  const [date, ...msg] = git("log", "-1", "--format=%aI%n%B", sha).split("\n");
  return { commit: { message: msg.join("\n").trim(), author: { date } } };
};

// ── 假 gh:把参数与 --body-file / -F body=@file 的正文记进日志;issue list 返回 FAKE_GH_ISSUES;
//    api 读请求(不带 -f / -F)按 FAKE_GH_API({ 路径: 返回值 })回放,没有就按 404 失败;
//    设了 FAKE_GH_COMMENT_403 时,发评论按真实环境的 403 拒绝(plan job 的 pull-requests 只有读权限时就是这样)──
writeFileSync(
  join(bin, "gh"),
  `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
let entry = "gh " + args.join(" ");
args.forEach((a, i) => {
  if (a === "--body-file") entry += "\\n" + fs.readFileSync(args[i + 1], "utf8");
  if (a === "-F" && args[i + 1].startsWith("body=@")) entry += "\\n" + fs.readFileSync(args[i + 1].slice(6), "utf8");
});
fs.appendFileSync(process.env.FAKE_GH_LOG, entry + "\\n");
if (process.env.FAKE_GH_COMMENT_403 && args[0] === "api" && /\\/comments$/.test(args[1] || "") && args.includes("-F")) {
  process.stderr.write("gh: Resource not accessible by integration (HTTP 403)\\n");
  process.exit(1);
}
if (args[0] === "issue" && args[1] === "list") process.stdout.write(process.env.FAKE_GH_ISSUES || "[]");
if (args[0] === "issue" && args[1] === "create") process.stdout.write("https://github.com/o/r/issues/99\\n");
if (args[0] === "api" && !args.includes("-F") && !args.includes("-f")) {
  const routes = JSON.parse(process.env.FAKE_GH_API || "{}");
  const path = args[args.length - 1];
  if (path in routes) process.stdout.write(JSON.stringify(routes[path]));
  else {
    process.stderr.write("gh: Not Found (HTTP 404)\\n");
    process.exit(1);
  }
}
`
);
chmodSync(join(bin, "gh"), 0o755);

// ── mock 大模型:按 reply 返回(finish 缺省为 stop);记录调用次数与最后一次请求 ──
let reply = { status: 200, content: '{"update":false,"reason":"x"}' };
let llmCalls = 0;
let lastRequest = null;
// 替身自己出错也必须回响应(理由同 fakes.mjs 的 startMockLLM):不回响应 = 被测进程干等 LLM_TIMEOUT_MS
// (默认 120s)再重试三次,用例表现成「永远不结束」,真正的原因一个字都看不到。兜成 400,4xx 不重试。
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      llmCalls++;
      lastRequest = JSON.parse(body);
      if (reply.status !== 200) {
        res.writeHead(reply.status);
        return res.end('{"error":"bad request"}');
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: reply.content }, finish_reason: reply.finish || "stop" }],
          usage: reply.usage, // 没设就不带(JSON 里省略)
        })
      );
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `mock LLM 替身出错:${e.message}` } }));
    }
  });
});
server.unref(); // 替身不该拖住测试进程退出
before(() => new Promise((r) => server.listen(0, "127.0.0.1", r)));
// 先掐连接再 close:只 close 的话,万一有子进程挂住没退,这里会一直等下去
after(
  () =>
    new Promise((r) => {
      server.closeAllConnections();
      server.close(r);
    })
);

let runs = 0;
function runPlan(sha, env = {}) {
  const n = ++runs;
  const log = join(root, `gh-${n}.log`);
  const summary = join(root, `summary-${n}.md`);
  writeFileSync(log, "");
  const calls = llmCalls;
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [PLAN],
      {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          TMPDIR: root,
          FAKE_GH_LOG: log,
          FAKE_GH_ISSUES: "[]",
          GITHUB_STEP_SUMMARY: summary,
          GITHUB_REPOSITORY: "o/r",
          PR_NUMBER: "7",
          PR_TITLE: "feat: size()",
          MERGE_SHA: sha,
          LLM_API_KEY: "test-key",
          LLM_BASE_URL: `http://127.0.0.1:${server.address().port}`,
          LLM_MODEL: "strong-x",
          ...env,
        },
      },
      (err, stdout, stderr) =>
        resolve({
          code: err ? err.code : 0,
          stdout,
          stderr,
          gh: readFileSync(log, "utf8"),
          summary: existsSync(summary) ? readFileSync(summary, "utf8") : "",
          llm: llmCalls - calls,
        })
    );
  });
}

test("plan:配置的代码路径没有改动 → 明确日志 + Step Summary,不回帖、不调模型,退出 0", async () => {
  const r = await runPlan(DOCS_SHA);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /PR #7 在配置的代码路径\(src\)下没有改动/);
  assert.match(r.summary, /没有改动/);
  // 只读了 GitHub 上的 PR 数据(假 gh 404 → 退回 MERGE_SHA^1 并写明),没有任何写操作
  assert.match(r.gh, /^gh api repos\/o\/r\/pulls\/7$/m);
  assert.match(r.stdout, /读取 GitHub 上 PR #7 失败.*退回/);
  assert.doesNotMatch(r.gh, /comments|issue (create|list)/);
  assert.equal(r.llm, 0);
});

test("plan:同一 PR 已有计划 Issue → 跳过,不调模型、不开重复 Issue", async () => {
  const issues = [{ number: 3, title: "📝 docs: 记录 size() (#7)", body: "正文" + embedContract("plan", { sourcePr: 7, items: [] }) }];
  const r = await runPlan(CODE_SHA, { FAKE_GH_ISSUES: JSON.stringify(issues) });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /已有计划 Issue #3,跳过/);
  assert.match(r.gh, /gh issue list --label docs\/plan/);
  assert.doesNotMatch(r.gh, /issue create/);
  assert.equal(r.llm, 0);
});

test("plan:模型接口 4xx → 在被合并的 PR 下回帖「模型接口报错」,失败退出", async () => {
  reply = { status: 400 };
  const r = await runPlan(CODE_SHA);
  assert.equal(r.code, 1);
  assert.match(r.gh, /gh api repos\/o\/r\/issues\/7\/comments -F body=@/);
  assert.match(r.gh, /原因类别:\*\*模型接口报错\*\*/);
  assert.doesNotMatch(r.gh, /issue create/);
  assert.match(r.summary, /模型接口报错/);
});

test("plan:失败回帖被拒(HTTP 403)→ 不静默:日志与 Step Summary 写明原因类别 +「无法在 PR #N 下回帖…pull-requests: write 权限」,仍失败退出", async () => {
  reply = { status: 400 };
  const r = await runPlan(CODE_SHA, { FAKE_GH_COMMENT_403: "1" });
  assert.equal(r.code, 1);
  assert.match(r.gh, /gh api repos\/o\/r\/issues\/7\/comments -F body=@/); // 确实试过回帖
  const hint = "无法在 PR #7 下回帖:Resource not accessible by integration (HTTP 403),请检查 workflow 的 pull-requests: write 权限";
  assert.ok(r.stderr.includes(hint), r.stderr);
  assert.ok(r.summary.includes(`(本次失败原因类别:**模型接口报错**)——${hint}`), r.summary);
  assert.match(r.stderr, /LLM 400/); // 原始异常照样打出
});

test("plan:模型输出 schema 校验失败 → 回帖「模型输出校验失败」,失败退出", async () => {
  reply = { status: 200, content: '{"update":true}' };
  const r = await runPlan(CODE_SHA);
  assert.equal(r.code, 1);
  assert.match(r.gh, /原因类别:\*\*模型输出校验失败\*\*/);
  assert.doesNotMatch(r.gh, /issue create/);
});

test("plan:模型输出被截断(finish_reason=length)→ 不把半截 JSON 当结果,回帖「模型输出被截断」,失败退出", async () => {
  reply = { status: 200, content: '{"update":true,"items":[{"file":"docs/zh/cache.md","cha', finish: "length" };
  const r = await runPlan(CODE_SHA);
  assert.equal(r.code, 1);
  assert.match(r.gh, /原因类别:\*\*模型输出被截断\*\*/);
  assert.doesNotMatch(r.gh, /issue create/);
});

test("plan:超预算 → 不调模型,回帖「超预算」,失败退出", async () => {
  const r = await runPlan(CODE_SHA, { PLAN_TOKEN_BUDGET: "50" });
  assert.equal(r.code, 1);
  assert.equal(r.llm, 0);
  assert.match(r.gh, /原因类别:\*\*超预算\*\*/);
});

test("plan:正常路径 → prompt 含 diff + 索引 + 文档全文(不含图片),开 Issue 且契约带 sourcePr / mergeSha", async () => {
  reply = {
    status: 200,
    content: JSON.stringify({ update: true, reason: "新增 size()", title: "记录 size() 方法", items: [{ file: "docs/zh/cache.md", change: "补充 size()" }], skipped: [] }),
  };
  const r = await runPlan(CODE_SHA);
  assert.equal(r.code, 0, r.stderr);
  const user = lastRequest.messages[1].content;
  assert.match(user, /size\(\) \{/); // 代码 diff
  assert.match(user, /- ★ docs\/zh\/cache\.md — 内存缓存 Cache/); // 索引
  assert.match(user, /=== docs\/zh\/cache\.md ===/); // 全文
  assert.doesNotMatch(user, /arch\.png|docs\/en\//);
  // 假 gh 记下的是 shell 拆分后的参数,引号已去掉
  assert.match(r.gh, /gh issue create --title 📝 docs: 记录 size\(\) 方法 \(#7\) --label docs\/plan/);
  assert.match(r.gh, new RegExp(`"sourcePr":7,"mergeSha":"${CODE_SHA}"`));
});

test("plan:rebase 合并(PR 两个提交)→ diff 含全部提交;新建文档标「(新建)」且契约带 create;越界路径 → 校验失败", async () => {
  const api = {
    "repos/o/r/pulls/7": { number: 7, commits: 2, merge_commit_sha: REBASE_SHA },
    "repos/o/r/pulls/7/commits?per_page=100": [[meta(HAS_SHA), meta(REBASE_SHA)]],
    "repos/o/r/pulls/7/files?per_page=100": [[{ filename: "src/cache.js" }, { filename: "src/store.js" }]],
  };
  reply = {
    status: 200,
    content: JSON.stringify({
      update: true,
      reason: "新增 has() 与 Store",
      title: "记录 has() 与 Store",
      items: [
        { file: "docs/zh/cache.md", change: "补充 has()" },
        { file: "docs/zh/store.md", change: "新建 Store 文档", create: true },
      ],
      skipped: [],
    }),
  };
  const r = await runPlan(REBASE_SHA, { FAKE_GH_API: JSON.stringify(api) });
  assert.equal(r.code, 0, r.stderr);
  const user = lastRequest.messages[1].content;
  assert.match(user, /has\(key\) \{/); // PR 的第一个提交(旧口径 MERGE_SHA^1 会漏掉)
  assert.match(user, /class Store/); // PR 的第二个提交
  assert.match(r.stdout, /按 rebase 合并:.*与 GitHub PR 文件列表一致/);
  assert.match(r.gh, /- \[ \] `docs\/zh\/store\.md`\(新建\) — 新建 Store 文档/);
  assert.match(r.gh, /"file":"docs\/zh\/store\.md","change":"新建 Store 文档","create":true/);
  assert.match(r.gh, /diff 口径 rebase 合并/);

  reply = {
    status: 200,
    content: JSON.stringify({ update: true, reason: "x", title: "x", items: [{ file: "../outside.md", change: "x" }], skipped: [] }),
  };
  const bad = await runPlan(REBASE_SHA, { FAKE_GH_API: JSON.stringify(api) });
  assert.equal(bad.code, 1);
  assert.match(bad.gh, /原因类别:\*\*模型输出校验失败\*\*/);
  assert.doesNotMatch(bad.gh, /issue create/);
});

// ── 「无需更新」也回帖到源 PR;模型用量写进日志与 Step Summary ──
const NO_UPDATE_REASON = "H2 Console 的访问配置未在现有文档中体现,与文档定位一致,无需更新文档。";
const RUN_ENV = { GITHUB_SERVER_URL: "https://github.com", GITHUB_RUN_ID: "35197965194" };
const commentsRoute = (comments) => JSON.stringify({ "repos/o/r/issues/7/comments?per_page=100": [comments] });

test("plan:模型判定无需更新 → 在被合并的 PR 下回帖「已评估、无需更新」+ 理由原文 + 运行链接,退出 0;日志与 Step Summary 带模型用量", async () => {
  reply = {
    status: 200,
    content: JSON.stringify({ update: false, reason: NO_UPDATE_REASON }),
    usage: { prompt_tokens: 58934, completion_tokens: 120, total_tokens: 59054 },
  };
  const r = await runPlan(CODE_SHA, { ...RUN_ENV, FAKE_GH_API: commentsRoute([]) });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.gh, /^gh api --paginate --slurp repos\/o\/r\/issues\/7\/comments\?per_page=100$/m); // 先查有没有发过
  const posted = r.gh.split(/^gh api repos\/o\/r\/issues\/7\/comments -F body=@\S+\n/m)[1] || "";
  assert.match(posted, /^✅ doc-agent 已评估本 PR 的文档影响,结论:\*\*无需更新文档\*\*。/);
  assert.ok(posted.includes(`> ${NO_UPDATE_REASON}`), posted);
  assert.ok(posted.includes("运行记录:https://github.com/o/r/actions/runs/35197965194"), posted);
  assert.match(posted, /<!-- doc-agent:no-update [0-9a-f]{12} -->/);
  assert.doesNotMatch(r.gh, /issue create/);
  // 用量:每次调用一行日志;Step Summary 里有本阶段合计
  assert.ok(r.stdout.includes("[llm] plan · strong-x:token 用量 输入 58934 / 输出 120 / 合计 59054;重试 0 次,累计等待 0s"), r.stdout);
  assert.match(r.summary, /Docs ✓ 无需更新/);
  assert.ok(r.summary.includes("**doc-agent 模型用量(plan 阶段合计)**"), r.summary);
  assert.ok(r.summary.includes("| strong-x | 1 | 58934 | 120 | 59054 | 0 | 0s |"), r.summary);
});

test("plan:同一 PR 重复触发、理由相同(运行链接不同)→ 不重复发「无需更新」评论", async () => {
  reply = { status: 200, content: JSON.stringify({ update: false, reason: NO_UPDATE_REASON }) };
  const earlier = noUpdateComment({ reason: NO_UPDATE_REASON, runLink: "https://github.com/o/r/actions/runs/1" });
  const r = await runPlan(CODE_SHA, { ...RUN_ENV, FAKE_GH_API: commentsRoute([{ body: "别人的评论" }, { body: earlier }]) });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /PR #7 下已有理由相同的「无需更新」评论,不重复发/);
  assert.doesNotMatch(r.gh, /-F body=@/);
  // 接口没返回 usage → 日志与 Step Summary 如实写明
  assert.ok(r.stdout.includes("[llm] plan · strong-x:token 用量 接口未返回;重试 0 次,累计等待 0s"), r.stdout);
  assert.match(r.summary, /1 次接口未返回 usage/);
});

test("plan:「无需更新」回帖被拒(HTTP 403)→ 结论不变、退出 0;日志与 Step Summary 写明结论 + pull-requests: write 权限提示", async () => {
  reply = { status: 200, content: JSON.stringify({ update: false, reason: NO_UPDATE_REASON }) };
  const r = await runPlan(CODE_SHA, { ...RUN_ENV, FAKE_GH_API: commentsRoute([]), FAKE_GH_COMMENT_403: "1" });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.gh, /gh api repos\/o\/r\/issues\/7\/comments -F body=@/); // 确实试过回帖
  const hint = "无法在 PR #7 下回帖:Resource not accessible by integration (HTTP 403),请检查 workflow 的 pull-requests: write 权限";
  assert.ok(r.stderr.includes(hint), r.stderr);
  assert.ok(r.summary.includes(`> ⚠️ **doc-agent 回帖没发出去**(本次结论:**无需更新文档**)——${hint}`), r.summary);
});
