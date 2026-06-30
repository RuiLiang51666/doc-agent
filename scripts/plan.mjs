// docs-plan workflow 的脚本:评估文档影响,有影响就开计划 Issue。
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { callLLM, extractJSON } from "./llm.mjs";

const sh = (cmd) => execSync(cmd, { encoding: "utf8" });
const { PR_NUMBER, PR_TITLE, MERGE_SHA } = process.env;

// 用合并提交的第一父(MERGE_SHA^1)做基准,得到的正是「这个 PR 的净改动」。
// 不能用 pull_request.base.sha——它是 PR 创建时的旧基准,会把这期间别人合进
// main 的改动也算进来(曾导致合并文档 PR 时误报要改 src)。
const diff = sh(`git diff ${MERGE_SHA}^1 ${MERGE_SHA} -- src`);
if (!diff.trim()) process.exit(0); // 没动代码,不评估

const docFiles = sh(`git ls-files docs README.md`).trim().split("\n").filter(Boolean);
const docs = docFiles.map((f) => `=== ${f} ===\n${readFileSync(f, "utf8")}`).join("\n\n");

const system = readFileSync(new URL("../prompts/assess.md", import.meta.url), "utf8");
const plan = extractJSON(
  await callLLM(system, `PR #${PR_NUMBER} (${PR_TITLE}) diff:\n${diff}\n\n现有文档:\n${docs}`)
);

if (!plan.update) {
  console.log(`Docs ✓ 无需更新 — ${plan.reason}`);
  process.exit(0);
}

const items = plan.items.map((i) => `- [ ] \`${i.file}\` — ${i.change}`).join("\n");
const skipped = (plan.skipped || []).map((s) => `- \`${s.file}\` — ${s.reason}`).join("\n");
const body = `源代码变更:#${PR_NUMBER} @ ${MERGE_SHA}

**必须更新**
${items}

**评估为无需改动**
${skipped || "(无)"}

审批:评论 \`/approve\` 写初稿 · \`/regenerate\` 重出 · \`/skip\` 跳过`;

// 标题带上"改什么"的一句话描述(去掉对 shell 危险的字符)
const title = (plan.title || "更新文档").replace(/["`$\\\n]/g, "").trim().slice(0, 60);

writeFileSync("/tmp/plan.md", body);
sh(`gh issue create --title "📝 docs: ${title} (#${PR_NUMBER})" --label docs/plan --body-file /tmp/plan.md`);
