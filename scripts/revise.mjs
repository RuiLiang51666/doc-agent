// docs-revise workflow 的脚本:按 review 意见返工。
// - 批量模式(有 REVIEW_ID:pull_request_review.submitted 触发;server 形态两种事件都走这里):
//   处理本 PR 上全部「还没被 doc-agent 答复过、线程未解决」的行内意见——一次调模型、一个提交、每个线程回一条。
//   同一 PR 的运行由 workflow 并发组 / server 进程内队列串行;排队中被取消或并入的那次运行,它的意见由后一次一并处理。
// - 单条模式(只有 COMMENT_ID:老 workflow 的 pull_request_review_comment 触发):历史行为,只处理触发的这一条。
// 两种模式都显式 add 改动路径再提交;推送被拒先变基再重试(git.mjs),最终失败在线程(或 PR)下如实回帖。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStage } from "./llm.mjs";
import { applyEdits } from "./edits.mjs";
import { loadStyle } from "./style.mjs";
import { runCheck } from "./checklib.mjs";
import { syncTranslation, qaTranslation } from "./translate.mjs";
import { sh, shRead } from "./sh.mjs";
import { ghList } from "./gh.mjs";
import { loadConfig, isSourceDoc } from "./config.mjs";
import { classifyError } from "./errors.mjs";
import { reportCommentFailure, reportSoftFailure } from "./planlib.mjs";
import { commitPaths, currentBranch, pushWithRebase } from "./git.mjs";
import { pendingThreads, reviseUser, REPLY_MARK } from "./review.mjs";

const { GITHUB_REPOSITORY, PR_NUMBER, REVIEW_ID, COMMENT_ID, COMMENT_BODY, COMMENT_PATH, COMMENT_LINE } =
  process.env;
const batch = Boolean(REVIEW_ID);
const tmp = (name) => join(tmpdir(), name);

// 在线程下回复;正文末尾带隐藏标记,下次运行据此认出「已答复」
function reply(commentId, text) {
  writeFileSync(tmp("revise-reply.md"), `${text}\n\n${REPLY_MARK}`);
  sh(
    `gh api repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/comments/${commentId}/replies -F body=@"${tmp("revise-reply.md")}"`
  );
}

// 本 PR 的 review 线程:评论 databaseId → { id, isResolved }(REST 拿不到线程与解决状态,用 GraphQL)
function threadsByComment() {
  const [owner, repo] = GITHUB_REPOSITORY.split("/");
  const q = `query($owner:String!,$repo:String!,$pr:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$pr){reviewThreads(first:100){nodes{id isResolved comments(first:100){nodes{databaseId}}}}}}}`;
  const nodes = JSON.parse(
    shRead(`gh api graphql -f query='${q}' -f owner=${owner} -f repo=${repo} -F pr=${PR_NUMBER}`)
  ).data.repository.pullRequest.reviewThreads.nodes;
  const map = new Map();
  for (const t of nodes) for (const c of t.comments.nodes) map.set(Number(c.databaseId), t);
  return map;
}

// 单条模式的「线程」就是触发的那条评论;批量模式在下面拉取
let threads = batch
  ? []
  : [{ rootId: COMMENT_ID, path: COMMENT_PATH, items: [{ id: Number(COMMENT_ID), line: COMMENT_LINE, body: COMMENT_BODY }] }];

try {
  sh(`git config user.name docs-bot`);
  sh(`git config user.email docs-bot@users.noreply.github.com`);

  let byComment = null;
  if (batch) {
    byComment = threadsByComment();
    const resolved = new Set([...byComment].filter(([, t]) => t.isResolved).map(([id]) => id));
    threads = pendingThreads(ghList(`repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/comments?per_page=100`), resolved);
    const n = threads.reduce((s, t) => s + t.items.length, 0);
    if (!n) {
      console.log(`doc-agent revise:PR #${PR_NUMBER} 没有待处理的行内 review 意见(触发的 review ${REVIEW_ID}),跳过。`);
      process.exit(0);
    }
    console.log(`doc-agent revise:PR #${PR_NUMBER} 待处理意见 ${n} 条,分布在 ${threads.length} 个线程,本次一并处理`);
  }

  const system =
    readFileSync(new URL("../prompts/draft.md", import.meta.url), "utf8") +
    "\n\n# 技术写作规范\n" +
    loadStyle();
  const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "(文件不存在)");
  const { edits } = await runStage({ stage: "revise", system, user: reviseUser(threads, read) });
  if (!edits.length) {
    for (const t of threads) reply(t.rootId, "未改动:模型判断这条意见不需要修改文档。如仍需修改,请在本线程补充说明。");
    process.exit(0);
  }
  const edited = applyEdits(edits);

  // 改到的源语言文档(canonical,目录与通配见配置)增量同步译文镜像
  const cfg = loadConfig();
  const synced = await Promise.all(edited.filter((p) => isSourceDoc(p, cfg)).map((src) => syncTranslation(src, edits)));

  // 显式 add 本次改动与同步出的译文(不用 commit -a);推送被拒先变基再重试
  const ids = threads.flatMap((t) => t.items.map((it) => it.id));
  commitPaths(
    [...edited, ...synced.map((s) => s.target)],
    batch
      ? ["docs: address review comments", `Reply to review comments ${ids.join(", ")}.`]
      : ["docs: address review comment", `Reply to review comment ${COMMENT_ID}.`]
  );
  pushWithRebase(currentBranch());
  const sha = sh(`git rev-parse --short HEAD`).trim();

  // 每个线程回一条,再标记为已解决(REST 没有这能力,用 GraphQL resolveReviewThread;失败不影响返工结果)
  for (const t of threads) reply(t.rootId, `Done in ${sha} ✅`);
  try {
    byComment = byComment || threadsByComment();
    const resolveMutation = `mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}`;
    for (const t of threads) {
      const th = byComment.get(Number(t.rootId)) || byComment.get(t.items[0].id);
      if (th && !th.isResolved) sh(`gh api graphql -f query='${resolveMutation}' -f id=${th.id}`);
    }
  } catch (e) {
    console.error(`标记 review 线程已解决失败(不影响返工结果):${e.message}`);
  }

  // 改完顺手跑文档审核(拼写/坏链):只查本次改到的文档,提示性贴评论;失败也要看得见
  await runCheck(PR_NUMBER, [...edited, ...synced.map((s) => s.target)]).catch((e) =>
    reportSoftFailure({ task: "文档审核", err: e })
  );

  // 若同步了译文,跑译文质检。失败不许吞掉:日志、Step Summary 与 PR 回帖都写明原因类别(运行结论仍判成功)
  if (synced.length) {
    try {
      const report = await qaTranslation(synced);
      writeFileSync(tmp("qa.md"), `🌐 **译文质检**(提示性)\n\n${report}`);
      sh(`gh pr comment ${PR_NUMBER} --body-file "${tmp("qa.md")}"`);
    } catch (e) {
      reportSoftFailure({ task: "译文质检", err: e, pr: PR_NUMBER, file: tmp("qa-fail.md") });
    }
  }
} catch (e) {
  // 失败时回到每个待处理线程下如实回帖。回帖带标记 = 算作已答复,不会被下一次运行反复重试(一条意见反复失败会拖垮整批);
  // 要重试就在线程里补一条回复。一条都回不上(或还没拿到意见列表)就在 PR 下回帖。
  const kind = classifyError(e);
  const reason = `(原因类别:**${kind.label}**):${String(e.message || e).slice(0, 400)}`;
  // 回帖被拒(常见 403:revise job 没给 pull-requests: write)不许静默:日志 + Step Summary 写明原因类别与权限提示
  const notice = (target, err) => reportCommentFailure({ target, permission: "pull-requests: write", kind, err });
  let posted = 0;
  let replyErr = null;
  for (const t of threads) {
    try {
      reply(t.rootId, `⚠️ 按这条评论返工失败${reason}\n\n如需重试,在本线程下补一条回复即可。`);
      posted++;
    } catch (err) {
      replyErr = err;
    }
  }
  if (!posted) {
    try {
      writeFileSync(tmp("revise-err.md"), `⚠️ 按 review 意见返工失败${reason}`);
      sh(`gh pr comment ${PR_NUMBER} --body-file "${tmp("revise-err.md")}"`);
    } catch (err) {
      notice(`PR #${PR_NUMBER}`, err);
    }
  } else if (replyErr) notice(`PR #${PR_NUMBER} 的部分 review 线程`, replyErr);
  console.error(e);
  process.exit(1);
}
