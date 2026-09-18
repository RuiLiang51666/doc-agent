// 调用国内大模型(OpenAI 兼容接口)。改 LLM_BASE_URL/LLM_MODEL 即可在
// GLM(智谱)、DeepSeek、Kimi(Moonshot)之间切换,无需改其它代码。
import { TruncatedError } from "./errors.mjs";

const BASE_URL = process.env.LLM_BASE_URL || "https://api.deepseek.com/v1";
const MODEL = process.env.LLM_MODEL || "deepseek-chat";
// 翻译/质检用的更快模型(没配就退回主模型)
export const FAST_MODEL = process.env.LLM_FAST_MODEL || MODEL;

// ── 分阶段模型(方案 A ③)──
// 强模型(推理/定位/生成)vs 快模型(机械翻译/判断)。默认档位 == 历史行为;
// 可用 LLM_MODEL_<STAGE>(如 LLM_MODEL_PLAN)对单个阶段单独覆盖,方便调优。
const STAGE_TIER = {
  plan: "strong",
  draft: "strong",
  revise: "strong",
  sync: "strong",     // 增量同步是「定位 + 翻译」的推理任务,用强模型保正确
  translate: "fast",  // 整篇机械翻译
  qa: "fast",         // 译文质检(LLM-as-judge)
};
export function modelFor(stage) {
  const override = process.env[`LLM_MODEL_${String(stage).toUpperCase()}`];
  if (override) return override;
  return STAGE_TIER[stage] === "fast" ? FAST_MODEL : MODEL;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TIMEOUT = Number(process.env.LLM_TIMEOUT_MS) || 120000; // 每次请求超时,默认 120s

// ── 重试与限流退避 ──
// 可重试:网络异常 / 超时、429、5xx,以及把限流写在错误体里的业务码(智谱 1302 并发过高、1303 频率过高、1305 请求过多,
// 不论 HTTP 状态码)。额度类业务码(1113 欠费、1304 当日调用次数用尽、1308 使用次数达上限)等多久都不会好,直接抛;其余 4xx 同理。
// 等待:指数退避 + 随机抖动,第 n 次等 [d/2, d],d = min(2s·2^(n-1), 60s),并行的多个调用不会同一时刻扎堆重试;
// 服务端给了 Retry-After 就至少等那么久。累计等待再等就要超过 LLM_RETRY_MAX_WAIT_MS(默认 180s)时不再等,如实抛错。
// 180s 能扛过按分钟计的频率窗口与短时并发超限;一次运行里即便几次调用都撞上,也远低于 Actions 单个 job 的时长上限。
export const RATE_LIMIT_CODES = new Set(["1302", "1303", "1305"]);
export const QUOTA_CODES = new Set(["1113", "1304", "1308"]);
export const DEFAULT_RETRY_MAX_WAIT_MS = 180000;
const RETRY_BASE_MS = 2000;
const RETRY_CAP_MS = 60000;
const NETWORK_MAX_ATTEMPTS = 3; // 网络异常 / 超时每次都可能耗满 TIMEOUT,次数单独封顶(= 历史行为)

/** 第 attempt 次重试前的等待(毫秒):指数增长、封顶 60s,落在 [d/2, d] 的随机点上。 */
export function backoffDelay(attempt, random = Math.random) {
  const d = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
  return Math.round(d / 2 + (random() * d) / 2);
}

// 累计等待上限:每次调用时读,空串 / 非法值回落默认;0 = 不等待、不重试限流
function retryMaxWait() {
  const v = String(process.env.LLM_RETRY_MAX_WAIT_MS ?? "").trim();
  const n = Number(v);
  return v !== "" && Number.isFinite(n) && n >= 0 ? n : DEFAULT_RETRY_MAX_WAIT_MS;
}

// Retry-After:秒数或 HTTP 日期;没有 / 解析不了按 0
function retryAfterMs(v) {
  if (v == null || String(v).trim() === "") return 0;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : 0;
}

// 错误体里的业务码:{"error":{"code":"1302"}} 或 {"code":1302};不是 JSON 返回 ""
function errorCode(text) {
  try {
    const j = JSON.parse(text);
    const c = j?.error?.code ?? j?.code;
    return c == null ? "" : String(c);
  } catch {
    return "";
  }
}

// 输出因长度被截断的 finish_reason:OpenAI / 智谱 / DeepSeek / Kimi 为 length,部分兼容层用 max_tokens
const TRUNCATED_REASONS = new Set(["length", "max_tokens", "model_length"]);

// 取正文;输出被截断就抛 TruncatedError——截断的 JSON / 译文绝不能当成功结果往下用
function readCompletion(json) {
  const choice = json?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string")
    throw new Error(`LLM 200: 响应里没有 choices[0].message.content:${JSON.stringify(json).slice(0, 200)}`);
  if (TRUNCATED_REASONS.has(choice.finish_reason))
    throw new TruncatedError(
      `模型输出被截断(finish_reason=${choice.finish_reason},已输出 ${content.length} 字符):调大 LLM_MAX_TOKENS,或换输出上限更大的模型`
    );
  return content;
}

// ── 用量与重试记录 ──
// 每次调用结束(成功或失败)记一条并打一行日志:token 用量取接口返回的 usage(没有就写「接口未返回」)、重试次数、累计等待。
// 进程内累积(一次 plan / draft 运行 = 一个进程),阶段脚本退出时用 usageSummary 汇总写进 Step Summary,供核算成本。
export const llmCalls = [];
const secs = (ms) => `${Math.round(ms / 100) / 10}s`;

// 接口的 usage(OpenAI 兼容:prompt_tokens / completion_tokens / total_tokens);没有数字字段视为未返回
function normUsage(u) {
  const n = (v) => (Number.isFinite(v) ? v : null);
  const prompt = n(u?.prompt_tokens);
  const completion = n(u?.completion_tokens);
  if (prompt === null && completion === null && n(u?.total_tokens) === null) return null;
  return { prompt: prompt ?? 0, completion: completion ?? 0, total: n(u.total_tokens) ?? (prompt ?? 0) + (completion ?? 0) };
}

/** 一次调用的日志行(给人看)。 */
export function formatCall(c) {
  const u = c.usage
    ? `输入 ${c.usage.prompt} / 输出 ${c.usage.completion} / 合计 ${c.usage.total}`
    : "接口未返回";
  return `[llm] ${c.stage ? `${c.stage} · ` : ""}${c.model}${c.ok ? "" : " 调用失败"}:token 用量 ${u};重试 ${c.retries} 次,累计等待 ${secs(c.waitedMs)}`;
}

/** 本进程(本阶段)全部调用的合计,按模型分行的 Markdown;没调用过模型返回 ""。 */
export function usageSummary(calls, title) {
  if (!calls.length) return "";
  const rows = new Map();
  const add = (key, c) => {
    const r = rows.get(key) || { n: 0, prompt: 0, completion: 0, total: 0, retries: 0, waitedMs: 0 };
    r.n++;
    r.prompt += c.usage?.prompt ?? 0;
    r.completion += c.usage?.completion ?? 0;
    r.total += c.usage?.total ?? 0;
    r.retries += c.retries;
    r.waitedMs += c.waitedMs;
    rows.set(key, r);
  };
  for (const c of calls) add(c.model, c);
  for (const c of calls) add("**合计**", c);
  const failed = calls.filter((c) => !c.ok).length;
  const missing = calls.filter((c) => !c.usage).length;
  const notes = [failed && `${failed} 次调用失败`, missing && `${missing} 次接口未返回 usage(token 数未计入这几次)`];
  return [
    `**doc-agent 模型用量(${title} 阶段合计)**`,
    "",
    "| 模型 | 调用次数 | 输入 token | 输出 token | 合计 token | 重试次数 | 累计等待 |",
    "|---|---|---|---|---|---|---|",
    ...[...rows].map(([k, r]) => `| ${k} | ${r.n} | ${r.prompt} | ${r.completion} | ${r.total} | ${r.retries} | ${secs(r.waitedMs)} |`),
    ...(failed || missing ? ["", `其中 ${notes.filter(Boolean).join(";")}。`] : []),
  ].join("\n");
}

/**
 * 调一次 chat/completions,重试策略见上。wait / random / log 可注入(测试里不真等、收日志);stage 只用于日志与汇总。
 * 设了 LLM_MAX_TOKENS 才带 max_tokens,不设沿用接口默认。
 */
export async function callLLM(
  system,
  user,
  model = MODEL,
  { wait = sleep, random = Math.random, log = console.log, stage = "" } = {}
) {
  const maxTokens = Number(process.env.LLM_MAX_TOKENS) || 0;
  const opts = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      ...(maxTokens > 0 ? { max_tokens: maxTokens } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  };
  const maxWait = retryMaxWait();
  let waited = 0;
  let networkFailures = 0;
  // 退避一次;这次再等就会超过累计上限时不等,返回 false
  const backoff = async (attempt, floorMs = 0) => {
    const d = Math.max(backoffDelay(attempt, random), floorMs);
    if (waited + d > maxWait) return false;
    waited += d;
    await wait(d);
    return true;
  };
  // 结束时(成功、抛错都算)记一条用量;截断时接口通常也给了 usage,照样记上
  const call = { stage, model, ok: false, usage: null, retries: 0, waitedMs: 0 };
  try {
    for (let attempt = 1; ; attempt++) {
      call.retries = attempt - 1;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT); // 挂住就中止,避免无限等
      let res;
      try {
        res = await fetch(`${BASE_URL}/chat/completions`, { ...opts, signal: ctrl.signal });
      } catch (e) {
        clearTimeout(timer);
        if (++networkFailures >= NETWORK_MAX_ATTEMPTS || !(await backoff(attempt))) throw e;
        continue;
      }
      clearTimeout(timer);
      if (res.ok) {
        const json = await res.json();
        call.usage = normUsage(json?.usage);
        const content = readCompletion(json);
        call.ok = true;
        return content;
      }
      const text = await res.text();
      const code = errorCode(text);
      const retryable =
        RATE_LIMIT_CODES.has(code) || (!QUOTA_CODES.has(code) && (res.status === 429 || res.status >= 500));
      if (!retryable) throw new Error(`LLM ${res.status}: ${text}`);
      if (!(await backoff(attempt, retryAfterMs(res.headers?.get?.("retry-after")))))
        throw new Error(
          `LLM ${res.status}: ${text}(已重试 ${attempt - 1} 次、累计等待 ${Math.round(waited / 1000)}s;再等就超过上限 ${Math.round(maxWait / 1000)}s,见 LLM_RETRY_MAX_WAIT_MS)`
        );
    }
  } finally {
    call.waitedMs = waited;
    llmCalls.push(call);
    log(formatCall(call));
  }
}

// 容错解析:模型可能直接给 JSON,也可能裹上 ```json 围栏或夹带解释文字。
// 先直接 parse;失败再截取第一个 { 到最后一个 } —— 这样即便文档内容本身含有
// ``` 代码围栏,也不会被误截断(裹围栏时直接 parse 会失败,走截取分支)。
export function extractJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s !== -1 && e > s) return JSON.parse(text.slice(s, e + 1));
    throw new Error(`无法从模型输出解析 JSON:${text.slice(0, 120)}`);
  }
}

// ── 每阶段 JSON schema 快速失败(方案 A ②)──
// 只校验「代码真正会读的字段」,缺字段/类型错就指名报错 —— 让模型跑偏时更早、更清楚地失败,
// 而不是流到 applyEdits 抛神秘错。手写校验、不引依赖。
function assert(cond, msg) {
  if (!cond) throw new Error(`模型输出不符合约定:${msg}`);
}
const isArr = Array.isArray;
const isStr = (v) => typeof v === "string";

const SHAPES = {
  // assess.md 输出:是否需要更新 + 待改文件清单(新建文档带 create: true)
  plan(o) {
    assert(o && typeof o === "object", "顶层应为对象");
    assert(typeof o.update === "boolean", "缺字段 update(布尔)");
    if (o.update) {
      assert(isArr(o.items) && o.items.length, "update=true 时 items 应为非空数组");
      o.items.forEach((it, i) => {
        assert(it && isStr(it.file) && isStr(it.change), `items[${i}] 需含字符串 file / change`);
        assert(it.create === undefined || typeof it.create === "boolean", `items[${i}].create 应为布尔`);
      });
    }
    return o;
  },
  // draft/revise 输出:search/replace 编辑对(含目标文件 path),或新建文件 { path, create: true, content }
  edits(o) {
    assert(o && isArr(o.edits), "缺 edits 数组");
    o.edits.forEach((e, i) => {
      if (e && e.create === true)
        assert(isStr(e.path) && isStr(e.content), `edits[${i}] 新建文件需含字符串 path / content`);
      else
        assert(
          e && isStr(e.path) && isStr(e.old_string) && isStr(e.new_string),
          `edits[${i}] 需含字符串 path / old_string / new_string`
        );
    });
    return o;
  },
  // translate-sync 输出:英文侧编辑对(path 由调用方补,故此处不校验 path)
  sync(o) {
    assert(o && isArr(o.edits), "缺 edits 数组");
    o.edits.forEach((e, i) =>
      assert(e && isStr(e.old_string) && isStr(e.new_string), `edits[${i}] 需含字符串 old_string / new_string`)
    );
    return o;
  },
};

/** 解析模型输出并按阶段 schema 校验;shape ∈ plan|edits|sync。 */
export function parseStage(text, shape) {
  const validate = SHAPES[shape];
  if (!validate) throw new Error(`未知 schema:${shape}`);
  return validate(extractJSON(text));
}

// ── 阶段收口(方案 A ④)──
// 每个阶段的输出形态(有的是结构化 JSON,有的是纯文本);null = 不校验、原样返回文本。
const STAGE_SHAPE = {
  plan: "plan",
  draft: "edits",
  revise: "edits",
  sync: "sync",
  translate: null, // 整篇译文,纯文本
  qa: null,        // 译文质检报告,纯文本
};

/**
 * 一个阶段一把收:选模型(modelFor)→ 调模型(callLLM)→ 按 STAGE_SHAPE 解析校验(parseStage)。
 * 各阶段脚本因此瘦成「构造输入 → runStage → 应用输出」。
 * @returns 有 shape 的阶段返回校验后的对象;无 shape 的返回模型原始文本。
 */
export async function runStage({ stage, system, user }) {
  const raw = await callLLM(system, user, modelFor(stage), { stage });
  const shape = STAGE_SHAPE[stage];
  return shape ? parseStage(raw, shape) : raw;
}
