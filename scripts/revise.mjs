// docs-revise workflow 的脚本:按一条 review comment 做针对性返工。
import { readFileSync, writeFileSync } from "node:fs";
import { callLLM, extractJSON } from "./llm.mjs";
import { applyEdits } from "./edits.mjs";
import { loadStyle } from "./style.mjs";
import { runCheck } from "./checklib.mjs";
import { syncTranslation, qaTranslation } from "./translate.mjs";
import { sh, shRead } from "./sh.mjs";

const { GITHUB_REPOSITORY, PR_NUMBER, COMMENT_ID, COMMENT_BODY, COMMENT_PATH, COMMENT_LINE } =
  process.env;

try {
  sh(`git config user.name docs-bot`);
  sh(`git config user.email docs-bot@users.noreply.github.com`);

  const system =
    readFileSync(new URL("../prompts/draft.md", import.meta.url), "utf8") +
    "\n\n# 技术写作规范\n" +
    loadStyle();
  const user = `这是一次返工。reviewer 在 ${COMMENT_PATH}:${COMMENT_LINE} 留言:
"${COMMENT_BODY}"

只处理这条意见所指的地方,其余每一行逐字节不变。

当前文件 ${COMMENT_PATH}:
${readFileSync(COMMENT_PATH, "utf8")}`;

  const { edits } = extractJSON(await callLLM(system, user));
  applyEdits(edits);

  // 若改的是中文 canonical,增量同步英文镜像
  const enSync = [];
  if (COMMENT_PATH.startsWith("docs/zh/")) {
    enSync.push(await syncTranslation(COMMENT_PATH, edits));
  }

  sh(`git commit -aqm "docs: address review comment" -m "Reply to review comment ${COMMENT_ID}."`);
  shRead(`git push`);
  const sha = sh(`git rev-parse --short HEAD`).trim();

  // 在该 review 线程下回复
  sh(`gh api repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/comments/${COMMENT_ID}/replies -f body="Done in ${sha} ✅"`);

  // 标记该 review 线程为已解决(REST 没有这能力,用 GraphQL resolveReviewThread)
  const [owner, repo] = GITHUB_REPOSITORY.split("/");
  const threadsQuery = `query($owner:String!,$repo:String!,$pr:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$pr){reviewThreads(first:100){nodes{id comments(first:50){nodes{databaseId}}}}}}}`;
  const threads = JSON.parse(
    shRead(`gh api graphql -f query='${threadsQuery}' -f owner=${owner} -f repo=${repo} -F pr=${PR_NUMBER}`)
  ).data.repository.pullRequest.reviewThreads.nodes;
  const thread = threads.find((t) => t.comments.nodes.some((c) => String(c.databaseId) === COMMENT_ID));
  if (thread) {
    const resolveMutation = `mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}`;
    sh(`gh api graphql -f query='${resolveMutation}' -f id=${thread.id}`);
  }

  // 改完顺手跑文档审核(拼写/坏链),提示性贴评论
  await runCheck(PR_NUMBER).catch(() => {});

  // 若同步了英文,跑译文质检
  if (enSync.length) {
    const report = await qaTranslation(enSync).catch(() => null);
    if (report) {
      writeFileSync("/tmp/qa.md", `🌐 **译文质检**(提示性)\n\n${report}`);
      sh(`gh pr comment ${PR_NUMBER} --body-file /tmp/qa.md`);
    }
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
