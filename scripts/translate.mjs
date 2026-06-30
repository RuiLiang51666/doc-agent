import { readFileSync } from "node:fs";
import { callLLM, FAST_MODEL } from "./llm.mjs";

const tSys = () => readFileSync(new URL("../prompts/translate.md", import.meta.url), "utf8");
const qSys = () => readFileSync(new URL("../prompts/translate-qa.md", import.meta.url), "utf8");

// 中文 canonical 路径 → 英文镜像路径
export const toEn = (zhPath) => zhPath.replace(/^docs\/zh\//, "docs/en/");

// 把一篇中文文档翻成英文,返回英文全文。
export async function translate(zhPath) {
  return await callLLM(
    tSys(),
    `把下面这篇中文技术文档翻译成英文,只输出译文全文:\n\n${readFileSync(zhPath, "utf8")}`,
    FAST_MODEL
  );
}

// 译文质检:给若干「原文+译文」对,返回一份简短报告。
export async function qaTranslation(pairs) {
  const blocks = pairs
    .map(
      (p) =>
        `=== ${p.zh}(中文原文)===\n${readFileSync(p.zh, "utf8")}\n\n=== ${p.en}(英文译文)===\n${readFileSync(p.en, "utf8")}`
    )
    .join("\n\n");
  return await callLLM(qSys(), blocks, FAST_MODEL);
}
