import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runStage } from "./llm.mjs";
import { applyEdits } from "./edits.mjs";
import { loadConfig, toTarget } from "./config.mjs";
import { classifyError } from "./errors.mjs";

const tSys = () => readFileSync(new URL("../prompts/translate.md", import.meta.url), "utf8");
const sSys = () => readFileSync(new URL("../prompts/translate-sync.md", import.meta.url), "utf8");
const qSys = () => readFileSync(new URL("../prompts/translate-qa.md", import.meta.url), "utf8");

// 译文方向与镜像路径来自配置(source-lang、docs-source-dir → docs-target-dir)。
// 内置翻译提示词只覆盖「中文 → 英文」:其它方向明确报错(由 draft/revise 的失败回帖兜住),不静默产出错向译文。
function translationConfig() {
  const cfg = loadConfig();
  if (cfg.sourceLang !== "zh")
    throw new Error(`暂不支持 source-lang=${cfg.sourceLang} 的译文同步:内置翻译提示词只覆盖中文 → 英文`);
  return cfg;
}

// 整篇翻译(译文镜像不存在的新文档,或增量失败兜底)。新文档可能在新建的子目录里,先建目录。
// 输出被截断时 runStage 直接抛 TruncatedError,半截译文不会写进文件。
async function translateFull(srcPath, dst, cfg) {
  const t = await runStage({
    stage: "translate",
    system: tSys(),
    user: `把下面这篇${cfg.sourceName}技术文档翻译成${cfg.targetName},只输出译文全文:\n\n${readFileSync(srcPath, "utf8")}`,
  });
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, t.endsWith("\n") ? t : t + "\n");
}

// 增量同步:只把源文档这次的改动反映到译文(产出最小译文 diff)。
// 译文镜像不存在、或源文档是本次新建的 → 整篇翻译;增量编辑对不上 / 输出不合约定 → 整篇重译兜底。
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
    await translateFull(srcPath, dst, cfg); // 增量失败兜底
  }
  return { source: srcPath, target: dst };
}

// 译文质检(LLM-as-judge):准确性/连贯性/翻译腔
export async function qaTranslation(pairs) {
  const cfg = translationConfig();
  const blocks = pairs
    .map(
      (p) =>
        `=== ${p.source}(${cfg.sourceName}原文)===\n${readFileSync(p.source, "utf8")}\n\n=== ${p.target}(${cfg.targetName}译文)===\n${readFileSync(p.target, "utf8")}`
    )
    .join("\n\n");
  return await runStage({ stage: "qa", system: qSys(), user: blocks });
}
