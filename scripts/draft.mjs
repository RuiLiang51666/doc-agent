// docs-draft workflow 的脚本:按已批准的计划写初稿,提文档 PR。
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { callLLM, extractJSON } from "./llm.mjs";
import { applyEdits } from "./edits.mjs";
import { loadStyle } from "./style.mjs";
import { runCheck } from "./checklib.mjs";
import { translate, toEn, qaTranslation } from "./translate.mjs";

const sh = (cmd) => execSync(cmd, { encoding: "utf8" });
const { ISSUE_NUMBER, ISSUE_BODY } = process.env;

// 从计划 Issue 解出源 PR 号和待改文件(对应 assess.mjs 写出的格式)
const prNum = (ISSUE_BODY.match(/#(\d+)/) || [])[1];
const planFiles = [...ISSUE_BODY.matchAll(/- \[ \] `([^`]+)`/g)].map((m) => m[1]);
if (planFiles.length === 0) process.exit(0);

const branch = `docs/plan-${ISSUE_NUMBER}`;

// 幂等:重复 /approve 时若文档 PR 已建过就跳过,避免重复建分支/PR 报错
if (sh(`gh pr list --head ${branch} --state all --json number --jq 'length'`).trim() !== "0") {
  console.log(`文档 PR(${branch})已存在,跳过`);
  process.exit(0);
}

try {
  sh(`git config user.name docs-bot`);
  sh(`git config user.email docs-bot@users.noreply.github.com`);
  sh(`git switch -c ${branch}`);

  const system =
    readFileSync(new URL("../prompts/draft.md", import.meta.url), "utf8") +
    "\n\n# 技术写作规范\n" +
    loadStyle();
  const current = planFiles.map((f) => `=== ${f} ===\n${readFileSync(f, "utf8")}`).join("\n\n");
  const { edits } = extractJSON(
    await callLLM(system, `批准的计划(Issue #${ISSUE_NUMBER}):\n${ISSUE_BODY}\n\n当前文档:\n${current}`)
  );
  const editedPaths = applyEdits(edits);

  // 同步英文镜像:把改动到的中文 canonical 翻成英文写入 docs/en
  const enPairs = [];
  for (const zh of editedPaths.filter((p) => p.startsWith("docs/zh/"))) {
    const en = toEn(zh);
    const t = await translate(zh);
    writeFileSync(en, t.endsWith("\n") ? t : t + "\n");
    enPairs.push({ zh, en });
  }

  const base = sh(`gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`).trim();
  let prTitle = "";
  try {
    prTitle = sh(`gh pr view ${prNum} --json title --jq .title`).trim();
  } catch {}

  // 文档改动:复用计划里的"必须更新"清单(去掉勾选框),没有就退回到改动文件列表
  const planItems = ((ISSUE_BODY.match(/\*\*必须更新\*\*\s*\n([\s\S]*?)\n\s*\n/) || [, ""])[1] || "").replace(
    /- \[ \] /g,
    "- "
  );
  const changed = planItems || editedPaths.map((p) => "- `" + p + "`").join("\n");

  const body = `## 背景
依据已合并的代码改动 **#${prNum}${prTitle ? ` — ${prTitle}` : ""}** 自动更新文档,执行已批准的计划 #${ISSUE_NUMBER}。

## 文档改动
${changed}

## 目标分支
\`${base}\`

---
Source: #${prNum} · Closes #${ISSUE_NUMBER}`;

  // 文档 PR 标题复用计划 Issue 的描述性标题(去掉前缀 📝)
  const issueTitle = sh(`gh issue view ${ISSUE_NUMBER} --json title --jq .title`).trim();
  const docTitle = issueTitle.replace(/^📝\s*/, "").replace(/["`$\\]/g, "");

  writeFileSync("/tmp/pr.md", body);
  sh(`git commit -aqm "${docTitle}"`);
  sh(`git push -u origin ${branch}`);
  const out = sh(
    `gh pr create --base ${base} --head ${branch} --title "${docTitle}" --label docs/draft --body-file /tmp/pr.md`
  ).trim();

  // 文档审核(拼写/坏链):提示性贴评论,不阻断
  const docPr = (out.match(/\/pull\/(\d+)/) || [])[1];
  if (docPr) await runCheck(docPr).catch(() => {});

  // 译文质检(LLM-as-judge):准确性/连贯性/翻译腔,提示性贴评论
  if (docPr && enPairs.length) {
    const report = await qaTranslation(enPairs).catch(() => null);
    if (report) {
      writeFileSync("/tmp/qa.md", `🌐 **译文质检**(提示性)\n\n${report}`);
      sh(`gh pr comment ${docPr} --body-file /tmp/qa.md`);
    }
  }
} catch (e) {
  // 失败时在计划 Issue 上留言,让人看得见(而不是只在 Actions 里红一下)
  writeFileSync(
    "/tmp/err.md",
    `⚠️ 自动写初稿失败,请看 Actions 日志,或重新评论 \`/approve\` 重试。\n\n\`\`\`\n${String(e.message || e).slice(0, 500)}\n\`\`\``
  );
  try {
    sh(`gh issue comment ${ISSUE_NUMBER} --body-file /tmp/err.md`);
  } catch {}
  console.error(e);
  process.exit(1);
}
