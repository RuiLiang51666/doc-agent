// 文档预筛离线单测:标识符抽取 / covers 与标题解析 / 打分排序 / 预算内组装。纯函数、零网络。
// 跑:node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractIdentifiers, parseCovers, docTitle, scoreDocs, buildPlanPrompt } from "../scripts/prefilter.mjs";
import { loadConfig } from "../scripts/config.mjs";
import { estimateTokens } from "../scripts/budget.mjs";

// 仿 Apollo #5655:新增「OIDC 用户名 claim」配置
const OIDC_DIFF = {
  path: "apollo-portal/src/main/java/com/ctrip/framework/apollo/portal/spi/oidc/OidcUserInfoUtil.java",
  text: [
    "diff --git a/x b/x",
    "+++ b/x",
    "+import com.ctrip.framework.apollo.portal.spi.configuration.OidcExtendProperties;",
    "+public class OidcUserInfoUtil {",
    '+  @Value("${spring.security.oauth2.client.provider.oidc.user-name-attribute:preferred_username}")',
    "+  public static String getUserIdClaimName(OidcExtendProperties p) {",
    '+    return System.getenv("APOLLO_PORTAL_OIDC_CLAIM");',
    "+  }",
    "+  String resolveUserName(Jwt jwt) { return jwt.getClaimAsString(claim); }",
  ].join("\n"),
};

const DOCS = [
  {
    path: "docs/zh/extension/portal-how-to-implement-user-login-function.md",
    text: "# 实现用户登录\n\n配置 `spring.security.oauth2.client.provider.oidc.user-name-attribute` 指定用户名 claim。OIDC 登录 apollo portal。\n",
  },
  {
    path: "docs/zh/client/java-sdk-user-guide.md",
    text: "# Java 客户端\n\n" + "apollo 客户端 getValue getKey config 用户 user info holder event listener。\n".repeat(200),
  },
  { path: "docs/zh/deployment/quick-start.md", text: "# 快速开始\n\napollo portal 本地启动。\n" },
];

test("extractIdentifiers:配置键 / 类名 / 环境变量 / 方法名带权重;import 跳过,存取器降权", () => {
  const ids = extractIdentifiers([OIDC_DIFF]);
  const w = (id) => ids.find((i) => i.id === id)?.weight;
  assert.equal(w("spring.security.oauth2.client.provider.oidc.user-name-attribute"), 5);
  assert.equal(w("OidcUserInfoUtil"), 4);
  assert.equal(w("APOLLO_PORTAL_OIDC_CLAIM"), 3);
  assert.equal(w("resolveUserName"), 3);
  assert.equal(w("getUserIdClaimName"), 1); // get/set/is/has 存取器在文档里太常见,降权
  assert.ok(ids.some((i) => i.kind === "word" && i.id === "oidc"));
  assert.ok(!ids.some((i) => i.id.startsWith("com.ctrip"))); // 包名不当配置键
});

test("parseCovers / docTitle:块列表与行内列表、标题逐级回退", () => {
  assert.deepEqual(parseCovers("---\ncovers:\n  - src/a.ts\n  - 'src/b.ts'\ntitle: X\n---\n# H"), ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(parseCovers('---\ncovers: [src/a.ts, "src/b/**"]\n---\n'), ["src/a.ts", "src/b/**"]);
  assert.deepEqual(parseCovers("# 没有 frontmatter"), []);
  assert.equal(docTitle("---\ntitle: 快速开始\n---\n# 别的", "docs/zh/q.md"), "快速开始");
  assert.equal(docTitle("```bash\n# 注释不是标题\n```\n\n# 分布式部署指南\n", "docs/zh/d.md"), "分布式部署指南");
  assert.equal(docTitle("正文", "docs/zh/deployment/x.md"), "x.md");
});

test("scoreDocs:精确命中配置键的短文档排第一;长文档靠泛词堆分被长度归一化压下去;按分数降序", () => {
  const ranked = scoreDocs(DOCS, extractIdentifiers([OIDC_DIFF]), [OIDC_DIFF.path]);
  assert.equal(ranked[0].path, DOCS[0].path);
  assert.ok(ranked[0].hits.includes("spring.security.oauth2.client.provider.oidc.user-name-attribute"));
  assert.ok(ranked.every((d, i) => i === 0 || ranked[i - 1].score >= d.score));
});

test("scoreDocs:covers: 声明覆盖了改动文件的文档直接顶到最前", () => {
  const docs = [
    { path: "docs/zh/a.md", text: "# A\n\nOidcUserInfoUtil 与 spring.security.oauth2.client.provider.oidc.user-name-attribute\n" },
    { path: "docs/zh/b.md", text: "---\ncovers:\n  - apollo-portal/src/main/java/**/oidc/**\n---\n# B\n" },
  ];
  const ranked = scoreDocs(docs, extractIdentifiers([OIDC_DIFF]), [OIDC_DIFF.path]);
  assert.equal(ranked[0].path, "docs/zh/b.md");
  assert.ok(ranked[0].hits.includes("covers:"));
});

test("buildPlanPrompt:预算内按得分放全文,索引列全部文档并给入选的打 ★,总量不超预算", () => {
  const cfg = loadConfig({ PLAN_TOKEN_BUDGET: "3000", DIFF_TOKEN_BUDGET: "500" });
  const system = "评估器提示词";
  const { user, stats } = buildPlanPrompt({ prNumber: 5655, prTitle: "oidc", system, diffFiles: [OIDC_DIFF], docs: DOCS, codeFiles: [OIDC_DIFF.path], cfg });
  assert.ok(stats.tokens <= 3000 && estimateTokens(system) + estimateTokens(user) <= 3000);
  for (const d of DOCS) assert.ok(user.includes(d.path)); // 索引里有全部文档
  assert.match(user, /- ★ docs\/zh\/extension\/portal-how-to-implement-user-login-function\.md — 实现用户登录/);
  assert.match(user, /=== docs\/zh\/extension\/portal-how-to-implement-user-login-function\.md ===/);
  // 长文档(估算约 4000+ token)放不下:只进索引、不附全文
  assert.match(user, /- docs\/zh\/client\/java-sdk-user-guide\.md — Java 客户端/);
  assert.ok(!user.includes("=== docs/zh/client/java-sdk-user-guide.md ==="));
  assert.equal(stats.docsTotal, 3);
});

test("buildPlanPrompt:diff 超出 diff 预算按文件截断并标注;固定部分就超预算 → BudgetError", () => {
  const big = { path: "apollo-portal/src/main/java/Big.java", text: Array.from({ length: 3000 }, (_, i) => `+  int field${i} = ${i};`).join("\n") };
  const cfg = loadConfig({ PLAN_TOKEN_BUDGET: "20000", DIFF_TOKEN_BUDGET: "800" });
  const { user, stats } = buildPlanPrompt({ prNumber: 1, prTitle: "t", system: "s", diffFiles: [OIDC_DIFF, big], docs: DOCS, codeFiles: null, cfg });
  assert.deepEqual(stats.diff.truncated, [big.path]);
  assert.ok(stats.diff.tokens <= 800);
  assert.match(user, /其中 1 个已截断/);
  assert.match(user, /\[已截断:该文件 diff 共 3000 行/);

  const tiny = loadConfig({ PLAN_TOKEN_BUDGET: "100", DIFF_TOKEN_BUDGET: "50" });
  assert.throws(
    () => buildPlanPrompt({ prNumber: 1, prTitle: "t", system: "x".repeat(1000), diffFiles: [OIDC_DIFF], docs: DOCS, codeFiles: [], cfg: tiny }),
    (e) => e.code === "DOC_AGENT_BUDGET" && /超出预算 100/.test(e.message)
  );
});

test("buildPlanPrompt:得分为 0 的文档预算再够也不放全文、只进索引;低分但非 0 的照样放(不设其他相对阈值)", () => {
  const cfg = loadConfig({ PLAN_TOKEN_BUDGET: "60000", DIFF_TOKEN_BUDGET: "5000" });
  const docs = [...DOCS, { path: "docs/zh/community/thank-you.md", text: "# 致谢\n\n感谢每一位贡献者。\n" }];
  const { user, stats } = buildPlanPrompt({ prNumber: 5655, prTitle: "oidc", system: "s", diffFiles: [OIDC_DIFF], docs, codeFiles: [OIDC_DIFF.path], cfg });
  const zero = stats.ranked.find((d) => d.path === "docs/zh/community/thank-you.md");
  assert.equal(zero.score, 0);
  assert.equal(zero.full, false);
  assert.equal(stats.zeroScore, 1);
  assert.match(user, /^- docs\/zh\/community\/thank-you\.md — 致谢$/m); // 在索引里,不带 ★
  assert.ok(!user.includes("=== docs/zh/community/thank-you.md ==="));
  assert.equal(stats.selected.length, 3); // 其余 3 篇(含靠泛词得低分的 java-sdk-user-guide)都放了全文
});
