// docs-draft workflow 的脚本:按已批准的计划写初稿,提文档 PR。
// 计划里可以有新建文档(契约 items[].create,或文件当前不存在):路径限定在源文档目录内、禁止穿越;
// 新建的文档与新生成的译文都显式 add 进提交。取 diff 与 plan 同一套口径(resolveDiffRange)。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStage, llmCalls, usageSummary } from "./llm.mjs";
import { readContract, stripContracts } from "./contract.mjs";
import { applyEdits } from "./edits.mjs";
import { loadStyle } from "./style.mjs";
import { runCheck } from "./checklib.mjs";
import { syncTranslation, qaTranslation } from "./translate.mjs";
import { sh, shRead } from "./sh.mjs";
import { loadConfig, isSourceDoc, checkNewDocPath } from "./config.mjs";
import { resolveDiffRange, describeRange, codeChangedFiles, diffFilesFor } from "./diff.mjs";
import { buildDiffText } from "./budget.mjs";
import { classifyError } from "./errors.mjs";
import { reportCommentFailure, reportSoftFailure, stepSummary } from "./planlib.mjs";
import { commitPaths, pushWithRebase } from "./git.mjs";

const { GITHUB_REPOSITORY, ISSUE_NUMBER, ISSUE_BODY } = process.env;
const tmp = (name) => join(tmpdir(), name);

// 退出时(任何分支,含失败)把本阶段的模型用量合计(初稿 + 译文同步 / 整篇翻译 + 译文质检)写进 Step Summary;没调用过模型就不写
process.on("exit", () => {
  const md = usageSummary(llmCalls, "draft");
  if (md) stepSummary(md);
});

// 从计划 Issue 解出源 PR 号和待改文件:优先读机读契约(方案 A ①),
// 读不到(嵌契约之前建的存量 Issue)则回退到正则抠正文。
const contract = readContract("plan", ISSUE_BODY);
const prNum = contract ? String(contract.sourcePr) : (ISSUE_BODY.match(/#(\d+)/) || [])[1];
const planFiles = contract
  ? contract.items.map((i) => i.file)
  : [...ISSUE_BODY.matchAll(/- \[ \] `([^`]+)`/g)].map((m) => m[1]);
if (planFiles.length === 0) process.exit(0);

const branch = `docs/plan-${ISSUE_NUMBER}`;

// 幂等:重复 /approve 时若文档 PR 已建过就跳过,避免重复建分支/PR 报错
if (shRead(`gh pr list --head ${branch} --state all --json number --jq 'length'`).trim() !== "0") {
  console.log(`文档 PR(${branch})已存在,跳过`);
  process.exit(0);
}

try {
  sh(`git config user.name docs-bot`);
  sh(`git config user.email docs-bot@users.noreply.github.com`);
  sh(`git switch -c ${branch}`);

  const cfg = loadConfig();
  const system =
    readFileSync(new URL("../prompts/draft.md", import.meta.url), "utf8") +
    "\n\n# 技术写作规范\n" +
    loadStyle();
  // 计划里列出、当前还不存在的文件 = 要新建的文档:路径先过校验(源文档目录内、不许穿越),再提示模型用 create 编辑给全文
  const newFiles = planFiles.filter((f) => !existsSync(f));
  newFiles.forEach((f) => checkNewDocPath(f, cfg));
  const current = planFiles
    .map(
      (f) =>
        `=== ${f} ===\n${newFiles.includes(f) ? "(新建文件:当前不存在。用 create 编辑给出完整内容)" : readFileSync(f, "utf8")}`
    )
    .join("\n\n");

  // 已合并的代码 diff:配置项名、默认值、行为边界只在代码里,不给就只能靠猜。
  // 合并提交优先取契约;存量 Issue 抠正文 "@ <sha>";再不行问 GitHub。区间按合并方式定(rebase 合并取全部提交)。
  // 受 diff 预算约束,超出按文件截断并标注。
  const mergeSha =
    contract?.mergeSha ||
    (ISSUE_BODY.match(/@ ([0-9a-f]{7,40})\b/) || [])[1] ||
    shRead(`gh pr view ${prNum} --json mergeCommit --jq .mergeCommit.oid`).trim();
  const range = resolveDiffRange({ sha: mergeSha, prNumber: prNum, repo: GITHUB_REPOSITORY });
  const codeDiff = buildDiffText(diffFilesFor(range, codeChangedFiles(range, cfg)), cfg.diffTokenBudget);

  // 喂模型前剥掉契约块(内部数据,不是给模型读的正文)
  const { edits } = await runStage({
    stage: "draft",
    system,
    user: `批准的计划(Issue #${ISSUE_NUMBER}):\n${stripContracts(ISSUE_BODY)}\n\n已合并的代码 diff(源 PR #${prNum},${describeRange(range)}):\n${codeDiff.text || "(配置的代码路径下没有改动)"}\n\n当前文档:\n${current}`,
  });
  // 新建文件只放行源文档目录内的合规路径
  const editedPaths = applyEdits(edits, { assertCreatable: (p) => checkNewDocPath(p, cfg) });

  // 增量同步译文镜像:只把本次源语言文档的改动反映到译文目录(多文件并行;新建的源文档整篇翻译)
  const enPairs = await Promise.all(
    editedPaths.filter((p) => isSourceDoc(p, cfg)).map((src) => syncTranslation(src, edits))
  );

  const base = shRead(`gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`).trim();
  let prTitle = "";
  try {
    prTitle = shRead(`gh pr view ${prNum} --json title --jq .title`).trim();
  } catch {}

  // 文档改动清单:有契约就直接用其 items;否则复用计划正文的"必须更新"段(去勾选框),再退回改动文件列表
  const planItems = ((ISSUE_BODY.match(/\*\*必须更新\*\*\s*\n([\s\S]*?)\n\s*\n/) || [, ""])[1] || "").replace(
    /- \[ \] /g,
    "- "
  );
  const changed = contract
    ? contract.items.map((i) => `- \`${i.file}\`${i.create ? "(新建)" : ""} — ${i.change}`).join("\n")
    : planItems || editedPaths.map((p) => "- `" + p + "`").join("\n");

  const body = `## 背景
依据已合并的代码改动 **#${prNum}${prTitle ? ` — ${prTitle}` : ""}** 自动更新文档,执行已批准的计划 #${ISSUE_NUMBER}。

## 文档改动
${changed}

## 目标分支
\`${base}\`

---
Source: #${prNum} · Closes #${ISSUE_NUMBER}`;

  // 文档 PR 标题复用计划 Issue 的描述性标题(去掉前缀 📝)
  const issueTitle = shRead(`gh issue view ${ISSUE_NUMBER} --json title --jq .title`).trim();
  const docTitle = issueTitle.replace(/^📝\s*/, "").replace(/["`$\\]/g, "");

  writeFileSync(tmp("pr.md"), body);
  // 显式 add:本次编辑过的文档(含新建)+ 同步出的译文(含新生成的)。不用 commit -a,否则新文件进不了提交
  commitPaths([...editedPaths, ...enPairs.map((p) => p.target)], docTitle);
  // 远端已有同名分支(上次推送成功、建 PR 失败)时被拒 → 变基后重试
  pushWithRebase(branch);
  const out = sh(
    `gh pr create --base ${base} --head ${branch} --title "${docTitle}" --label docs/draft --body-file "${tmp("pr.md")}"`
  ).trim();

  // 文档审核(拼写/坏链):只查本次改动的文档,提示性贴评论、不阻断;失败也要看得见(日志 + Step Summary)
  const docPr = (out.match(/\/pull\/(\d+)/) || [])[1];
  const changedDocs = [...editedPaths, ...enPairs.map((p) => p.target)];
  if (docPr)
    await runCheck(docPr, changedDocs).catch((e) => reportSoftFailure({ task: "文档审核", err: e }));

  // 译文质检(LLM-as-judge):准确性/连贯性/翻译腔,提示性贴评论。
  // 失败不许吞掉(v1.2.1 把异常吞成 null,Apollo 回放里的质检失败一声不响):日志、Step Summary 与 PR 回帖都写明原因类别
  if (docPr && enPairs.length) {
    try {
      const report = await qaTranslation(enPairs);
      writeFileSync(tmp("qa.md"), `🌐 **译文质检**(提示性)\n\n${report}`);
      sh(`gh pr comment ${docPr} --body-file "${tmp("qa.md")}"`);
    } catch (e) {
      reportSoftFailure({ task: "译文质检", err: e, pr: docPr, file: tmp("qa-fail.md") });
    }
  }
} catch (e) {
  // 失败时在计划 Issue 上留言(带原因类别),让人看得见(而不是只在 Actions 里红一下)
  const kind = classifyError(e);
  writeFileSync(
    tmp("draft-err.md"),
    `⚠️ 自动写初稿失败(原因类别:**${kind.label}**),请看 Actions 日志,或重新评论 \`/approve\` 重试。\n\n\`\`\`\n${String(e.message || e).slice(0, 500)}\n\`\`\``
  );
  try {
    sh(`gh issue comment ${ISSUE_NUMBER} --body-file "${tmp("draft-err.md")}"`);
  } catch (err) {
    // 回帖被拒不许静默(同 plan):日志 + Step Summary 写明原因类别与权限提示
    reportCommentFailure({ target: `Issue #${ISSUE_NUMBER}`, permission: "issues: write", kind, err });
  }
  console.error(e);
  process.exit(1);
}
