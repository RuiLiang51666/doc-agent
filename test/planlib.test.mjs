// plan 护栏的离线单测:异常分类 / 计划 Issue 查重 / Step Summary。纯函数、零网络。
// 跑:node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyError, findPlanIssue, stepSummary } from "../scripts/planlib.mjs";
import { BudgetError } from "../scripts/budget.mjs";
import { embedContract } from "../scripts/contract.mjs";
import { parseStage } from "../scripts/llm.mjs";

test("classifyError:超预算 / 模型接口报错 / 模型输出校验失败 / 其他异常", () => {
  assert.equal(classifyError(new BudgetError("x")).label, "超预算");
  assert.equal(classifyError(new Error('LLM 400: {"error":"context too long"}')).label, "模型接口报错");
  assert.equal(classifyError(new Error("LLM 429: 您的账户已达到速率限制")).label, "模型接口报错");
  const abort = new Error("This operation was aborted");
  abort.name = "AbortError";
  assert.equal(classifyError(abort).label, "模型接口报错");
  assert.equal(classifyError(new TypeError("fetch failed")).label, "模型接口报错");
  // 用 llm.mjs 真实抛出的错误,防止两边措辞漂移
  const schemaErr = (() => { try { parseStage('{"update":true}', "plan"); } catch (e) { return e; } })();
  assert.equal(classifyError(schemaErr).label, "模型输出校验失败");
  const jsonErr = (() => { try { parseStage("不是 JSON", "plan"); } catch (e) { return e; } })();
  assert.equal(classifyError(jsonErr).label, "模型输出校验失败");
  assert.equal(classifyError(new Error("Command failed: git diff abc^1 abc")).label, "其他异常");
});

test("findPlanIssue:按契约 sourcePr 定位,存量 Issue 退回认标题 (#N)", () => {
  const withContract = { number: 11, title: "📝 docs: 记录 size() (#42)", body: "正文" + embedContract("plan", { sourcePr: 42, items: [] }) };
  const legacy = { number: 5, title: "📝 docs: 记录 has() (#7)", body: "源代码变更:#7 @ abc" };
  const other = { number: 12, title: "📝 docs: 别的 (#43)", body: "x" + embedContract("plan", { sourcePr: 43, items: [] }) };
  assert.equal(findPlanIssue([other, withContract, legacy], 42).number, 11);
  assert.equal(findPlanIssue([other, withContract, legacy], "7").number, 5);
  assert.equal(findPlanIssue([other, withContract, legacy], 8), null);
  assert.equal(findPlanIssue([], 42), null);
  // 有契约时只认契约:标题碰巧带 (#9) 也不算
  const mismatch = { number: 13, title: "📝 docs: x (#9)", body: embedContract("plan", { sourcePr: 10, items: [] }) };
  assert.equal(findPlanIssue([mismatch], 9), null);
  assert.equal(findPlanIssue([{ number: 14, title: "📝 docs: y (#70)", body: "" }], 7), null); // (#70) 不是 (#7)
});

test("stepSummary:有 GITHUB_STEP_SUMMARY 就追加写入,没有(server 形态)返回 false", () => {
  const file = join(mkdtempSync(join(tmpdir(), "doc-agent-summary-")), "summary.md");
  assert.equal(stepSummary("第一行", { GITHUB_STEP_SUMMARY: file }), true);
  assert.equal(stepSummary("第二行", { GITHUB_STEP_SUMMARY: file }), true);
  assert.equal(readFileSync(file, "utf8"), "第一行\n\n第二行\n\n");
  assert.equal(stepSummary("x", {}), false);
});
