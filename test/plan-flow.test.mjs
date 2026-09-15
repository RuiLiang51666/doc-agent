// plan.mjs 端到端离线测试:临时 git 仓库 + 假 gh(记录每次调用)+ 本机 mock 大模型接口。
// 覆盖:无代码改动不静默、已有计划 Issue 跳过、各类异常在 PR 下回帖并失败退出、正常开 Issue。
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

const PLAN = fileURLToPath(new URL("../scripts/plan.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "doc-agent-plan-"));
const repo = join(root, "repo");
const bin = join(root, "bin");
mkdirSync(repo);
mkdirSync(bin);

// ── 临时仓库:init → 只改文档的提交 → 改代码的提交 ──
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
put("docs/zh/images/arch.png", "PNG 二进制占位");
git("add", "-A");
git("commit", "-qm", "init");
put("docs/zh/cache.md", "---\ncovers:\n  - src/cache.js\n---\n\n# 内存缓存 Cache\n\n### `get(key)`\n\n读取指定键。\n");
git("commit", "-qam", "docs only");
const DOCS_SHA = git("rev-parse", "HEAD");
put("src/cache.js", "export class Cache {\n  get(key) {}\n  size() {\n    return this.map.size;\n  }\n}\n");
git("commit", "-qam", "feat: size()");
const CODE_SHA = git("rev-parse", "HEAD");

// ── 假 gh:把参数与 --body-file / -F body=@file 的正文记进日志;issue list 返回 FAKE_GH_ISSUES ──
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
if (args[0] === "issue" && args[1] === "list") process.stdout.write(process.env.FAKE_GH_ISSUES || "[]");
if (args[0] === "issue" && args[1] === "create") process.stdout.write("https://github.com/o/r/issues/99\\n");
`
);
chmodSync(join(bin, "gh"), 0o755);

// ── mock 大模型:按 reply 返回;记录调用次数与最后一次请求 ──
let reply = { status: 200, content: '{"update":false,"reason":"x"}' };
let llmCalls = 0;
let lastRequest = null;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    llmCalls++;
    lastRequest = JSON.parse(body);
    if (reply.status !== 200) {
      res.writeHead(reply.status);
      return res.end('{"error":"bad request"}');
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: reply.content } }] }));
  });
});
before(() => new Promise((r) => server.listen(0, "127.0.0.1", r)));
after(() => server.close());

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
  assert.equal(r.gh, "");
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

test("plan:模型输出 schema 校验失败 → 回帖「模型输出校验失败」,失败退出", async () => {
  reply = { status: 200, content: '{"update":true}' };
  const r = await runPlan(CODE_SHA);
  assert.equal(r.code, 1);
  assert.match(r.gh, /原因类别:\*\*模型输出校验失败\*\*/);
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
