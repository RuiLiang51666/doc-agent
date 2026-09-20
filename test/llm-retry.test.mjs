// 限流退避、输出截断检测与用量记录的离线单测:mock 掉 fetch,注入 wait / random / log,不真等、不联网。
// 跑:node --test
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.LLM_API_KEY = "test-key";
const { callLLM, backoffDelay, llmCalls, usageSummary, DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_TOTAL_MS, stageTimeout } =
  await import("../scripts/llm.mjs");
const { classifyError } = await import("../scripts/errors.mjs");

// 按顺序回放响应({ ok, content, finish, usage } 或 { status, body, retryAfter } 或 { throws });记录每次请求体
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
        json: async () => ({
          choices: [{ message: { content: r.content }, finish_reason: r.finish ?? "stop" }],
          ...(r.usage ? { usage: r.usage } : {}),
        }),
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
// 记录每次等待的毫秒数与日志行;random 固定 0.5 → 等待 = 0.75 × d
const recorder = () => {
  const waits = [];
  const logs = [];
  return { waits, logs, opts: { wait: async (ms) => void waits.push(ms), random: () => 0.5, log: (m) => logs.push(m) } };
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

const USAGE = { prompt_tokens: 58934, completion_tokens: 120, total_tokens: 59054 };

test("callLLM 用量:接口返回 usage → 日志写明输入 / 输出 / 合计 token、重试 0 次,并记进 llmCalls", async () => {
  delete process.env.LLM_RETRY_MAX_WAIT_MS;
  scripted([{ ok: true, content: "ok", usage: USAGE }]);
  const { logs, opts } = recorder();
  const before = llmCalls.length;
  assert.equal(await callLLM("s", "u", "glm-4.6", { ...opts, stage: "plan" }), "ok");
  assert.deepEqual(logs, ["[llm] plan · glm-4.6:token 用量 输入 58934 / 输出 120 / 合计 59054;重试 0 次,累计等待 0s"]);
  assert.deepEqual(llmCalls.slice(before), [
    { stage: "plan", model: "glm-4.6", ok: true, usage: { prompt: 58934, completion: 120, total: 59054 }, retries: 0, waitedMs: 0, timeouts: 0 },
  ]);
});

test("callLLM 用量:接口没返回 usage → 日志写「接口未返回」", async () => {
  scripted([{ ok: true, content: "ok" }]);
  const { logs, opts } = recorder();
  await callLLM("s", "u", "m", opts);
  assert.deepEqual(logs, ["[llm] m:token 用量 接口未返回;重试 0 次,累计等待 0s"]);
  assert.equal(llmCalls.at(-1).usage, null);
});

test("callLLM 用量:限流重试 2 次后成功 → 日志写明重试次数与累计等待;重试用尽的失败调用也记一条", async () => {
  scripted([{ status: 429, body: RATE }, { status: 429, body: RATE }, { ok: true, content: "好了", usage: USAGE }]);
  let rec = recorder();
  await callLLM("s", "u", "glm-4.6", { ...rec.opts, stage: "draft" });
  assert.deepEqual(rec.waits, [1500, 3000]);
  assert.deepEqual(rec.logs, ["[llm] draft · glm-4.6:token 用量 输入 58934 / 输出 120 / 合计 59054;重试 2 次,累计等待 4.5s"]);
  assert.equal(llmCalls.at(-1).retries, 2);
  assert.equal(llmCalls.at(-1).waitedMs, 4500);

  process.env.LLM_RETRY_MAX_WAIT_MS = "10000";
  scripted([{ status: 429, body: RATE }]);
  rec = recorder();
  await assert.rejects(() => callLLM("s", "u", "glm-4.6", { ...rec.opts, stage: "plan" }), /^Error: LLM 429/);
  assert.deepEqual(rec.logs, ["[llm] plan · glm-4.6 调用失败:token 用量 接口未返回;重试 2 次,累计等待 4.5s"]);
  assert.equal(llmCalls.at(-1).ok, false);
  delete process.env.LLM_RETRY_MAX_WAIT_MS;
});

// 服务端挂住不回:只有超时中止才让这次尝试结束
const hangs = () => {
  global.fetch = (_url, opts) =>
    new Promise((_r, reject) =>
      opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })))
    );
};

test("callLLM 超时:不做同参数重试,只换翻倍的超时再试一次;失败信息写明实际超时值、尝试次数与建议动作", async () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 300000); // 覆盖实测到过的约 210s 单次耗时
  process.env.LLM_TIMEOUT_MS = "120"; // 每次调用时读,模块加载后改照样生效
  hangs();
  const { logs, waits, opts } = recorder();
  await assert.rejects(
    () => callLLM("s", "u", "glm-4.6", { ...opts, stage: "revise" }),
    (e) =>
      e.code === "DOC_AGENT_TIMEOUT" &&
      classifyError(e).label === "模型调用超时" &&
      /已尝试 2 次/.test(e.message) &&
      /每次超时上限依次为 0\.1s、0\.2s/.test(e.message) && // 实际超时值:原值 + 翻倍
      /总时长上限 900s/.test(e.message) &&
      /不做同参数重试/.test(e.message) &&
      /调大 llm-timeout-ms-revise/.test(e.message) && // 建议动作
      /把单次任务拆小/.test(e.message)
  );
  const aborts = logs.filter((l) => /被中止\(中止,无用量\)/.test(l));
  assert.equal(aborts.length, 2); // 超时封顶 2 次尝试(不再是 3 次同参数空跑)
  assert.match(aborts[0], /^\[llm\] revise · glm-4\.6:第 1 次尝试超过 0\.1s 被中止\(中止,无用量\);见 LLM_TIMEOUT_MS$/);
  assert.match(aborts[1], /第 2 次尝试超过 0\.2s 被中止/);
  assert.match(logs[1], /^\[llm\] revise · glm-4\.6:超时不原样重试,改用 0\.2s 的超时再试一次\(总时长上限 900s\)$/);
  assert.match(logs.at(-1), /调用失败:token 用量 接口未返回;重试 1 次,累计等待 0s;超时中止 2 次\(中止,无用量\)$/);
  assert.deepEqual(waits, []); // 换超时重试不再退避空等
  assert.equal(llmCalls.at(-1).timeouts, 2);
  assert.equal(llmCalls.at(-1).retries, 1);
  delete process.env.LLM_TIMEOUT_MS;
});

test("callLLM 超时:翻倍后会超过总时长上限 → 一次都不再试,如实失败", async () => {
  assert.equal(DEFAULT_TIMEOUT_TOTAL_MS, 900000); // = 旧版最坏情况 3 × 300s,但不再花在必然超时的同参数重试上
  process.env.LLM_TIMEOUT_MS = "100";
  process.env.LLM_TIMEOUT_TOTAL_MS = "150"; // 100 已用 + 翻倍 200 > 150
  hangs();
  const { logs, opts } = recorder();
  await assert.rejects(
    () => callLLM("s", "u", "glm-4.6", { ...opts, stage: "draft" }),
    (e) => e.code === "DOC_AGENT_TIMEOUT" && /已尝试 1 次/.test(e.message) && /总时长上限 0\.2s/.test(e.message)
  );
  assert.equal(logs.filter((l) => /被中止/.test(l)).length, 1);
  assert.equal(llmCalls.at(-1).timeouts, 1);
  delete process.env.LLM_TIMEOUT_MS;
  delete process.env.LLM_TIMEOUT_TOTAL_MS;
});

test("stageTimeout:分阶段默认(revise 600s、其余 300s)→ LLM_TIMEOUT_MS 统一覆盖 → LLM_TIMEOUT_MS_<STAGE> 分阶段覆盖", () => {
  assert.equal(stageTimeout("revise"), 600000); // 300s 实测不够:#5655 返工连撞三次 300s
  assert.equal(stageTimeout("draft"), 300000);
  assert.equal(stageTimeout("plan"), 300000);
  assert.equal(stageTimeout(""), 300000);

  process.env.LLM_TIMEOUT_MS = "111000"; // 统一覆盖:所有阶段都听它的(保留原有输入项语义)
  assert.equal(stageTimeout("revise"), 111000);
  assert.equal(stageTimeout("draft"), 111000);

  process.env.LLM_TIMEOUT_MS_REVISE = "222000"; // 分阶段覆盖优先级最高
  assert.equal(stageTimeout("revise"), 222000);
  assert.equal(stageTimeout("draft"), 111000);

  delete process.env.LLM_TIMEOUT_MS;
  assert.equal(stageTimeout("revise"), 222000);
  assert.equal(stageTimeout("draft"), 300000); // 回落到阶段默认
  process.env.LLM_TIMEOUT_MS_REVISE = ""; // 空串 = 没配
  assert.equal(stageTimeout("revise"), 600000);
  delete process.env.LLM_TIMEOUT_MS_REVISE;
});

test("callLLM:普通网络异常(不是超时)仍按历史行为重试 3 次", async () => {
  delete process.env.LLM_RETRY_MAX_WAIT_MS;
  const calls = scripted([{ throws: "ECONNRESET" }]);
  const rec = recorder();
  await assert.rejects(() => callLLM("s", "u", "m", rec.opts), /ECONNRESET/);
  assert.equal(calls.length, 3);
  assert.equal(llmCalls.at(-1).timeouts, 0);
});

test("callLLM:调用方显式传 maxTokens 优先于 LLM_MAX_TOKENS(长输出阶段不听凭接口默认)", async () => {
  process.env.LLM_MAX_TOKENS = "512";
  const calls = scripted([{ ok: true, content: "ok" }, { ok: true, content: "ok" }]);
  await callLLM("s", "u", "m", { ...recorder().opts, maxTokens: 4096 });
  assert.equal(calls[0].max_tokens, 4096);
  await callLLM("s", "u", "m", recorder().opts); // 不传就沿用环境变量
  assert.equal(calls[1].max_tokens, 512);
  delete process.env.LLM_MAX_TOKENS;
});

test("usageSummary:按模型分行 + 合计行;有失败 / 未返回 usage 的调用时加注;没调用过模型返回空串", () => {
  assert.equal(usageSummary([], "plan"), "");
  const u = (prompt, completion) => ({ prompt, completion, total: prompt + completion });
  const md = usageSummary(
    [
      { stage: "draft", model: "glm-4.6", ok: true, usage: u(30000, 800), retries: 1, waitedMs: 1500 },
      { stage: "sync", model: "glm-4.6", ok: true, usage: u(9000, 300), retries: 0, waitedMs: 0 },
      { stage: "qa", model: "glm-4-flash", ok: true, usage: null, retries: 0, waitedMs: 0 },
      { stage: "translate", model: "glm-4-flash", ok: false, usage: null, retries: 2, waitedMs: 4500, timeouts: 2 },
    ],
    "draft"
  );
  assert.equal(
    md,
    [
      "**doc-agent 模型用量(draft 阶段合计)**",
      "",
      "| 模型 | 调用次数 | 输入 token | 输出 token | 合计 token | 重试次数 | 累计等待 |",
      "|---|---|---|---|---|---|---|",
      "| glm-4.6 | 2 | 39000 | 1100 | 40100 | 1 | 1.5s |",
      "| glm-4-flash | 2 | 0 | 0 | 0 | 2 | 4.5s |",
      "| **合计** | 4 | 39000 | 1100 | 40100 | 3 | 6s |",
      "",
      "其中 1 次调用失败;2 次接口未返回 usage(token 数未计入这几次);2 次尝试因超时被中止(中止,无用量;已计入重试次数)。",
    ].join("\n")
  );
});
