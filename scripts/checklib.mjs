import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, isDocFile } from "./config.mjs";

const sh = (cmd) => execSync(cmd, { encoding: "utf8" });
const cfg = (p) => fileURLToPath(new URL(p, import.meta.url));

// ── 占位 URL ──
// 文档里的示例地址(`https://host:port/...`、`https://<your-domain>/...`、example.com)不是真链接:
// markdown-link-check 解析它们会抛 TypeError: Invalid URL,整份文件的检查当场崩溃、一条结果都产不出
// (Apollo 回放 #5655:两篇目标文档就是这样被检查成了空条目)。这里统一跳过,并在评论里注明跳过了哪些。
export const PLACEHOLDER_PATTERNS = [
  "^\\w+://[^/]*:port\\b", // https://host:port/...
  "^\\w+://[^/]*[<>{}]", // https://<your-domain>/...
  "^\\w+://([^/]*\\.)?example\\.(com|org|net)\\b",
  "^\\w+://[^/]*your[-.]", // https://your-idp.com/...
];
export const isPlaceholderUrl = (u) => PLACEHOLDER_PATTERNS.some((p) => new RegExp(p, "i").test(String(u).trim()));

/** 文档里的链接地址:Markdown 行内链接 `](url)` 与尖括号自动链接 `<url>`。 */
export function collectLinks(text) {
  const urls = [...String(text).matchAll(/\]\(\s*([^)\s]+)/g)].map((m) => m[1]);
  urls.push(...[...String(text).matchAll(/<((?:https?|ftp):\/\/[^>\s]+)>/g)].map((m) => m[1]));
  return [...new Set(urls)];
}

// 工具崩溃时最有用的那一行:第一条不是调用栈(`at …`)的非空行,没有就退回最后一行
const firstError = (out) => {
  const lines = String(out)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return (lines.find((l) => !/^at\s/.test(l)) || lines.at(-1) || "").slice(0, 200);
};

// markdown-link-check 的配置 = 仓库里那份 + 占位 URL 的 ignorePatterns(两处用同一份正则,不会走岔)
function mlcConfig() {
  const base = JSON.parse(readFileSync(cfg("../config/mlc.json"), "utf8"));
  const out = join(tmpdir(), "doc-agent-mlc.json");
  writeFileSync(
    out,
    JSON.stringify({
      ...base,
      ignorePatterns: [...(base.ignorePatterns || []), ...PLACEHOLDER_PATTERNS.map((pattern) => ({ pattern }))],
    })
  );
  return out;
}

/**
 * 在文档 PR 上跑拼写(cspell)+ 坏链(markdown-link-check)检查,结果贴成 PR 评论。
 * 范围 = 本次文档 PR 改动的文件(changed,按 docs-glob 过滤),不再扫全仓:
 * v1.2.1 扫全仓在 Apollo 上占掉一次运行 63% 的时间,评论里 319 条坏链几乎都是仓库存量问题,真正该看的两篇反而被淹没。
 * 提示性:发现问题只评论提醒,不阻断合并(要硬卡可把本 job 设成 branch protection 必过项)。
 * run 可注入,便于离线测试(不真跑 npx / gh)。
 */
export async function runCheck(prNumber, changed = [], { run = sh } = {}) {
  const conf = loadConfig();
  const files = [...new Set(changed)].filter((f) => isDocFile(f, conf) && existsSync(f));
  if (files.length === 0) {
    console.log("文档审核:本次没有改动符合 docs-glob 的文档,跳过");
    return true;
  }
  console.log(`文档审核:只查本次改动的 ${files.length} 个文档 —— ${files.join(", ")}`);
  const problems = [];

  // 拼写(cspell)与坏链用同一份清单
  try {
    run(
      `npx --yes cspell@8 --no-progress --no-summary --config ${cfg("../config/cspell.json")} ${files
        .map((f) => `"${f}"`)
        .join(" ")}`
    );
  } catch (e) {
    problems.push("**拼写(cspell)**\n```\n" + String(e.stdout || e.message).trim().slice(0, 1500) + "\n```");
  }

  // 坏链(逐文件)。崩溃(如占位 URL 让它抛 TypeError)时输出里没有 ✖ / ERROR 行,不能当成「没问题」:如实注明。
  const mlc = mlcConfig();
  const linkErrs = [];
  const skippedNotes = [];
  for (const f of files) {
    const skipped = collectLinks(readFileSync(f, "utf8")).filter(isPlaceholderUrl);
    if (skipped.length) skippedNotes.push(`- \`${f}\`:${skipped.map((u) => `\`${u}\``).join("、")}`);
    try {
      run(`npx --yes markdown-link-check --quiet --config ${mlc} "${f}"`);
    } catch (e) {
      const out = String(e.stdout || e.message);
      const bad = out
        .split("\n")
        .filter((l) => /✖|\[✖\]|ERROR|dead/.test(l))
        .join("\n");
      linkErrs.push(
        bad ? `- \`${f}\`\n${bad}` : `- \`${f}\`\n  检查未产出可解析结果(工具自身报错,不代表链接有问题):${firstError(out)}`
      );
    }
  }
  if (linkErrs.length) problems.push("**坏链(markdown-link-check)**\n" + linkErrs.join("\n"));

  // 跳过的占位 URL 单列:它们不是问题,但必须写出来,免得「没报错」被当成「查过了」
  const skipNote = skippedNotes.length
    ? `\n\n**已跳过的占位 URL**(示例地址,不做可达性检查):\n${skippedNotes.join("\n")}`
    : "";
  const body =
    (problems.length
      ? `📋 **文档审核发现问题**(提示性,不阻断合并;范围:本次改动的 ${files.length} 个文档):\n\n${problems.join("\n\n")}`
      : `📋 文档审核通过 ✅ 拼写、链接均无问题(范围:本次改动的 ${files.length} 个文档)。`) + skipNote;
  // 临时文件走 TMPDIR:server 形态每个任务一个独立目录,并发任务互不覆盖正文
  const out = join(tmpdir(), "check.md");
  writeFileSync(out, body);
  run(`gh pr comment ${prNumber} --body-file "${out}"`);
  return problems.length === 0;
}
