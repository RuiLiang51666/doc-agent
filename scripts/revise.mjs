// docs-revise workflow 的脚本:按 review 意见返工。
// - 批量模式(有 REVIEW_ID:pull_request_review.submitted 触发;server 形态两种事件都走这里):
//   处理本 PR 上全部「还没被 doc-agent 成功答复过、线程未解决」的行内意见——一次调模型、一个提交、每个线程回一条。
//   (失败回帖不算答复:那条意见一个字都没落实,下次 review 还要重新处理。)
//   同一 PR 的运行由 workflow 并发组 / server 进程内队列串行;排队中被取消或并入的那次运行,它的意见由后一次一并处理。
// - 单条模式(只有 COMMENT_ID:老 workflow 的 pull_request_review_comment 触发):历史行为,只处理触发的这一条。
// 两种模式都显式 add 改动路径再提交;推送被拒先变基再重试(git.mjs),最终失败在线程(或 PR)下如实回帖。
// 整批调模型失败(超时 / 输出被截断)时退化为按线程逐条调用,仍然只提交一次、逐条回帖(见 reviseEdits)。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStage, llmCalls, usageSummary, timeoutTotal } from "./llm.mjs";
import { applyEdits } from "./edits.mjs";
import { loadStyle } from "./style.mjs";
import { runCheck } from "./checklib.mjs";
import { syncTranslation, qaTranslation } from "./translate.mjs";
import { sh, shRead } from "./sh.mjs";
import { ghList } from "./gh.mjs";
import { loadConfig, isSourceDoc } from "./config.mjs";
import { classifyError, TimeoutError } from "./errors.mjs";
import { reportCommentFailure, reportSoftFailure, stepSummary } from "./planlib.mjs";
import { commitPaths, currentBranch, pushWithRebase } from "./git.mjs";
import { pendingThreads, reviseUser, REPLY_MARK, FAIL_MARK } from "./review.mjs";

const { GITHUB_REPOSITORY, PR_NUMBER, REVIEW_ID, COMMENT_ID, COMMENT_BODY, COMMENT_PATH, COMMENT_LINE } =
  process.env;
const batch = Boolean(REVIEW_ID);
const tmp = (name) => join(tmpdir(), name);

// 退出时(任何分支,含失败)把本阶段的模型用量合计写进 Step Summary,供核算成本;没调用过模型就不写。
// 被超时中止的尝试拿不到 usage,汇总表里如实写「中止,无用量」(见 llm.mjs 的 usageSummary)。
process.on("exit", () => {
  const md = usageSummary(llmCalls, "revise");
  if (md) stepSummary(md);
});

// 返工的输出上限:一次 edits JSON 可能含整节搬家 + 多处改号,整篇翻译那档 4096 明显不够,给 8192;
// 显式配了 LLM_MAX_TOKENS 就听它的。不设上限会听凭接口默认(实测 glm-4-flash 只有 1024),悄悄被截断。
export const DEFAULT_REVISE_MAX_TOKENS = 8192;
const reviseMaxTokens = () => Number(process.env.LLM_MAX_TOKENS) || DEFAULT_REVISE_MAX_TOKENS;

// 在线程下回复;正文末尾带隐藏标记,下次运行据此认出「这条是我发的」。
// 返工失败的回帖再带一个失败标记:它不算「已答复」,下次 review 会重新处理这条意见(见 review.mjs 的 isFailureReply)。
function reply(commentId, text, { failed = false } = {}) {
  writeFileSync(tmp("revise-reply.md"), `${text}\n\n${failed ? `${FAIL_MARK}\n` : ""}${REPLY_MARK}`);
  sh(
    `gh api repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/comments/${commentId}/replies -F body=@"${tmp("revise-reply.md")}"`
  );
}

// 失败回帖的正文(整批失败与逐条失败共用)
const failText = (e) =>
  `⚠️ 按这条评论返工失败(原因类别:**${classifyError(e).label}**):${String(e.message || e).slice(0, 400)}\n\n` +
  `这条意见仍算待处理:再提交一次 review(或在本线程下补一条回复)就会重新处理它。`;

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

/**
 * 取本次返工的编辑。默认整批一次调模型(输入只发一遍、改动互相看得见);
 * 整批失败且原因是「超时」或「输出被截断」时,退化为按线程逐条调用:
 * 单条意见的输入一样大,但要生成的 edits 短得多,更可能在超时内完成 —— #5655 的「整节搬家 + 三处改号」就是被输出量拖死的。
 * 逐条处理仍然只提交一次、逐条回帖;失败的线程单独记在 failures 里,回帖带失败标记、不算已答复。
 * 逐条阶段有总时长上限(llm-timeout-total-ms):已用满就不再开新调用,剩下的线程如实记为超时。
 * @returns { edits, failures: Map<rootId, Error> }
 */
async function reviseEdits(threads, system, read) {
  const call = async (ts) =>
    (await runStage({ stage: "revise", system, user: reviseUser(ts, read), maxTokens: reviseMaxTokens() })).edits;
  const failures = new Map();
  try {
    return { edits: await call(threads), failures };
  } catch (e) {
    // 只对「任务太重」这两类退化:接口报错、schema 校验失败之类逐条重来也是一样的结果,白烧钱
    if (threads.length < 2 || !["timeout", "truncated"].includes(classifyError(e).key)) throw e;
    const note = `整批返工失败(原因类别:**${classifyError(e).label}**),退化为按线程逐条处理 ${threads.length} 个线程`;
    console.log(`doc-agent revise:${note}`);
    stepSummary(`> ${note}`);
    const edits = [];
    const budget = timeoutTotal();
    const started = Date.now();
    for (const t of threads) {
      const used = Date.now() - started;
      if (used >= budget) {
        failures.set(
          t.rootId,
          new TimeoutError(
            `逐条返工已累计用时 ${Math.round(used / 1000)}s,超过总时长上限 ${Math.round(budget / 1000)}s` +
              `(llm-timeout-total-ms),这条意见没能开始处理。建议:调大上限,或分几次 review 提交意见。`
          )
        );
        continue;
      }
      try {
        edits.push(...(await call([t])));
      } catch (err) {
        console.error(`doc-agent revise:线程 ${t.rootId} 单独处理仍失败:${String(err.message || err).slice(0, 200)}`);
        failures.set(t.rootId, err);
      }
    }
    if (failures.size === threads.length) throw e; // 一条都没成 → 保持整体失败,走原来的失败回帖路径
    return { edits, failures };
  }
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
  const { edits, failures } = await reviseEdits(threads, system, read);
  // 逐条退化时可能有线程没成:它们不参与提交与解决,单独回一条带失败标记的帖(仍算待处理),并写进日志与 Step Summary
  const done = threads.filter((t) => !failures.has(t.rootId));
  const replyFailures = () => {
    for (const [rootId, err] of failures) {
      reportSoftFailure({ task: `线程 ${rootId} 的返工`, err });
      try {
        reply(rootId, failText(err), { failed: true });
      } catch (err2) {
        reportCommentFailure({
          target: `PR #${PR_NUMBER} 的 review 线程 ${rootId}`,
          permission: "pull-requests: write",
          kind: classifyError(err),
          err: err2,
        });
      }
    }
  };
  if (!edits.length) {
    for (const t of done) reply(t.rootId, "未改动:模型判断这条意见不需要修改文档。如仍需修改,请在本线程补充说明。");
    replyFailures();
    process.exit(failures.size ? 1 : 0); // 一点改动都没落地、还有线程失败 → 如实判失败
  }
  const edited = applyEdits(edits);

  // 改到的源语言文档(canonical,目录与通配见配置)增量同步译文镜像
  const cfg = loadConfig();
  const synced = await Promise.all(edited.filter((p) => isSourceDoc(p, cfg)).map((src) => syncTranslation(src, edits)));

  // 显式 add 本次改动与同步出的译文(不用 commit -a);推送被拒先变基再重试。提交说明只列真正落实了的意见
  const ids = done.flatMap((t) => t.items.map((it) => it.id));
  commitPaths(
    [...edited, ...synced.map((s) => s.target)],
    batch
      ? ["docs: address review comments", `Reply to review comments ${ids.join(", ")}.`]
      : ["docs: address review comment", `Reply to review comment ${COMMENT_ID}.`]
  );
  pushWithRebase(currentBranch());
  const sha = sh(`git rev-parse --short HEAD`).trim();

  // 处理成功的线程各回一条,再标记为已解决(REST 没有这能力,用 GraphQL resolveReviewThread;失败不影响返工结果);
  // 逐条退化时没成的线程回失败帖、不解决(它们下次还要重来)
  for (const t of done) reply(t.rootId, `Done in ${sha} ✅`);
  replyFailures();
  try {
    byComment = byComment || threadsByComment();
    const resolveMutation = `mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}`;
    for (const t of done) {
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
  // 失败时回到每个待处理线程下如实回帖。回帖带失败标记 = **不算已答复**:下次 review 会重新处理这些意见
  // (v1.2.2 把失败回帖也算已答复,#5655 的 4 条意见因此再发 review 也不会重跑,演示直接卡死)。
  // 一条都回不上(或还没拿到意见列表)就在 PR 下回帖。
  const kind = classifyError(e);
  const reason = `(原因类别:**${kind.label}**):${String(e.message || e).slice(0, 400)}`;
  // 回帖被拒(常见 403:revise job 没给 pull-requests: write)不许静默:日志 + Step Summary 写明原因类别与权限提示
  const notice = (target, err) => reportCommentFailure({ target, permission: "pull-requests: write", kind, err });
  let posted = 0;
  let replyErr = null;
  for (const t of threads) {
    try {
      reply(t.rootId, failText(e), { failed: true });
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
