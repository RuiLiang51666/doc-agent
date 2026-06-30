import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sh = (cmd) => execSync(cmd, { encoding: "utf8" });
const cfg = (p) => fileURLToPath(new URL(p, import.meta.url));

// 在文档 PR 上跑拼写(cspell)+ 坏链(markdown-link-check)检查,结果贴成 PR 评论。
// 提示性:发现问题只评论提醒,不阻断合并(要硬卡可把本 job 设成 branch protection 必过项)。
export async function runCheck(prNumber) {
  const allMd = sh(`git ls-files 'docs/**/*.md' '*.md'`).trim().split("\n").filter(Boolean);
  if (allMd.length === 0) return true;
  const problems = [];

  // 拼写只查英文(cspell 不适合中文);坏链查全部
  const enMd = sh(`git ls-files 'docs/en/**/*.md' '*.md'`).trim().split("\n").filter(Boolean);
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
  writeFileSync("/tmp/check.md", body);
  sh(`gh pr comment ${prNumber} --body-file /tmp/check.md`);
  return problems.length === 0;
}
