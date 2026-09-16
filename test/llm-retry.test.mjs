// 限流退避与输出截断检测的离线单测:mock 掉 fetch,注入 wait / random,不真等、不联网。
// 跑:node --test
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.LLM_API_KEY = "test-key";
const { callLLM, backoffDelay } = await import("../scripts/llm.mjs");
const { classifyError } = await import("../scripts/errors.mjs");

// 按顺序回放响应({ ok, content, finish } 或 { status, body, retryAfter } 或 { throws });记录每次请求体
function scripted(responses) {
  const calls = [];
  global.fetch = async (_url, opts) => {
    calls.push(JSON.parse(opts.body));
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r.throws) throw new TypeError(r.throws);
    if (r.ok)
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: r.content }, finish_reason: r.finish ?? "stop" }] }),
      };
    return {
      ok: false,
      status: r.status,
      headers: { get: (k) => (k.toLowerCase() === "retry-after" ? r.retryAfter ?? null : null) },
      text: async () => r.body ?? "",
    };
  };
  return calls;
}
// 记录每次等待的毫秒数;random 固定 0.5 → 等待 = 0.75 × d
const recorder = () => {
  const waits = [];
  return { waits, opts: { wait: async (ms) => void waits.push(ms), random: () => 0.5 } };
};
const RATE = '{"error":{"code":"1302","message":"您的账户已达到速率限制,请您控制请求频率"}}';

test("backoffDelay:指数增长、单次封顶 60s,落在 [d/2, d]", () => {
  assert.equal(backoffDelay(1, () => 0), 1000);
  assert.equal(backoffDelay(1, () => 1), 2000);
  assert.equal(backoffDelay(3, () => 1), 8000);
  assert.equal(backoffDelay(10, () => 1), 60000);
  assert.equal(backoffDelay(10, () => 0), 30000);
});

test("callLLM:429 + 智谱 1302 按指数退避(带抖动)重试后成功", async () => {
  delete process.env.LLM_RETRY_MAX_WAIT_MS;
  const calls = scripted([{ status: 429, body: RATE }, { status: 429, body: RATE }, { ok: true, content: "好了" }]);
  const { waits, opts } = recorder();
  assert.equal(await callLLM("s", "u", "m", opts), "好了");
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [1500, 3000]);
});

test("callLLM:业务码 1302 即使 HTTP 400 也重试;Retry-After 作为等待下限;网络异常最多 3 次", async () => {
  scripted([{ status: 400, body: RATE, retryAfter: "7" }, { ok: true, content: "ok" }]);
  let rec = recorder();
  assert.equal(await callLLM("s", "u", "m", rec.opts), "ok");
  assert.deepEqual(rec.waits, [7000]);

  const calls = scripted([{ throws: "fetch failed" }]);
  rec = recorder();
  await assert.rejects(() => callLLM("s", "u", "m", rec.opts), /fetch failed/);
  assert.equal(calls.length, 3);
  assert.equal(rec.waits.length, 2);
});

test("callLLM:累计等待再等就超上限时停下,如实抛「LLM 429」并写明上限(可配置)", async () => {
  process.env.LLM_RETRY_MAX_WAIT_MS = "10000";
  const calls = scripted([{ status: 429, body: RATE }]);
  const { waits, opts } = recorder();
  await assert.rejects(
    () => callLLM("s", "u", "m", opts),
    (e) => /^LLM 429: /.test(e.message) && /上限 10s/.test(e.message) && classifyError(e).label === "模型接口报错"
  );
  assert.deepEqual(waits, [1500, 3000]); // 再等 6000 就累计 10500 > 10000
  assert.equal(calls.length, 3);
  delete process.env.LLM_RETRY_MAX_WAIT_MS;
});

test("callLLM:额度类业务码(1113 欠费)与普通 4xx 不重试,立即抛", async () => {
  for (const r of [
    { status: 429, body: '{"error":{"code":"1113","message":"您的账户已欠费"}}' },
    { status: 400, body: '{"error":"bad request"}' },
  ]) {
    const calls = scripted([r]);
    const { waits, opts } = recorder();
    await assert.rejects(() => callLLM("s", "u", "m", opts), /LLM (429|400): /);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  }
});

test("callLLM:finish_reason=length → 抛 TruncatedError,归类「模型输出被截断」;LLM_MAX_TOKENS 透传为 max_tokens", async () => {
  process.env.LLM_MAX_TOKENS = "512";
  const calls = scripted([{ ok: true, content: '{"edits":[{"path":"docs/zh/a.md","old_str', finish: "length" }]);
  await assert.rejects(
    () => callLLM("s", "u", "m", recorder().opts),
    (e) => e.code === "DOC_AGENT_TRUNCATED" && classifyError(e).label === "模型输出被截断" && /LLM_MAX_TOKENS/.test(e.message)
  );
  assert.equal(calls[0].max_tokens, 512);
  delete process.env.LLM_MAX_TOKENS;
  const calls2 = scripted([{ ok: true, content: "x" }]);
  assert.equal(await callLLM("s", "u", "m", recorder().opts), "x");
  assert.ok(!("max_tokens" in calls2[0]));
});
