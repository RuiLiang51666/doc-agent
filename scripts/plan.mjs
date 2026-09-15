// docs-plan workflow 的脚本:评估文档影响,有影响就开计划 Issue。
// 护栏(不静默、幂等):配置的代码路径没改动 → 明确日志 + Step Summary;同一 PR 已有计划 Issue → 跳过;
// 任何异常(超预算 / 模型接口报错 / schema 校验失败 …)→ 在被合并的代码 PR 下回帖说明原因类别,并以失败退出。
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStage } from "./llm.mjs";
import { embedContract } from "./contract.mjs";
import { loadConfig } from "./config.mjs";
import { codeChangedFiles } from "./diff.mjs";
import { planInput, findPlanIssue, classifyError, stepSummary, formatStats } from "./planlib.mjs";
import { sh, shRead } from "./sh.mjs";

const { GITHUB_REPOSITORY, PR_NUMBER, PR_TITLE, MERGE_SHA } = process.env;
const tmp = (name) => join(tmpdir(), name);
const report = (msg) => {
  console.log(msg);
  stepSummary(msg);
};

// 同一源 PR 的计划 Issue(按契约 sourcePr 定位,存量 Issue 认标题 "(#N)");没有返回 null
const existingPlan = () =>
  findPlanIssue(
    JSON.parse(shRead(`gh issue list --label docs/plan --state all --limit 500 --json number,title,body`)),
    PR_NUMBER
  );

try {
  const cfg = loadConfig();
  const codeFiles = codeChangedFiles(MERGE_SHA, cfg);
  if (codeFiles.length === 0) {
    report(`doc-agent plan:PR #${PR_NUMBER} 在配置的代码路径(${cfg.codePaths.join(", ")})下没有改动,跳过文档评估。`);
    process.exit(0);
  }

  // 幂等:手动 Re-run、webhook 重投时不重复开计划
  const dup = existingPlan();
  if (dup) {
    report(`doc-agent plan:PR #${PR_NUMBER} 已有计划 Issue #${dup.number},跳过(避免重复开 Issue)。`);
    process.exit(0);
  }

  // 预筛 + 预算:高相关文档放全文,其余只给「路径 + 标题」索引;固定部分就放不下时抛 BudgetError
  const { system, user, stats } = planInput({ cfg, sha: MERGE_SHA, prNumber: PR_NUMBER, prTitle: PR_TITLE, codeFiles });
  console.log(formatStats(stats));

  const plan = await runStage({ stage: "plan", system, user });
  if (!plan.update) {
    report(`Docs ✓ 无需更新 — ${plan.reason}`);
    process.exit(0);
  }

  const items = plan.items.map((i) => `- [ ] \`${i.file}\` — ${i.change}`).join("\n");
  const skipped = (plan.skipped || []).map((s) => `- \`${s.file}\` — ${s.reason}`).join("\n");
  const body = `源代码变更:#${PR_NUMBER} @ ${MERGE_SHA}

**必须更新**
${items}

**评估为无需改动**
${skipped || "(无)"}

<sub>${formatStats(stats)}</sub>

审批:在本 Issue 下评论 \`/approve\`,即开始写文档初稿并提 PR。` +
    // 机读契约:draft 阶段据此拿源 PR 号、合并提交与待改文件,不再正则抠正文(方案 A ①)
    embedContract("plan", {
      sourcePr: Number(PR_NUMBER),
      mergeSha: MERGE_SHA,
      items: plan.items,
      skipped: plan.skipped || [],
    });

  // 调模型的这段时间里可能被重复触发并先开了 Issue:创建前再查一次
  const dup2 = existingPlan();
  if (dup2) {
    report(`doc-agent plan:PR #${PR_NUMBER} 已有计划 Issue #${dup2.number},跳过(避免重复开 Issue)。`);
    process.exit(0);
  }

  // 标题带上"改什么"的一句话描述(去掉对 shell 危险的字符)
  const title = (plan.title || "更新文档").replace(/["`$\\\n]/g, "").trim().slice(0, 60);

  writeFileSync(tmp("plan.md"), body);
  sh(`gh issue create --title "📝 docs: ${title} (#${PR_NUMBER})" --label docs/plan --body-file "${tmp("plan.md")}"`);
} catch (e) {
  // 失败时在被合并的代码 PR 下回帖(PR 评论走 issues 接口,plan job 的 issues: write 权限即可)
  const kind = classifyError(e);
  const body = `⚠️ doc-agent 文档影响评估失败 —— 原因类别:**${kind.label}**

\`\`\`
${String(e.message || e).slice(0, 500)}
\`\`\`

排查后在 Actions 里 Re-run 该 job 即可重试(同一 PR 已有计划 Issue 时会自动跳过,不会重复开)。`;
  stepSummary(body);
  try {
    writeFileSync(tmp("plan-err.md"), body);
    sh(`gh api repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments -F body=@"${tmp("plan-err.md")}"`);
  } catch (err) {
    console.error(`在 PR #${PR_NUMBER} 下回帖失败:${err.message}`);
  }
  console.error(e);
  process.exit(1);
}
