// plan 阶段的护栏与输入组装:异常分类、计划 Issue 查重、Step Summary、读文档 + 组装 prompt。
import { readFileSync, appendFileSync } from "node:fs";
import { readContract } from "./contract.mjs";
import { isSourceDoc } from "./config.mjs";
import { trackedFiles, diffFilesFor } from "./diff.mjs";
import { buildPlanPrompt } from "./prefilter.mjs";

/** 异常 → 原因类别(回帖给人看):超预算 / 模型接口报错 / 模型输出校验失败 / 其他异常。 */
export function classifyError(e) {
  const msg = String((e && e.message) || e);
  if (e && e.code === "DOC_AGENT_BUDGET") return { key: "budget", label: "超预算" };
  if (/模型输出不符合约定|无法从模型输出解析 JSON/.test(msg)) return { key: "schema", label: "模型输出校验失败" };
  if (
    /^LLM \d{3}\b/.test(msg) ||
    (e && e.name === "AbortError") ||
    /operation was aborted|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(msg)
  )
    return { key: "api", label: "模型接口报错" };
  return { key: "other", label: "其他异常" };
}

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

/** 写入 $GITHUB_STEP_SUMMARY;server 形态没有这个文件,只打日志(返回 false)。 */
export function stepSummary(md, env = process.env) {
  if (!env.GITHUB_STEP_SUMMARY) return false;
  appendFileSync(env.GITHUB_STEP_SUMMARY, `${md}\n\n`);
  return true;
}

/** 当前 checkout 里全部源语言文档:[{ path, text }]。 */
export const readSourceDocs = (cfg) =>
  trackedFiles()
    .filter((p) => isSourceDoc(p, cfg))
    .map((path) => ({ path, text: readFileSync(path, "utf8") }));

/** 组装 plan 输入(不调模型):读 assess 提示词、逐文件取 diff、读文档、预筛 + 预算。 */
export function planInput({ cfg, sha, prNumber, prTitle, codeFiles }) {
  const system = readFileSync(new URL("../prompts/assess.md", import.meta.url), "utf8");
  const diffFiles = diffFilesFor(sha, codeFiles);
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
