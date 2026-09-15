// 路径配置化离线单测:默认值 == 历史行为,以及 Apollo / KWDB docs 两种真实布局。纯函数、零网络。
// 跑:node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, parseList, globToRegExp, isCodePath, isSourceDoc, toTarget } from "../scripts/config.mjs";

test("config:默认值 == 历史写死的行为(src / docs/zh → docs/en / *.md)", () => {
  const cfg = loadConfig({});
  assert.ok(isCodePath("src/shortener.ts", cfg));
  assert.ok(!isCodePath("srcx/a.ts", cfg)); // 目录前缀按整段匹配
  assert.ok(!isCodePath("docs/zh/api.md", cfg));
  assert.ok(isSourceDoc("docs/zh/api.md", cfg));
  assert.ok(!isSourceDoc("docs/en/api.md", cfg));
  assert.ok(!isSourceDoc("docs/zh/images/a.png", cfg)); // 图片不再被当文档读进 prompt
  assert.equal(toTarget("docs/zh/api.md", cfg), "docs/en/api.md");
  assert.equal(cfg.sourceLang, "zh");
  // action 未传 input 时是空串:回落默认
  assert.deepEqual(loadConfig({ CODE_PATHS: "", DOCS_SOURCE_DIR: "  " }).codePaths, ["src"]);
});

test("config:Apollo 布局——多模块代码 + 排除测试,docs/zh/** ↔ docs/en/** 同路径", () => {
  const cfg = loadConfig({ CODE_PATHS: "apollo-*/src/**\nscripts/**\n:!**/src/test/**" });
  assert.ok(isCodePath("apollo-portal/src/main/java/com/ctrip/framework/apollo/portal/spi/oidc/OidcUserInfoUtil.java", cfg));
  assert.ok(isCodePath("apollo-configservice/src/main/resources/application.properties", cfg));
  assert.ok(isCodePath("scripts/build.sh", cfg));
  assert.ok(!isCodePath("apollo-portal/src/test/java/com/ctrip/framework/apollo/portal/spi/oidc/OidcUserInfoUtilTest.java", cfg));
  assert.ok(!isCodePath("docs/zh/extension/portal-how-to-implement-user-login-function.md", cfg));
  assert.ok(!isCodePath("CHANGES.md", cfg));
  assert.ok(isSourceDoc("docs/zh/deployment/distributed-deployment-guide.md", cfg));
  assert.ok(!isSourceDoc("docs/zh/images/deployment/btpanel/console.png", cfg));
  assert.ok(!isSourceDoc("doc/images/apollo-deployment.png", cfg)); // 根目录旧 doc/ 不算
  assert.equal(
    toTarget("docs/zh/extension/portal-how-to-implement-user-login-function.md", cfg),
    "docs/en/extension/portal-how-to-implement-user-login-function.md"
  );
});

test("config:KWDB docs 布局——中文在仓库根(排除 en/),英文在 en/ 同路径镜像", () => {
  const cfg = loadConfig({ DOCS_SOURCE_DIR: ".", DOCS_TARGET_DIR: "en/", DOCS_EXCLUDE: "README.md, CONTRIBUTING.md, .github/**" });
  assert.equal(cfg.sourceDir, "");
  assert.ok(isSourceDoc("sql-reference/functions/functions-relational-db.md", cfg));
  assert.ok(isSourceDoc("quick-start/intro.md", cfg));
  assert.ok(!isSourceDoc("en/sql-reference/functions/functions-relational-db.md", cfg)); // 译文目录在源目录内,自动排除
  assert.ok(!isSourceDoc("README.md", cfg));
  assert.ok(!isSourceDoc(".github/PULL_REQUEST_TEMPLATE.md", cfg));
  assert.ok(!isSourceDoc("static/images/arch.png", cfg));
  assert.ok(isSourceDoc("readme-guide/README.md", cfg)); // 排除模式锚定仓库根,不误伤子目录同名文件
  assert.equal(toTarget("sql-reference/functions/functions-relational-db.md", cfg), "en/sql-reference/functions/functions-relational-db.md");
  assert.throws(() => toTarget("en/a.md", loadConfig({ DOCS_SOURCE_DIR: "docs/zh" })), /不在源文档目录/);
});

test("config:glob 语义(** 含零层、* 不跨目录、任何模式按目录前缀)与列表解析", () => {
  assert.ok(globToRegExp("**/src/test/**").test("src/test/a.java"));
  assert.ok(globToRegExp("**/src/test/**").test("m/src/test/a.java"));
  assert.ok(!globToRegExp("apollo-*/src").test("apollo-a/b/src/x.java"));
  assert.ok(globToRegExp("docs/zh").test("docs/zh/a/b.md"));
  assert.ok(globToRegExp("*.md").test("a.md") && !globToRegExp("*.md").test("a.mdx"));
  assert.deepEqual(parseList("a, b\n# 注释\n\n c "), ["a", "b", "c"]);
});

test("config:非法配置快速失败", () => {
  assert.throws(() => loadConfig({ SOURCE_LANG: "ja" }), /source-lang/);
  assert.throws(() => loadConfig({ PLAN_TOKEN_BUDGET: "-1" }), /PLAN_TOKEN_BUDGET/);
  assert.throws(() => loadConfig({ DOCS_SOURCE_DIR: "docs/en" }), /不能相同/);
  assert.throws(() => loadConfig({ DOCS_TARGET_DIR: "." }), /根目录/);
});
