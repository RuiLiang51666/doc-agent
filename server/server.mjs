// doc-agent 后端:收 GitHub webhook → 用 App installation token 克隆目标仓库
// → 在克隆里跑现有的 plan/draft/revise 脚本。目标仓库零文件。
import http from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { App } from "@octokit/app";
import { createNodeMiddleware } from "@octokit/webhooks";

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

// 事件 → mode(复刻三条 workflow 的 if 条件)
function decideMode(name, p) {
  if (name === "pull_request" && p.action === "closed" && p.pull_request?.merged) return "plan";
  if (
    name === "issue_comment" &&
    (p.issue?.labels || []).some((l) => l.name === "docs/plan") &&
    p.comment?.body?.startsWith("/approve") &&
    p.comment?.user?.type !== "Bot"
  )
    return "draft";
  if (
    name === "pull_request_review_comment" &&
    (p.pull_request?.labels || []).some((l) => l.name === "docs/draft") &&
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
function envFor(p, token) {
  return {
    ...process.env,
    GH_TOKEN: token,
    LLM_API_KEY,
    LLM_BASE_URL,
    LLM_MODEL,
    LLM_FAST_MODEL,
    GITHUB_REPOSITORY: p.repository.full_name,
    PR_NUMBER: String(p.pull_request?.number ?? ""),
    PR_TITLE: p.pull_request?.title ?? "",
    MERGE_SHA: p.pull_request?.merge_commit_sha ?? "",
    ISSUE_NUMBER: String(p.issue?.number ?? ""),
    ISSUE_BODY: p.issue?.body ?? "",
    COMMENT_ID: String(p.comment?.id ?? ""),
    COMMENT_BODY: p.comment?.body ?? "",
    COMMENT_PATH: p.comment?.path ?? "",
    COMMENT_LINE: String(p.comment?.line ?? ""),
  };
}

// 克隆目标仓库到临时目录,在其中跑对应脚本(gh 用 GH_TOKEN 鉴权,从 cwd 的 remote 推断仓库)
async function runJob(mode, p, token) {
  const dir = mkdtempSync(join(tmpdir(), "doc-agent-"));
  try {
    const url = `https://x-access-token:${token}@github.com/${p.repository.full_name}.git`;
    const ref = mode === "revise" ? p.pull_request.head.ref : p.repository.default_branch;
    execFileSync("git", ["clone", "--branch", ref, url, dir], { stdio: "inherit" });
    execFileSync("node", [join(SCRIPTS, `${mode}.mjs`)], {
      cwd: dir,
      env: envFor(p, token),
      stdio: "inherit",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

app.webhooks.on(
  ["pull_request.closed", "issue_comment.created", "pull_request_review_comment.created"],
  async ({ name, payload }) => {
    const mode = decideMode(name, payload);
    if (!mode) return;
    const token = await installationToken(payload.installation.id);
    // 快速返回 200,长任务后台跑(GitHub webhook ~10s 超时)
    runJob(mode, payload, token).catch((e) => console.error(`[${mode}] 失败:`, e));
  }
);

http
  .createServer(createNodeMiddleware(app.webhooks))
  .listen(PORT, () => console.log(`doc-agent server :${PORT}  webhook 路径 /api/github/webhooks`));
