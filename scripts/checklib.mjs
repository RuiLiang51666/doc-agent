import { execSync, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";

const sh = (cmd) => execSync(cmd, { encoding: "utf8" });
const cfg = (p) => fileURLToPath(new URL(p, import.meta.url));

// 在文档 PR 上跑拼写(cspell)+ 坏链(markdown-link-check)检查,结果贴成 PR 评论。
// 提示性:发现问题只评论提醒,不阻断合并(要硬卡可把本 job 设成 branch protection 必过项)。
export async function runCheck(prNumber) {
  // 检查范围 = docs-glob(默认 *.md)。git pathspec 里的 * 会跨目录,所以默认就是全仓 md——
  // 与历史写死的 'docs/**/*.md' '*.md'(拼写那份 'docs/en/**/*.md' '*.md' 也一样)完全等价。
  // -z:中文文件名不被 git 转义;只查本次改动的增量质检留待后续。
  const allMd = execFileSync("git", ["ls-files", "-z", "--", ...loadConfig().docsGlobs], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
  if (allMd.length === 0) return true;
  const problems = [];

  // 拼写(cspell)与坏链用同一份清单,与历史行为一致
  const enMd = allMd;
  if (enMd.length) {
    try {
      sh(
        `npx --yes cspell@8 --no-progress --no-summary --config ${cfg("../config/cspell.json")} ${enMd
          .map((f) => `"${f}"`)
          .join(" ")}`
      );
    } catch (e) {
      problems.push("**拼写(cspell)**\n```\n" + String(e.stdout || e.message).trim().slice(0, 1500) + "\n```");
    }
  }

  // 坏链(逐文件)
  const linkErrs = [];
  for (const f of allMd) {
    try {
      sh(`npx --yes markdown-link-check --quiet --config ${cfg("../config/mlc.json")} "${f}"`);
    } catch (e) {
      const bad = String(e.stdout || e.message)
        .split("\n")
        .filter((l) => /✖|\[✖\]|ERROR|dead/.test(l))
        .join("\n");
      linkErrs.push(`- \`${f}\`\n${bad}`);
    }
  }
  if (linkErrs.length) problems.push("**坏链(markdown-link-check)**\n" + linkErrs.join("\n"));

  const body = problems.length
    ? `📋 **文档审核发现问题**(提示性,不阻断合并):\n\n${problems.join("\n\n")}`
    : `📋 文档审核通过 ✅ 拼写、链接均无问题。`;
  // 临时文件走 TMPDIR:server 形态每个任务一个独立目录,并发任务互不覆盖正文
  const out = join(tmpdir(), "check.md");
  writeFileSync(out, body);
  sh(`gh pr comment ${prNumber} --body-file "${out}"`);
  return problems.length === 0;
}
