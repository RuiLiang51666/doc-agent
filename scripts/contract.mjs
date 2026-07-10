// 阶段间机读契约:把结构化数据藏进 Issue/PR 正文的 HTML 注释里,
// 与「给人看的 markdown」解耦。下游读不到时返回 null,由调用方回退旧的正则解析
// —— 这样存量 Issue(嵌契约之前建的)依然能被正确处理。

const blockRe = (name) => new RegExp(`<!--\\s*doc-agent:${name}\\s*([\\s\\S]*?)-->`);

/** 生成一段隐藏机读块(追加到正文末尾)。 */
export function embedContract(name, obj) {
  return `\n\n<!-- doc-agent:${name}\n${JSON.stringify(obj)}\n-->`;
}

/** 从正文里读出某个契约块的结构化数据;不存在或解析失败则返回 null。 */
export function readContract(name, body) {
  const m = String(body || "").match(blockRe(name));
  if (!m) return null;
  try {
    return JSON.parse(m[1].trim());
  } catch {
    return null;
  }
}

/** 去掉正文里所有 doc-agent 契约块(喂给模型前用,避免把内部数据当正文读)。 */
export function stripContracts(body) {
  return String(body || "").replace(/<!--\s*doc-agent:[\s\S]*?-->/g, "").trim();
}
