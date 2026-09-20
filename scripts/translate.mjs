import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runStage } from "./llm.mjs";
import { applyEdits } from "./edits.mjs";
import { loadConfig, toTarget } from "./config.mjs";
import { classifyError, TruncatedError } from "./errors.mjs";
import { stepSummary } from "./planlib.mjs";

const tSys = () => readFileSync(new URL("../prompts/translate.md", import.meta.url), "utf8");
const sSys = () => readFileSync(new URL("../prompts/translate-sync.md", import.meta.url), "utf8");
const qSys = () => readFileSync(new URL("../prompts/translate-qa.md", import.meta.url), "utf8");

// ── 长输出调用的显式输出上限(token)──
// 整篇翻译与译文质检都显式设,绝不听凭接口默认:实测 glm-4-flash 的默认上限只有 1024 token
// (Apollo 回放 #5655:整篇翻译写到 7020 字符即 finish_reason=length,质检报告也恰好卡在 1024)。
// 配了 LLM_MAX_TOKENS 就以它为准,方便按模型档位统一调。
export const DEFAULT_OUTPUT_MAX_TOKENS = 4096;
export const outputMaxTokens = () => Number(process.env.LLM_MAX_TOKENS) || DEFAULT_OUTPUT_MAX_TOKENS;

// 整篇翻译的分块大小(源文档字符数)。4000 中文字符的译文约 1.5–2K token,落在 4096 的输出上限之内还有余量。
export const DEFAULT_CHUNK_CHARS = 4000;
export const chunkChars = () => Number(process.env.TRANSLATE_CHUNK_CHARS) || DEFAULT_CHUNK_CHARS;

// 译文方向与镜像路径来自配置(source-lang、docs-source-dir → docs-target-dir)。
// 内置翻译提示词只覆盖「中文 → 英文」:其它方向明确报错(由 draft/revise 的失败回帖兜住),不静默产出错向译文。
function translationConfig() {
  const cfg = loadConfig();
  if (cfg.sourceLang !== "zh")
    throw new Error(`暂不支持 source-lang=${cfg.sourceLang} 的译文同步:内置翻译提示词只覆盖中文 → 英文`);
  return cfg;
}

/**
 * 按 Markdown 标题把文档切成块,再把相邻小块并到 maxChars 以内。
 * 代码围栏(``` / ~~~)内的 `#` 不是标题——Apollo 的 `startup.sh` 示例里就有 `## Adjust log dir if necessary`,
 * 按行瞎切会把代码块劈成两半。切点只落在标题行上:块按 `\n` 拼回来即原文(全空白的块直接丢掉,不送去翻译)。
 */
export function splitByHeadings(text, maxChars = chunkChars()) {
  const lines = String(text).split("\n");
  const sections = [];
  let cur = [];
  let fence = ""; // 当前围栏标记(``` 或 ~~~ 开头的那串),空串 = 不在围栏里
  for (const line of lines) {
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = "";
    } else if (!fence && /^#{1,6}\s/.test(line) && cur.length) {
      sections.push(cur.join("\n"));
      cur = [];
    }
    cur.push(line);
  }
  sections.push(cur.join("\n"));

  // 相邻小块合并:一块超过 maxChars 时单独成块(单个小节本身就超限,只能原样送,截断了会明确报错)
  const chunks = [];
  for (const s of sections) {
    const last = chunks.at(-1);
    if (last !== undefined && last.length + 1 + s.length <= maxChars) chunks[chunks.length - 1] = `${last}\n${s}`;
    else chunks.push(s);
  }
  return chunks.filter((c) => c.trim() !== "");
}

// 整篇翻译(译文镜像不存在的新文档,或增量失败兜底)。新文档可能在新建的子目录里,先建目录。
// 按标题切块逐块翻译再拼接:整篇一次送,25KB 的文档必然撞上输出上限(v1.2.1 在 Apollo 回放里就是这样作废了整份初稿)。
// 任一块被截断就带上块号明确失败,半篇译文绝不落盘(全部块都成功才写文件)。
async function translateFull(srcPath, dst, cfg) {
  const chunks = splitByHeadings(readFileSync(srcPath, "utf8"));
  const maxTokens = outputMaxTokens();
  const parts = [];
  for (let i = 0; i < chunks.length; i++) {
    const at = `第 ${i + 1}/${chunks.length} 块`;
    console.log(`[translate] ${srcPath} ${at}:${chunks[i].length} 字符,输出上限 ${maxTokens} token`);
    try {
      const t = await runStage({
        stage: "translate",
        system: tSys(),
        user:
          `把下面这段${cfg.sourceName}技术文档翻译成${cfg.targetName},只输出译文,不要补标题、前言或结语` +
          `(这是整篇文档的${at},前后还有别的段落,会原样拼接):\n\n${chunks[i]}`,
        maxTokens,
      });
      parts.push(t.trim());
    } catch (e) {
      if (classifyError(e).key !== "truncated") throw e;
      throw new TruncatedError(
        `整篇翻译的${at}被截断(${srcPath},该块 ${chunks[i].length} 字符,输出上限 ${maxTokens} token):` +
          `调大 LLM_MAX_TOKENS、调小 TRANSLATE_CHUNK_CHARS,或换输出上限更大的模型;译文没有落盘`
      );
    }
  }
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, `${parts.join("\n\n")}\n`);
}

// 增量同步失败转兜底之前,把原因类别与错误信息写进日志和 Step Summary。
// v1.2.1 这里是静默兜底:Apollo 回放里英文增量同步失败、整篇重译被截断,整份初稿作废,而日志里一个字都没有。
function noteSyncFallback({ srcPath, dst, err }) {
  const kind = classifyError(err);
  const hint =
    `⚠️ 译文增量同步失败(原因类别:**${kind.label}**),转整篇重译兜底:${srcPath} → ${dst}` +
    `\n\n\`\`\`\n${String(err?.message || err).slice(0, 500)}\n\`\`\``;
  console.error(hint);
  stepSummary(hint);
  return kind;
}

// 增量同步:只把源文档这次的改动反映到译文(产出最小译文 diff)。
// 译文镜像不存在、或源文档是本次新建的 → 整篇翻译;增量编辑对不上 / 输出不合约定 → 整篇重译兜底(原因先写进日志)。
// 模型接口报错(限流已退避到上限)与输出被截断不兜底:整篇重译的请求更大,只会更容易再撞上,直接抛给调用方回帖。
export async function syncTranslation(srcPath, srcEdits) {
  const cfg = translationConfig();
  const dst = toTarget(srcPath, cfg);
  const mine = srcEdits.filter((e) => e.path === srcPath);
  if (!existsSync(dst) || mine.some((e) => e.create)) {
    await translateFull(srcPath, dst, cfg);
    return { source: srcPath, target: dst };
  }
  const changes = mine
    .map((e) => `【原${cfg.sourceName}】\n${e.old_string}\n【改为】\n${e.new_string}`)
    .join("\n\n");
  try {
    const user = `${cfg.sourceName}源文件 ${srcPath} 刚做了下列改动:\n\n${changes}\n\n它的${cfg.targetName}译文 ${dst} 当前内容:\n${readFileSync(dst, "utf8")}\n\n请给出对应的${cfg.targetName} search/replace 编辑,使${cfg.targetName}跟上这些改动。`;
    // 同步是推理任务(定位 + 翻译),用强模型保正确;输出小,仍比整篇重译快
    const { edits } = await runStage({ stage: "sync", system: sSys(), user });
    applyEdits(edits.map((e) => ({ path: dst, old_string: e.old_string, new_string: e.new_string })));
  } catch (e) {
    if (["api", "truncated"].includes(classifyError(e).key)) throw e;
    noteSyncFallback({ srcPath, dst, err: e });
    await translateFull(srcPath, dst, cfg); // 增量失败兜底
  }
  return { source: srcPath, target: dst };
}

// 译文质检(LLM-as-judge):准确性/连贯性/翻译腔。
// 输入是中英两篇全文,报告可能逐条列问题,输出上限同样显式设(实测接口默认 1024 token 会把报告截断)。
export async function qaTranslation(pairs) {
  const cfg = translationConfig();
  const blocks = pairs
    .map(
      (p) =>
        `=== ${p.source}(${cfg.sourceName}原文)===\n${readFileSync(p.source, "utf8")}\n\n=== ${p.target}(${cfg.targetName}译文)===\n${readFileSync(p.target, "utf8")}`
    )
    .join("\n\n");
  return await runStage({ stage: "qa", system: qSys(), user: blocks, maxTokens: outputMaxTokens() });
}
