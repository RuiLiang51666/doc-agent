// doc-agent 后端:收 GitHub webhook → 用 App installation token 克隆目标仓库
// → 在克隆里跑现有的 plan/draft/revise 脚本。目标仓库零文件。
// 并发:同一 PR / Issue 的事件在进程内排队串行(queue.mjs),不同 PR / Issue 之间并行;
// 每个任务独立的克隆目录与临时目录(TMPDIR),子进程异步执行、不阻塞收 webhook。
import http from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { App } from "@octokit/app";
import { createNodeMiddleware } from "@octokit/webhooks";
import { createKeyedQueue } from "./queue.mjs";

const {
  APP_ID,
  WEBHOOK_SECRET,
  PORT = 3000,
  LLM_API_KEY,
  LLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4",
  LLM_MODEL = "glm-4.6",
  LLM_FAST_MODEL = "glm-4-flash",
} = process.env;

// 私钥:支持环境变量(\n 转义)或文件路径
const PRIVATE_KEY = process.env.PRIVATE_KEY
  ? process.env.PRIVATE_KEY.replace(/\\n/g, "\n")
  : readFileSync(process.env.PRIVATE_KEY_PATH, "utf8");

const SCRIPTS = fileURLToPath(new URL("../scripts", import.meta.url));
const app = new App({ appId: APP_ID, privateKey: PRIVATE_KEY, webhooks: { secret: WEBHOOK_SECRET } });
const enqueue = createKeyedQueue();

// 事件 → mode(复刻 workflow 的 if 条件)
function decideMode(name, p) {
  if (name === "pull_request" && p.action === "closed" && p.pull_request?.merged) return "plan";
  if (
    name === "issue_comment" &&
    (p.issue?.labels || []).some((l) => l.name === "docs/plan") &&
    p.comment?.body?.startsWith("/approve") &&
    p.comment?.user?.type !== "Bot"
  )
    return "draft";
  // 返工:推荐订阅 review 提交事件;老的逐条评论事件也照收(App 可能只订阅了它)。两种事件都按「本 PR 全部待处理意见」
  // 批量处理,同一 PR 排队串行、排队中的并入——一次 review 带来的 1 + N 个事件实际只跑一到两次,不会互相踩踏
  const onDraftPr = (p.pull_request?.labels || []).some((l) => l.name === "docs/draft");
  if (name === "pull_request_review" && p.action === "submitted" && onDraftPr && p.review?.user?.type !== "Bot")
    return "revise";
  if (
    name === "pull_request_review_comment" &&
    onDraftPr &&
    p.comment?.user?.type !== "Bot" &&
    !p.comment?.body?.startsWith("/")
  )
    return "revise";
  return null;
}

async function installationToken(installationId) {
  const octokit = await app.getInstallationOctokit(installationId);
  const { token } = await octokit.auth({ type: "installation" });
  return token;
}

// 把 webhook payload 映射成脚本要的环境变量(对应原来 action.yml 里的 github.event.*)
function envFor(p, token, tmp) {
  return {
    // 继承后端进程的环境变量:路径 / 语言 / 预算配置与 action inputs 同名(CODE_PATHS、DOCS_SOURCE_DIR、
    // DOCS_TARGET_DIR、DOCS_GLOB、DOCS_EXCLUDE、SOURCE_LANG、PLAN_TOKEN_BUDGET、DIFF_TOKEN_BUDGET、
    // LLM_RETRY_MAX_WAIT_MS、LLM_MAX_TOKENS),由此传给脚本
    ...process.env,
    GH_TOKEN: token,
    LLM_API_KEY,
    LLM_BASE_URL,
    LLM_MODEL,
    LLM_FAST_MODEL,
    TMPDIR: tmp, // 脚本的临时文件(Issue / PR / 评论正文)落在本任务专属目录,并发任务互不覆盖
    GITHUB_REPOSITORY: p.repository.full_name,
    PR_NUMBER: String(p.pull_request?.number ?? ""),
    PR_TITLE: p.pull_request?.title ?? "",
    MERGE_SHA: p.pull_request?.merge_commit_sha ?? "",
    ISSUE_NUMBER: String(p.issue?.number ?? ""),
    ISSUE_BODY: p.issue?.body ?? "",
    // 有 REVIEW_ID 时 revise 走批量模式;逐条评论事件也带上它所属的 review
    REVIEW_ID: String(p.review?.id ?? p.comment?.pull_request_review_id ?? ""),
    COMMENT_ID: String(p.comment?.id ?? ""),
    COMMENT_BODY: p.comment?.body ?? "",
    COMMENT_PATH: p.comment?.path ?? "",
    COMMENT_LINE: String(p.comment?.line ?? ""),
  };
}

// 异步跑子进程(stdio 直通日志);失败信息只带子命令名,不带参数(clone 地址里有 token)
const run = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args[0]} 退出码 ${code}`))));
  });

// 克隆目标仓库到临时目录,在其中跑对应脚本(gh 用 GH_TOKEN 鉴权,从 cwd 的 remote 推断仓库)
async function runJob(mode, p) {
  const token = await installationToken(p.installation.id); // 排到了再取:排队可能较久,installation token 一小时过期
  const dir = mkdtempSync(join(tmpdir(), "doc-agent-"));
  const tmp = mkdtempSync(join(tmpdir(), "doc-agent-tmp-"));
  try {
    const url = `https://x-access-token:${token}@github.com/${p.repository.full_name}.git`;
    const ref = mode === "revise" ? p.pull_request.head.ref : p.repository.default_branch;
    await run("git", ["clone", "--branch", ref, url, dir]);
    await run("node", [join(SCRIPTS, `${mode}.mjs`)], { cwd: dir, env: envFor(p, token, tmp) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
}

// 串行分组:draft 按计划 Issue,plan / revise 按 PR(Issue 与 PR 共用编号,不会串号)
const jobKey = (mode, p) =>
  `${p.repository.full_name}#${mode === "draft" ? p.issue.number : p.pull_request.number}`;

app.webhooks.on(
  ["pull_request.closed", "issue_comment.created", "pull_request_review.submitted", "pull_request_review_comment.created"],
  async ({ name, payload }) => {
    const mode = decideMode(name, payload);
    if (!mode) return;
    const key = jobKey(mode, payload);
    // 快速返回 200,长任务后台排队跑(GitHub webhook ~10s 超时)
    const { merged, done } = enqueue(key, mode, () => runJob(mode, payload));
    if (merged) console.log(`[${mode}] ${key} 已有排队中的同类任务,本事件并入(不重复排队)`);
    else done.catch((e) => console.error(`[${mode}] ${key} 失败:`, e));
  }
);

http
  .createServer(createNodeMiddleware(app.webhooks))
  .listen(PORT, () => console.log(`doc-agent server :${PORT}  webhook 路径 /api/github/webhooks`));
