import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { callLLM, FAST_MODEL, extractJSON } from "./llm.mjs";
import { applyEdits } from "./edits.mjs";

const tSys = () => readFileSync(new URL("../prompts/translate.md", import.meta.url), "utf8");
const sSys = () => readFileSync(new URL("../prompts/translate-sync.md", import.meta.url), "utf8");
const qSys = () => readFileSync(new URL("../prompts/translate-qa.md", import.meta.url), "utf8");

// 中文 canonical 路径 → 英文镜像路径
export const toEn = (zhPath) => zhPath.replace(/^docs\/zh\//, "docs/en/");

// 整篇翻译(英文镜像不存在的新文档,或增量失败兜底)
async function translateFull(zhPath, en) {
  const t = await callLLM(
    tSys(),
    `把下面这篇中文技术文档翻译成英文,只输出译文全文:\n\n${readFileSync(zhPath, "utf8")}`,
    FAST_MODEL
  );
  writeFileSync(en, t.endsWith("\n") ? t : t + "\n");
}

// 增量同步:只把中文这次的改动反映到英文译文(产出最小 en diff)。
// 英文镜像不存在 → 整篇翻译;增量编辑失败 → 整篇重译兜底。
export async function syncTranslation(zhPath, zhEdits) {
  const en = toEn(zhPath);
  if (!existsSync(en)) {
    await translateFull(zhPath, en);
    return { zh: zhPath, en };
  }
  const changes = zhEdits
    .filter((e) => e.path === zhPath)
    .map((e) => `【原中文】\n${e.old_string}\n【改为】\n${e.new_string}`)
    .join("\n\n");
  try {
    const user = `中文源文件 ${zhPath} 刚做了下列改动:\n\n${changes}\n\n它的英文译文 ${en} 当前内容:\n${readFileSync(en, "utf8")}\n\n请给出对应的英文 search/replace 编辑,使英文跟上这些改动。`;
    const { edits } = extractJSON(await callLLM(sSys(), user, FAST_MODEL));
    applyEdits(edits.map((e) => ({ path: en, old_string: e.old_string, new_string: e.new_string })));
  } catch {
    await translateFull(zhPath, en); // 增量失败兜底
  }
  return { zh: zhPath, en };
}

// 译文质检(LLM-as-judge):准确性/连贯性/翻译腔
export async function qaTranslation(pairs) {
  const blocks = pairs
    .map(
      (p) =>
        `=== ${p.zh}(中文原文)===\n${readFileSync(p.zh, "utf8")}\n\n=== ${p.en}(英文译文)===\n${readFileSync(p.en, "utf8")}`
    )
    .join("\n\n");
  return await callLLM(qSys(), blocks, FAST_MODEL);
}
