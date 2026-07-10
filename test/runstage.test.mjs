// runStage 收口的离线测试:mock 掉 fetch,验证「选模型 → 调用 → 按 shape 解析」整条链路。
// 跑:node --test
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.LLM_MODEL = "strong-x";
process.env.LLM_FAST_MODEL = "fast-x";
process.env.LLM_API_KEY = "test-key";
const { runStage } = await import("../scripts/llm.mjs");

let lastBody;
function mockFetch(content) {
  return async (_url, opts) => {
    lastBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  };
}

test("runStage:有 shape 的阶段(plan)→ 返回校验后的对象", async () => {
  global.fetch = mockFetch('{"update":true,"items":[{"file":"a.md","change":"x"}]}');
  const out = await runStage({ stage: "plan", system: "s", user: "u" });
  assert.equal(out.update, true);
  assert.equal(out.items[0].file, "a.md");
});

test("runStage:无 shape 的阶段(qa)→ 返回模型原始文本", async () => {
  global.fetch = mockFetch("译文质检:准确、无翻译腔。");
  const out = await runStage({ stage: "qa", system: "s", user: "u" });
  assert.equal(out, "译文质检:准确、无翻译腔。");
});

test("runStage:模型跑偏(plan 缺 items)→ 抛出指名校验错", async () => {
  global.fetch = mockFetch('{"update":true}');
  await assert.rejects(() => runStage({ stage: "plan", system: "s", user: "u" }), /items/);
});

test("runStage:按阶段选对模型(强 vs 快)", async () => {
  global.fetch = mockFetch('{"update":false}');
  await runStage({ stage: "plan", system: "s", user: "u" });
  assert.equal(lastBody.model, "strong-x"); // plan → 强

  global.fetch = mockFetch("质检文本");
  await runStage({ stage: "qa", system: "s", user: "u" });
  assert.equal(lastBody.model, "fast-x"); // qa → 快
});
