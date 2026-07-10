// 方案 A Phase 1 离线单测:阶段间契约 / schema 校验 / 分阶段模型。纯函数、零网络。
// 跑:node --test
import { test } from "node:test";
import assert from "node:assert/strict";

// modelFor 在模块加载时捕获 LLM_MODEL/LLM_FAST_MODEL,故先设 env 再动态导入
process.env.LLM_MODEL = "strong-x";
process.env.LLM_FAST_MODEL = "fast-x";
const { modelFor, parseStage } = await import("../scripts/llm.mjs");
const { embedContract, readContract, stripContracts } = await import("../scripts/contract.mjs");

test("modelFor:阶段档位默认 == 历史行为", () => {
  for (const s of ["plan", "draft", "revise", "sync"]) assert.equal(modelFor(s), "strong-x");
  for (const s of ["translate", "qa"]) assert.equal(modelFor(s), "fast-x");
});

test("modelFor:LLM_MODEL_<STAGE> 单阶段覆盖", () => {
  process.env.LLM_MODEL_PLAN = "custom-plan";
  assert.equal(modelFor("plan"), "custom-plan");
  assert.equal(modelFor("draft"), "strong-x"); // 不影响其它阶段
  delete process.env.LLM_MODEL_PLAN;
});

test("contract:嵌入 → 读出 往返", () => {
  const human = "给人看的计划正文\n- [ ] `docs/zh/a.md` — 改 A";
  const body = human + embedContract("plan", { sourcePr: 42, items: [{ file: "docs/zh/a.md", change: "改 A" }] });
  const c = readContract("plan", body);
  assert.equal(c.sourcePr, 42);
  assert.equal(c.items[0].file, "docs/zh/a.md");
});

test("contract:无块返回 null(存量 Issue 兼容)", () => {
  assert.equal(readContract("plan", "一段没有契约块的正文"), null);
  assert.equal(readContract("plan", ""), null);
});

test("contract:stripContracts 去块留正文", () => {
  const body = "正文段落" + embedContract("plan", { sourcePr: 1, items: [] });
  const stripped = stripContracts(body);
  assert.ok(stripped.includes("正文段落"));
  assert.ok(!stripped.includes("doc-agent:plan"));
});

test("parseStage plan:合法通过 / 缺字段报错", () => {
  assert.ok(parseStage('{"update":false,"reason":"无影响"}', "plan"));
  assert.ok(parseStage('{"update":true,"items":[{"file":"a","change":"b"}]}', "plan"));
  assert.throws(() => parseStage("{}", "plan"), /update/);
  assert.throws(() => parseStage('{"update":true,"items":[]}', "plan"), /items/);
  assert.throws(() => parseStage('{"update":true,"items":[{"file":"a"}]}', "plan"), /change/);
});

test("parseStage edits:需含 path/old_string/new_string", () => {
  assert.ok(parseStage('{"edits":[{"path":"a","old_string":"x","new_string":"y"}]}', "edits"));
  assert.throws(() => parseStage('{"edits":[{"old_string":"x","new_string":"y"}]}', "edits"), /path/);
  assert.throws(() => parseStage('{"foo":1}', "edits"), /edits/);
});

test("parseStage sync:不要求 path(由调用方补)", () => {
  assert.ok(parseStage('{"edits":[{"old_string":"x","new_string":"y"}]}', "sync"));
  assert.throws(() => parseStage('{"edits":[{"new_string":"y"}]}', "sync"), /old_string/);
});

test("parseStage:容错解析(带 ```json 围栏)", () => {
  const wrapped = '```json\n{"update":false}\n```';
  assert.equal(parseStage(wrapped, "plan").update, false);
});
