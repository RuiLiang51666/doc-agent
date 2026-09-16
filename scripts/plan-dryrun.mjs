// 本地干跑 plan 阶段的输入组装:不调模型,只看 diff 是否为空、预筛选中哪些文档、估算 token。
// 用法(在目标仓库根目录,路径配置用与 action inputs 同名的环境变量):
//   CODE_PATHS='apollo-*/src/**' node <doc-agent>/scripts/plan-dryrun.mjs <merge_sha> [PR 号] [PR 标题]
// 默认不访问 GitHub:取 diff 退回 <merge_sha>^1..<merge_sha>(merge / squash 合并下与正式运行一致),日志会写明。
// 可选 DRY_RUN_REPO=<owner/repo>:按正式运行的口径,用 GitHub 只读数据判定合并方式(rebase 合并取 M~k..M)。
// 可选 DRY_RUN_DUMP=<文件>:把组装好的 user prompt 写出来人工检查。
import { writeFileSync } from "node:fs";
import { loadConfig } from "./config.mjs";
import { codeChangedFiles, resolveDiffRange, describeRange } from "./diff.mjs";
import { planInput, formatStats } from "./planlib.mjs";
import { estimateTokens } from "./budget.mjs";

const [sha, prNumber = "?", prTitle = ""] = process.argv.slice(2);
if (!sha) {
  console.error("用法:node scripts/plan-dryrun.mjs <merge_sha> [PR 号] [PR 标题]");
  process.exit(2);
}

const cfg = loadConfig();
console.log(
  `配置:code-paths=[${cfg.codePaths.join(", ")}] docs=${cfg.sourceDir || "."} → ${cfg.targetDir} ` +
    `glob=[${cfg.docsGlobs.join(", ")}] 预算 plan=${cfg.planTokenBudget} / diff=${cfg.diffTokenBudget}`
);
const repo = process.env.DRY_RUN_REPO || "";
const range = resolveDiffRange({ sha, prNumber: repo ? prNumber : "", repo });
const codeFiles = codeChangedFiles(range, cfg);
console.log(`配置的代码路径下改动文件 ${codeFiles.length} 个(${describeRange(range)}):`);
for (const p of codeFiles) console.log(`  ${p}`);
if (codeFiles.length === 0) {
  console.log("diff 为空:正式运行会输出明确日志 + 写 Step Summary 并跳过评估");
  process.exit(0);
}

try {
  const { system, user, stats } = planInput({ cfg, range, prNumber, prTitle, codeFiles });
  console.log(`diff 非空:${stats.diff.files} 个文件,约 ${stats.diff.tokens} token;已截断:${stats.diff.truncated.join(", ") || "无"}`);
  console.log(`放全文的文档 ${stats.selected.length}/${stats.docsTotal} 篇(得分 / 路径 / 估算 token / 主要命中):`);
  for (const d of stats.selected)
    console.log(`  ${d.score.toFixed(2).padStart(8)}  ${d.path}  ~${d.tokens}  [${d.hits.join(", ")}]`);
  console.log(`得分为 0、只进索引的文档 ${stats.zeroScore} 篇`);
  console.log("只进索引的得分前 5 篇:");
  for (const d of stats.ranked.filter((x) => !x.full).slice(0, 5))
    console.log(`  ${d.score.toFixed(2).padStart(8)}  ${d.path}`);
  console.log(formatStats(stats));
  console.log(
    `组装后 prompt 估算 token:${stats.tokens}(system ${estimateTokens(system)} + user ${estimateTokens(user)});预算上限 ${stats.budget}`
  );
  if (process.env.DRY_RUN_DUMP) writeFileSync(process.env.DRY_RUN_DUMP, user);
} catch (e) {
  console.error(`组装失败(${e.name}):${e.message}`);
  process.exit(1);
}
