// 调用国内大模型(OpenAI 兼容接口)。改 LLM_BASE_URL/LLM_MODEL 即可在
// GLM(智谱)、DeepSeek、Kimi(Moonshot)之间切换,无需改其它代码。
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

export async function callLLM(system, user, model = MODEL) {
  const opts = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  };
  // 最多 3 次,退避 1s/2s。只对网络异常、429、5xx 重试;4xx(鉴权/参数错)直接抛。
  for (let attempt = 1; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT); // 挂住就中止,避免无限等
    let res;
    try {
      res = await fetch(`${BASE_URL}/chat/completions`, { ...opts, signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timer);
      if (attempt >= 3) throw e;
      await sleep(2 ** (attempt - 1) * 1000);
      continue;
    }
    clearTimeout(timer);
    if (res.ok) return (await res.json()).choices[0].message.content;
    const text = await res.text();
    if ((res.status !== 429 && res.status < 500) || attempt >= 3)
      throw new Error(`LLM ${res.status}: ${text}`);
    await sleep(2 ** (attempt - 1) * 1000);
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
  // assess.md 输出:是否需要更新 + 待改文件清单
  plan(o) {
    assert(o && typeof o === "object", "顶层应为对象");
    assert(typeof o.update === "boolean", "缺字段 update(布尔)");
    if (o.update) {
      assert(isArr(o.items) && o.items.length, "update=true 时 items 应为非空数组");
      o.items.forEach((it, i) =>
        assert(it && isStr(it.file) && isStr(it.change), `items[${i}] 需含字符串 file / change`)
      );
    }
    return o;
  },
  // draft/revise 输出:search/replace 编辑对(含目标文件 path)
  edits(o) {
    assert(o && isArr(o.edits), "缺 edits 数组");
    o.edits.forEach((e, i) =>
      assert(
        e && isStr(e.path) && isStr(e.old_string) && isStr(e.new_string),
        `edits[${i}] 需含字符串 path / old_string / new_string`
      )
    );
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
  const raw = await callLLM(system, user, modelFor(stage));
  const shape = STAGE_SHAPE[stage];
  return shape ? parseStage(raw, shape) : raw;
}
