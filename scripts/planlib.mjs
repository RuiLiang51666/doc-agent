// plan 阶段的护栏与输入组装:异常分类、计划 Issue 查重、计划条目路径校验、Step Summary、源 PR 回帖、读文档 + 组装 prompt。
// 其中「回帖被拒时的提示」(reportCommentFailure)draft / revise 也用。
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { sh } from "./sh.mjs";
import { readContract } from "./contract.mjs";
import { isSourceDoc, assertRepoPath, checkNewDocPath } from "./config.mjs";
import { trackedFiles, diffFilesFor } from "./diff.mjs";
import { buildPlanPrompt } from "./prefilter.mjs";

// 异常分类挪到 errors.mjs(draft / revise / translate 也要用);这里转出,原有引用路径照常可用
export { classifyError } from "./errors.mjs";

/**
 * 在计划 Issue 列表里找同一源 PR 的那个:有契约就只认契约里的 sourcePr;
 * 嵌契约之前建的存量 Issue 退回认标题结尾的 "(#N)"。找不到返回 null。
 */
export function findPlanIssue(issues, prNumber) {
  const n = Number(prNumber);
  const titleRe = new RegExp(`\\(#${n}\\)\\s*$`);
  return (
    (issues || []).find((i) => {
      const c = readContract("plan", i.body);
      return c ? Number(c.sourcePr) === n : titleRe.test(i.title || "");
    }) || null
  );
}

/**
 * 规整模型给的计划条目:路径必须是仓库内相对路径(不许绝对路径、..、反斜杠);
 * 当前不存在的文件视为新建文档,还必须落在源文档目录内(见 config.mjs 的 checkNewDocPath),并打上 create: true。
 * 不合规抛「模型输出不符合约定」,plan 据此归类为「模型输出校验失败」回帖。
 */
export function normalizePlanItems(items, cfg, { root = process.cwd() } = {}) {
  return items.map((it, i) => {
    try {
      assertRepoPath(it.file);
      if (existsSync(join(root, it.file))) return { file: it.file, change: it.change };
      checkNewDocPath(it.file, cfg, root);
      return { file: it.file, change: it.change, create: true };
    } catch (e) {
      throw new Error(`模型输出不符合约定:items[${i}] ${e.message}`);
    }
  });
}

/** 写入 $GITHUB_STEP_SUMMARY;server 形态没有这个文件,只打日志(返回 false)。 */
export function stepSummary(md, env = process.env) {
  if (!env.GITHUB_STEP_SUMMARY) return false;
  appendFileSync(env.GITHUB_STEP_SUMMARY, `${md}\n\n`);
  return true;
}

// gh 报错里最有用的一行:取 stderr(没有就取 message)的最后一个非空行,去掉 "gh: " 前缀
const ghReason = (err) => {
  const lines = String((err && (err.stderr || err.message)) || err)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return (lines.at(-1) || "未知错误").replace(/^gh:\s*/, "").slice(0, 200);
};

/**
 * 回帖本身失败了(常见 403:workflow 没给对应的写权限)时调用,不许再静默吞掉(plan / draft / revise 共用):
 * 日志打出「无法在 <位置> 下回帖:<原因>,请检查 workflow 的 <权限> 权限」,连同背景写进 Step Summary。
 * 背景默认是「本次失败原因类别」(传 kind);不是失败说明的回帖(如 plan 的「无需更新」结论)传 context。返回那行提示。
 */
export function reportCommentFailure({ target, permission, err, kind, context, env = process.env }) {
  const hint = `无法在 ${target} 下回帖:${ghReason(err)},请检查 workflow 的 ${permission} 权限`;
  console.error(hint);
  stepSummary(`> ⚠️ **doc-agent 回帖没发出去**(${context || `本次失败原因类别:**${kind.label}**`})——${hint}`, env);
  return hint;
}

/**
 * 在被合并的代码 PR 下回帖(plan 的失败说明与「无需更新」结论共用)。PR 评论走 issues 接口,需要 pull-requests: write。
 * 被拒不抛:走 reportCommentFailure(日志 + Step Summary)。返回是否发出。
 */
export function commentOnPr({ repo, pr, body, file, kind, context, run = sh, env = process.env }) {
  try {
    writeFileSync(file, body);
    run(`gh api repos/${repo}/issues/${pr}/comments -F body=@"${file}"`);
    return true;
  } catch (err) {
    reportCommentFailure({ target: `PR #${pr}`, permission: "pull-requests: write", err, kind, context, env });
    return false;
  }
}

/** 本次 Actions 运行的链接;server 形态没有 GITHUB_RUN_ID,返回 ""。 */
export const runUrl = (env = process.env) =>
  env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL || "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : "";

// 「无需更新」评论末尾的隐藏标记,带理由的指纹:同一 PR 重复触发(Re-run、webhook 重投)且理由相同,就认出来不重发
const noUpdateMark = (reason) =>
  `<!-- doc-agent:no-update ${createHash("sha256").update(String(reason ?? "")).digest("hex").slice(0, 12)} -->`;

/** plan 判定无需更新时,发在被合并的代码 PR 下的评论:已评估、结论、模型理由原文、运行链接。 */
export function noUpdateComment({ reason, runLink }) {
  const quoted = String(reason || "(模型没有给出理由)")
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  return `✅ doc-agent 已评估本 PR 的文档影响,结论:**无需更新文档**。

模型给出的理由(原文):
${quoted}
${runLink ? `\n运行记录:${runLink}\n` : ""}
${noUpdateMark(reason)}`;
}

/** 这些 PR 评论里是否已有理由相同的「无需更新」评论。 */
export const hasNoUpdateComment = (comments, reason) =>
  (comments || []).some((c) => String(c.body || "").includes(noUpdateMark(reason)));

/** 当前 checkout 里全部源语言文档:[{ path, text }]。 */
export const readSourceDocs = (cfg) =>
  trackedFiles()
    .filter((p) => isSourceDoc(p, cfg))
    .map((path) => ({ path, text: readFileSync(path, "utf8") }));

/** 组装 plan 输入(不调模型):读 assess 提示词、按区间逐文件取 diff、读文档、预筛 + 预算。range 见 diff.mjs。 */
export function planInput({ cfg, range, prNumber, prTitle, codeFiles }) {
  const system = readFileSync(new URL("../prompts/assess.md", import.meta.url), "utf8");
  const diffFiles = diffFilesFor(range, codeFiles);
  const docs = readSourceDocs(cfg);
  return { system, ...buildPlanPrompt({ prNumber, prTitle, system, diffFiles, docs, codeFiles, cfg }) };
}

/** 一行摘要,给日志 / Step Summary / 干跑用。 */
export function formatStats(stats) {
  const cut = stats.diff.truncated.length ? `(已截断 ${stats.diff.truncated.length} 个)` : "";
  return (
    `预筛:代码 diff ${stats.diff.files} 个文件${cut},约 ${stats.diff.tokens} token(diff 预算 ${stats.diff.budget});` +
    `附全文文档 ${stats.selected.length}/${stats.docsTotal} 篇;plan 输入估算 ${stats.tokens} token(预算 ${stats.budget})`
  );
}
