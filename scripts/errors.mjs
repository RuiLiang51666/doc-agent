// 异常 → 原因类别:plan / draft / revise 失败回帖共用,告诉人「为什么失败」。
// 只认错误码与固定措辞,不 import 其它模块(llm / git / translate 都要用,避免循环依赖)。

/** 模型输出因长度被截断(finish_reason=length 等):截断的 JSON / 译文不能当成功结果用。 */
export class TruncatedError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "TruncatedError";
    this.code = "DOC_AGENT_TRUNCATED";
  }
}

/**
 * 单次模型调用超时:尝试跑满客户端超时被中止。与普通网络异常分开——同参数重试必然再次超时,
 * 所以 llm.mjs 只允许换更宽的超时再试一次,消息里写明实际超时值、已尝试次数与建议动作。
 */
export class TimeoutError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "TimeoutError";
    this.code = "DOC_AGENT_TIMEOUT";
  }
}

/** 推送最终失败:被拒后变基重试用尽、变基冲突,或推送本身报错(鉴权、分支保护等)。 */
export class PushError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "PushError";
    this.code = "DOC_AGENT_PUSH";
  }
}

/** 异常 → 原因类别:超预算 / 模型调用超时 / 模型输出被截断 / 推送失败 / 模型输出校验失败 / 模型接口报错 / 其他异常。 */
export function classifyError(e) {
  const msg = String((e && e.message) || e);
  if (e && e.code === "DOC_AGENT_BUDGET") return { key: "budget", label: "超预算" };
  if (e && e.code === "DOC_AGENT_TIMEOUT") return { key: "timeout", label: "模型调用超时" };
  if (e && e.code === "DOC_AGENT_TRUNCATED") return { key: "truncated", label: "模型输出被截断" };
  if (e && e.code === "DOC_AGENT_PUSH") return { key: "push", label: "推送失败" };
  if (/模型输出不符合约定|无法从模型输出解析 JSON/.test(msg)) return { key: "schema", label: "模型输出校验失败" };
  if (
    /^LLM \d{3}\b/.test(msg) ||
    (e && e.name === "AbortError") ||
    /operation was aborted|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(msg)
  )
    return { key: "api", label: "模型接口报错" };
  return { key: "other", label: "其他异常" };
}
