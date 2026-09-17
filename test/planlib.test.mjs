// plan 护栏的离线单测:异常分类 / 计划 Issue 查重 / 计划条目路径校验 / Step Summary / 回帖被拒的提示。纯函数、零网络。
// 跑:node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  classifyError,
  findPlanIssue,
  stepSummary,
  normalizePlanItems,
  reportCommentFailure,
} from "../scripts/planlib.mjs";
import { BudgetError } from "../scripts/budget.mjs";
import { TruncatedError, PushError } from "../scripts/errors.mjs";
import { embedContract } from "../scripts/contract.mjs";
import { parseStage } from "../scripts/llm.mjs";
import { loadConfig } from "../scripts/config.mjs";

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

test("classifyError:模型输出被截断、推送失败各自成类", () => {
  assert.equal(classifyError(new TruncatedError("模型输出被截断(finish_reason=length)")).label, "模型输出被截断");
  assert.equal(classifyError(new PushError("推送 docs/plan-3 失败")).label, "推送失败");
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

test("normalizePlanItems:已有文件照常;不存在的视为新建(须在源文档目录内);越界路径抛「模型输出不符合约定」", () => {
  const root = mkdtempSync(join(tmpdir(), "doc-agent-items-"));
  mkdirSync(join(root, "docs/zh"), { recursive: true });
  writeFileSync(join(root, "docs/zh/a.md"), "# A\n");
  const cfg = loadConfig({});
  assert.deepEqual(
    normalizePlanItems(
      [
        { file: "docs/zh/a.md", change: "改 A", create: true }, // 文件已存在:不当新建
        { file: "docs/zh/guide/b.md", change: "新建 B" }, // 模型漏写 create:按不存在推断
      ],
      cfg,
      { root }
    ),
    [
      { file: "docs/zh/a.md", change: "改 A" },
      { file: "docs/zh/guide/b.md", change: "新建 B", create: true },
    ]
  );
  for (const file of ["../x.md", "/etc/x.md", "docs/en/new.md", "docs/zh/../../x.md"])
    assert.throws(
      () => normalizePlanItems([{ file, change: "x" }], cfg, { root }),
      (e) => classifyError(e).label === "模型输出校验失败",
      file
    );
});

test("stepSummary:有 GITHUB_STEP_SUMMARY 就追加写入,没有(server 形态)返回 false", () => {
  const file = join(mkdtempSync(join(tmpdir(), "doc-agent-summary-")), "summary.md");
  assert.equal(stepSummary("第一行", { GITHUB_STEP_SUMMARY: file }), true);
  assert.equal(stepSummary("第二行", { GITHUB_STEP_SUMMARY: file }), true);
  assert.equal(readFileSync(file, "utf8"), "第一行\n\n第二行\n\n");
  assert.equal(stepSummary("x", {}), false);
});

test("reportCommentFailure:回帖 403 → 日志打出位置 + gh 原因 + 权限提示,并连同原因类别写进 Step Summary", () => {
  // 用 execSync 的真实报错对象(与 sh.mjs 同源),原因取 stderr 最后一行、去掉 "gh: "
  let err;
  try {
    execSync(`node -e 'process.stderr.write("gh: Resource not accessible by integration (HTTP 403)\\n"); process.exit(1)'`, { stdio: "pipe" });
  } catch (e) {
    err = e;
  }
  const file = join(mkdtempSync(join(tmpdir(), "doc-agent-summary-")), "summary.md");
  const logged = [];
  const orig = console.error;
  console.error = (m) => logged.push(m);
  try {
    const hint = reportCommentFailure({
      target: "PR #1",
      permission: "pull-requests: write",
      kind: classifyError(new Error('LLM 429: {"error":{"code":"1113"}}')),
      err,
      env: { GITHUB_STEP_SUMMARY: file },
    });
    const expected = "无法在 PR #1 下回帖:Resource not accessible by integration (HTTP 403),请检查 workflow 的 pull-requests: write 权限";
    assert.equal(hint, expected);
    assert.deepEqual(logged, [expected]);
    assert.equal(readFileSync(file, "utf8"), `> ⚠️ **失败说明没能回帖**(本次失败原因类别:**模型接口报错**)——${expected}\n\n`);
  } finally {
    console.error = orig;
  }
});
