// docs-revise workflow 的脚本:按一条 review comment 做针对性返工。
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { callLLM, extractJSON } from "./llm.mjs";
import { applyEdits } from "./edits.mjs";

const sh = (cmd) => execSync(cmd, { encoding: "utf8" });
const { GITHUB_REPOSITORY, PR_NUMBER, COMMENT_ID, COMMENT_BODY, COMMENT_PATH, COMMENT_LINE } =
  process.env;

try {
  sh(`git config user.name docs-bot`);
  sh(`git config user.email docs-bot@users.noreply.github.com`);

  const system = readFileSync(new URL("../prompts/draft.md", import.meta.url), "utf8");
  const user = `这是一次返工。reviewer 在 ${COMMENT_PATH}:${COMMENT_LINE} 留言:
"${COMMENT_BODY}"

只处理这条意见所指的地方,其余每一行逐字节不变。

当前文件 ${COMMENT_PATH}:
${readFileSync(COMMENT_PATH, "utf8")}`;

  const { edits } = extractJSON(await callLLM(system, user));
  applyEdits(edits);

  sh(`git commit -aqm "docs: address review comment" -m "Reply to review comment ${COMMENT_ID}."`);
  sh(`git push`);
  const sha = sh(`git rev-parse --short HEAD`).trim();

  // 在该 review 线程下回复
  sh(`gh api repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/comments/${COMMENT_ID}/replies -f body="Done in ${sha} ✅"`);

  // 标记该 review 线程为已解决(REST 没有这能力,用 GraphQL resolveReviewThread)
  const [owner, repo] = GITHUB_REPOSITORY.split("/");
  const threadsQuery = `query($owner:String!,$repo:String!,$pr:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$pr){reviewThreads(first:100){nodes{id comments(first:50){nodes{databaseId}}}}}}}`;
  const threads = JSON.parse(
    sh(`gh api graphql -f query='${threadsQuery}' -f owner=${owner} -f repo=${repo} -F pr=${PR_NUMBER}`)
  ).data.repository.pullRequest.reviewThreads.nodes;
  const thread = threads.find((t) => t.comments.nodes.some((c) => String(c.databaseId) === COMMENT_ID));
  if (thread) {
    const resolveMutation = `mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}`;
    sh(`gh api graphql -f query='${resolveMutation}' -f id=${thread.id}`);
  }
} catch (e) {
  // 失败时回到那条 review 评论下留言
  writeFileSync("/tmp/err.md", `⚠️ 按这条评论返工失败:${String(e.message || e).slice(0, 400)}`);
  try {
    sh(`gh api repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/comments/${COMMENT_ID}/replies -F body=@/tmp/err.md`);
  } catch {
    try {
      sh(`gh pr comment ${PR_NUMBER} --body-file /tmp/err.md`);
    } catch {}
  }
  console.error(e);
  process.exit(1);
}
