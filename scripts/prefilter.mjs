// 文档预筛:从 diff 抽标识符 → 给源语言文档打分 → 预算内取高分文档放全文,
// 其余只进「路径 + 标题」索引。全部确定性、离线,不额外调模型。
import { estimateTokens, buildDiffText, BudgetError } from "./budget.mjs";
import { matchPaths } from "./config.mjs";

// 抽词时忽略的高频词:语言关键字、样板词、通用短词(项目名这类全篇都有的词交给 IDF 降权)
const STOP = new Set(
  (
    "the and for with from this that null true false void public private protected static final abstract " +
    "class interface enum record extends implements import package return new else try catch finally " +
    "throw throws override string int long boolean double float char byte object integer list map set get " +
    "is has add put remove value values key keys type name data test tests assert expect should when then " +
    "java kotlin src main resources const let var function async await export default require super while " +
    "switch case break continue instanceof optional collections arrays objects util lang"
  ).split(/\s+/)
);

/** 驼峰 / 下划线 / 连字符 / 点号统一拆成小写词:userNameAttribute → user name attribute。 */
export function splitWords(s) {
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}
// 压扁成纯小写字母数字:让 user-name-attribute / userNameAttribute / user_name_attribute 互相命中
const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * 从代码 diff 抽标识符,带权重:配置键 5 > 类名/文件名 4 > 方法名、环境变量、字符串常量 3 > 存取器、拆出的单词 1。
 * 只看文件路径与改动行(+/-);返回 [{ id, key, kind: "term" | "word", weight }]。
 */
export function extractIdentifiers(diffFiles) {
  const terms = new Map(); // squash → { id, weight }
  const addTerm = (id, weight) => {
    const key = squash(id);
    if (key.length < 6 || STOP.has(key)) return;
    const cur = terms.get(key);
    if (!cur || cur.weight < weight) terms.set(key, { id, weight });
  };
  const words = new Map(); // word → weight
  const addWords = (s) => {
    for (const w of splitWords(s)) if (w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w)) words.set(w, 1);
  };

  for (const f of diffFiles) {
    addTerm(f.path.slice(f.path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, ""), 4); // 文件名(常即类名)
    addWords(f.path);
    for (const line of String(f.text).split("\n")) {
      if (!/^[+-]/.test(line) || /^(\+\+\+|---)/.test(line)) continue;
      const code = line.slice(1);
      if (/^\s*(import|package)\s/.test(code)) continue; // 包路径对文档没有区分度
      for (const m of code.matchAll(/\b(?:class|interface|enum|record)\s+([A-Z]\w+)/g)) addTerm(m[1], 4);
      for (const m of code.matchAll(/\$\{([\w.-]+)(?::[^}]*)?\}/g)) addTerm(m[1], 5); // ${config.key}
      // 点号配置键(a.b.c 至少三段);排除 Java 包名与方法链
      for (const m of code.matchAll(/(?<![\w.])([a-z][\w-]*(?:\.[a-z0-9][\w-]*){2,})(?![\w(])/g))
        if (!/^(com|org|net|io|java|javax|jakarta)\./.test(m[1])) addTerm(m[1], 5);
      // 驼峰方法名;get/set/is/has 存取器(getValue、setType)在文档里太常见,只给 1
      for (const m of code.matchAll(/\b([a-z_$][\w$]*[A-Z][\w$]*)\s*\(/g))
        addTerm(m[1], /^(get|set|is|has)[A-Z]/.test(m[1]) ? 1 : 3);
      for (const m of code.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)) addTerm(m[1], 3); // 环境变量
      for (const m of code.matchAll(/["']([a-z][a-z0-9]*(?:[_-][a-z0-9]+)+)["']/g)) addTerm(m[1], 3); // 字符串常量
    }
  }
  for (const t of terms.values()) addWords(t.id);

  const byWeight = (a, b) => b.weight - a.weight || (a.key < b.key ? -1 : 1);
  return [
    ...[...terms].map(([key, t]) => ({ id: t.id, key, kind: "term", weight: t.weight })).sort(byWeight).slice(0, 300),
    ...[...words].map(([key]) => ({ id: key, key, kind: "word", weight: 1 })).sort(byWeight).slice(0, 300),
  ];
}

/** 读 frontmatter 里的 covers:(行内 [a, b] 或块列表 - a);没有则返回 []。 */
export function parseCovers(text) {
  const fm = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const m = fm && fm[1].match(/^covers:[ \t]*(.*)$/m);
  if (!m) return [];
  const unquote = (s) => s.trim().replace(/^["']|["']$/g, "");
  if (m[1].trim()) return m[1].replace(/^\s*\[|\]\s*$/g, "").split(",").map(unquote).filter(Boolean);
  const out = [];
  for (const l of fm[1].slice(m.index + m[0].length).split(/\r?\n/).slice(1)) {
    const x = l.match(/^\s*-\s*(.+?)\s*$/);
    if (!x) break;
    out.push(unquote(x[1]));
  }
  return out;
}

/** 文档标题:frontmatter title → 首个一级标题(跳过代码块)→ 文件名。 */
export function docTitle(text, path) {
  const s = String(text);
  const fm = s.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const t = fm && fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
  if (t) return t[1];
  const h = s.replace(/```[\s\S]*?```/g, "").match(/^#\s+(.+?)\s*#*\s*$/m);
  return (h ? h[1] : path.slice(path.lastIndexOf("/") + 1)).slice(0, 80);
}

const countUpTo = (hay, needle, cap) => {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1 && n < cap; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
};
const COVERS_BONUS = 100; // covers: 显式声明覆盖了改动文件,直接顶到最前
const K1 = 1.2; // BM25 式长度归一化参数
const B = 0.75;

/**
 * 给文档打分:Σ 权重 × IDF × 归一化命中次数,另加 covers: 奖励。
 * - 命中次数:标识符在全文里的出现次数(封顶 3);单词出现在文档路径里再加 2;
 * - IDF = ln(1 + 文档总数 / 命中文档数),让「每篇都有」的词(如项目名)自动降权;
 * - 长度归一化(BM25 式):长文档靠泛词广撒网堆出的分被压下去,不再挤掉真正相关的短文档。
 * @returns 按得分降序(同分按路径)的 [{ path, text, title, score, hits }]
 */
export function scoreDocs(docs, idents, codeFiles = []) {
  const prepared = docs.map((d) => {
    const freq = new Map();
    for (const w of splitWords(d.text)) freq.set(w, (freq.get(w) || 0) + 1);
    return {
      ...d,
      flat: squash(d.text),
      freq,
      pathWords: new Set(splitWords(d.path)),
      covers: parseCovers(d.text),
      len: estimateTokens(d.text),
    };
  });
  const avgLen = prepared.reduce((s, d) => s + d.len, 0) / (prepared.length || 1) || 1;
  const tfs = idents.map((id) =>
    prepared.map((d) =>
      id.kind === "term"
        ? countUpTo(d.flat, id.key, 3)
        : Math.min(d.freq.get(id.key) || 0, 3) + (d.pathWords.has(id.key) ? 2 : 0)
    )
  );
  const N = docs.length;
  const scored = prepared.map((d, j) => {
    const contrib = [];
    idents.forEach((id, i) => {
      const tf = tfs[i][j];
      if (!tf) return;
      const df = tfs[i].filter(Boolean).length;
      const norm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.len) / avgLen));
      contrib.push({ id: id.id, v: id.weight * Math.log(1 + N / df) * norm });
    });
    let score = contrib.reduce((s, c) => s + c.v, 0);
    if (d.covers.length && codeFiles.some((p) => matchPaths(p, d.covers))) {
      score += COVERS_BONUS;
      contrib.push({ id: "covers:", v: COVERS_BONUS });
    }
    const hits = contrib.sort((a, b) => b.v - a.v).slice(0, 3).map((c) => c.id);
    return { path: d.path, text: d.text, title: docTitle(d.text, d.path), score: Math.round(score * 100) / 100, hits };
  });
  return scored.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
}

/**
 * 组装 plan 阶段的 user prompt,保证「system + user」估算 token ≤ plan 预算:
 * diff 先按 diff 预算截断;全部文档的「路径 + 标题」索引是固定开销;
 * 余下预算按得分从高到低贪心放全文(放不下的跳过、继续试下一篇)。
 * 固定开销本身就超预算时抛 BudgetError。
 */
export function buildPlanPrompt({ prNumber, prTitle, system, diffFiles, docs, codeFiles, cfg }) {
  const budget = cfg.planTokenBudget;
  const diffBudget = Math.min(cfg.diffTokenBudget, budget);
  const diff = buildDiffText(diffFiles, diffBudget);
  const paths = codeFiles || diffFiles.map((f) => f.path);
  const ranked = scoreDocs(docs, extractIdentifiers(diffFiles), paths);

  const cut = diff.truncated.length ? `,其中 ${diff.truncated.length} 个已截断` : "";
  const head = `PR #${prNumber} (${prTitle}) diff(配置的代码路径下改动 ${diffFiles.length} 个文件${cut}):\n${diff.text}`;
  const indexHead = `文档索引(${cfg.sourceName}源文档共 ${docs.length} 篇,路径 — 标题;★ = 下方附了全文,其余因预算只列索引):`;
  const indexLine = (d, star) => `- ${star ? "★ " : ""}${d.path} — ${d.title}`;
  const fullHead = (k) => `现有文档(按与 diff 的相关度预筛,附全文 ${k} 篇):`;
  const byPath = [...ranked].sort((a, b) => (a.path < b.path ? -1 : 1));

  // 固定开销按「索引全部带 ★」估上界,保证最终不超预算
  const fixed =
    estimateTokens(system) +
    estimateTokens(head) +
    estimateTokens(indexHead) +
    estimateTokens(fullHead(1e6)) +
    byPath.reduce((s, d) => s + estimateTokens(indexLine(d, true)) + 1, 0) +
    8;
  if (fixed > budget)
    throw new BudgetError(`plan 输入的固定部分(提示词 + diff + 文档索引)估算 ${fixed} token,超出预算 ${budget}`);

  let remaining = budget - fixed;
  const selected = [];
  for (const d of ranked) {
    const block = `=== ${d.path} ===\n${d.text}`;
    const tokens = estimateTokens(block) + 2;
    if (tokens > remaining) continue;
    selected.push({ ...d, block, tokens });
    remaining -= tokens;
  }
  const chosen = new Set(selected.map((d) => d.path));
  const user = [
    head,
    [indexHead, ...byPath.map((d) => indexLine(d, chosen.has(d.path)))].join("\n"),
    `${fullHead(selected.length)}\n${selected.map((d) => d.block).join("\n\n")}`,
  ].join("\n\n");

  const tokens = estimateTokens(system) + estimateTokens(user);
  if (tokens > budget) throw new BudgetError(`plan 输入估算 ${tokens} token,超出预算 ${budget}`); // 防御:按构造不会触发
  return {
    user,
    stats: {
      budget,
      tokens,
      systemTokens: estimateTokens(system),
      diff: { files: diffFiles.length, tokens: diff.tokens, budget: diffBudget, truncated: diff.truncated },
      docsTotal: docs.length,
      selected: selected.map((d) => ({ path: d.path, score: d.score, tokens: d.tokens, hits: d.hits })),
      ranked: ranked.map((d) => ({ path: d.path, score: d.score, full: chosen.has(d.path) })),
    },
  };
}
