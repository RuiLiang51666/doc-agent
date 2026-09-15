// token 预算:确定性估算 + 按文件截断。不调模型、不引依赖,离线可测。

/** 超预算:plan 据此归类「超预算」回帖。 */
export class BudgetError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "BudgetError";
    this.code = "DOC_AGENT_BUDGET";
  }
}

/**
 * 粗估 token 数:ASCII 按 4 字符/token,非 ASCII(中文等)按 1 字符/token(偏保守)。
 * 与真实分词器有误差(约 ±30%),所以预算默认值留足余量。
 */
export function estimateTokens(text) {
  let ascii = 0;
  let other = 0;
  for (const ch of String(text ?? "")) ch.charCodeAt(0) < 128 ? ascii++ : other++;
  return Math.ceil(ascii / 4) + other;
}

/** 按整行从头截取,使结果不超过 maxTokens(逐行向上取整,只会偏保守)。 */
export function truncateLines(text, maxTokens) {
  const lines = String(text).split("\n");
  let used = 0;
  let n = 0;
  for (; n < lines.length; n++) {
    const t = estimateTokens(lines[n]) + 1; // +1 算换行
    if (used + t > maxTokens) break;
    used += t;
  }
  return { text: lines.slice(0, n).join("\n"), keptLines: n, totalLines: lines.length };
}

const MARK_CUT = (kept, total) => `… [已截断:该文件 diff 共 ${total} 行,超出预算,只保留前 ${kept} 行]`;
const MARK_SKIP = "[已截断:超出预算,未展开该文件 diff]";
const MARK_TAIL = (k) => `… [已截断:另有 ${k} 个改动文件超出预算,未列出]`;
const MIN_BODY = 40; // 分到的预算不足这个数就不展开正文,只留标题 + 已截断标记

/**
 * 把逐文件 diff 拼成不超过 budget 的文本,超出时按文件截断并显式标注「已截断」。
 * 分配用「注水」:按体量从小到大,每个文件最多拿剩余预算的平均份额——
 * 小文件全量保留,用不完的份额留给大文件,避免一个巨型文件把其余文件全挤掉。
 * @param files [{ path, text }] 单文件 unified diff
 * @returns { text, tokens, truncated: [path] }
 */
export function buildDiffText(files, budget) {
  const items = files.map((f) => {
    const header = `=== ${f.path} ===`;
    // 硬开销:标题 + 可能出现的截断标记 + 分隔换行(按上界估)
    const fixed = estimateTokens(header) + estimateTokens(MARK_CUT(1e6, 1e6)) + 2;
    return { ...f, header, fixed, tokens: estimateTokens(f.text) };
  });

  // 1) 连标题都放不下时,按顺序能列几个列几个,其余汇总成一行
  let listed = items;
  let fixedSum = items.reduce((s, f) => s + f.fixed, 0);
  let tail = "";
  if (fixedSum > budget) {
    const tailCost = estimateTokens(MARK_TAIL(items.length)) + 2;
    listed = [];
    fixedSum = tailCost;
    for (const f of items) {
      if (fixedSum + f.fixed > budget) break;
      listed.push(f);
      fixedSum += f.fixed;
    }
    tail = MARK_TAIL(items.length - listed.length);
  }

  // 2) 余下预算注水分配
  let remaining = Math.max(0, budget - fixedSum);
  [...listed]
    .sort((a, b) => a.tokens - b.tokens)
    .forEach((f, k, arr) => {
      f.allot = Math.min(f.tokens, Math.floor(remaining / (arr.length - k)));
      remaining -= f.allot;
    });

  // 3) 按原顺序输出
  const truncated = [];
  const blocks = listed.map((f) => {
    if (f.allot >= f.tokens) return `${f.header}\n${f.text}`;
    truncated.push(f.path);
    if (f.allot < MIN_BODY) return `${f.header}\n${MARK_SKIP}`;
    const cut = truncateLines(f.text, f.allot);
    return `${f.header}\n${cut.text}\n${MARK_CUT(cut.keptLines, cut.totalLines)}`;
  });
  if (tail) {
    blocks.push(tail);
    truncated.push(...items.slice(listed.length).map((f) => f.path));
  }
  const text = blocks.join("\n\n");
  return { text, tokens: estimateTokens(text), truncated };
}
