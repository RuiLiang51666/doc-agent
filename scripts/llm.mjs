// 调用国内大模型(OpenAI 兼容接口)。改 LLM_BASE_URL/LLM_MODEL 即可在
// GLM(智谱)、DeepSeek、Kimi(Moonshot)之间切换,无需改其它代码。
const BASE_URL = process.env.LLM_BASE_URL || "https://api.deepseek.com/v1";
const MODEL = process.env.LLM_MODEL || "deepseek-chat";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function callLLM(system, user) {
  const opts = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  };
  // 最多 3 次,退避 1s/2s。只对网络异常、429、5xx 重试;4xx(鉴权/参数错)直接抛。
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(`${BASE_URL}/chat/completions`, opts);
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(2 ** (attempt - 1) * 1000);
      continue;
    }
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
