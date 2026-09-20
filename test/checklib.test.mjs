// 文档审核范围与占位 URL 的离线单测:注入 run 替身,不真跑 npx / gh。
// 覆盖:范围收窄到本次改动的文档(不再扫全仓)、非文档文件被滤掉、占位 URL 跳过并注明、
// 工具自身崩溃(TypeError: Invalid URL)不再被过滤成空条目。
// 跑:node --test --test-timeout=15000 test/checklib.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { put } from "./fakes.mjs";
import { runCheck, isPlaceholderUrl, collectLinks } from "../scripts/checklib.mjs";

// 本次改动的两篇 + 仓库里早就存在的一篇(不该被查)
const CHANGED_ZH = "docs/zh/extension/login.md";
const CHANGED_EN = "docs/en/extension/login.md";
const OLD_DOC = "docs/zh/deployment/quick-start.md";
const ZH = `# 登录

配置 OIDC:<https://host:port/auth/realms/apollo/.well-known/openid-configuration>

详见[部署](../deployment/quick-start.md)与[示例](https://example.com/a)。
`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "doc-agent-check-"));
  put(root, CHANGED_ZH, ZH);
  put(root, CHANGED_EN, "# Login\n\nSee [deploy](../deployment/quick-start.md).\n");
  put(root, OLD_DOC, "# 快速开始\n\n[坏链](https://dead.example.invalid/x)\n");
  put(root, "docs/zh/extension/login.png", "not markdown");
  process.chdir(root);
  return root;
}

// run 替身:记录每条命令;markdown-link-check 按 crash / dead / ok 三种情形回放
function fakeRun({ mlc = () => null } = {}) {
  const cmds = [];
  const run = (cmd) => {
    cmds.push(cmd);
    if (cmd.includes("markdown-link-check")) {
      const file = cmd.match(/"([^"]+)"$/)[1];
      const out = mlc(file);
      if (out) {
        const e = new Error(`Command failed: ${cmd}`);
        e.stdout = out;
        throw e;
      }
    }
    return "";
  };
  return { cmds, run };
}
const commentBody = (cmds) => readFileSync(cmds.at(-1).match(/--body-file "([^"]+)"/)[1], "utf8");

test("占位 URL 识别与链接提取", () => {
  for (const u of [
    "https://host:port/auth/realms/apollo/.well-known/openid-configuration",
    "https://<your-domain>/callback",
    "http://example.com/a",
    "https://your-idp.com/token",
  ])
    assert.ok(isPlaceholderUrl(u), u);
  for (const u of ["https://github.com/apolloconfig/apollo", "../deployment/quick-start.md", "#anchor"])
    assert.ok(!isPlaceholderUrl(u), u);
  assert.deepEqual(collectLinks(ZH), [
    "../deployment/quick-start.md",
    "https://example.com/a",
    "https://host:port/auth/realms/apollo/.well-known/openid-configuration",
  ]);
});

test("runCheck:只查本次改动的文档(不扫全仓),非 docs-glob 文件被滤掉", async () => {
  setup();
  const { cmds, run } = fakeRun();
  const ok = await runCheck(7, [CHANGED_ZH, CHANGED_EN, "docs/zh/extension/login.png", CHANGED_ZH], { run });
  assert.equal(ok, true);
  const all = cmds.join("\n");
  assert.ok(!all.includes(OLD_DOC), "扫到了本次没改的存量文档");
  assert.ok(!all.includes(".png"), "非 docs-glob 文件没被滤掉");
  assert.equal(cmds.filter((c) => c.includes("markdown-link-check")).length, 2); // 去重后两篇
  assert.equal(cmds.filter((c) => c.includes("cspell")).length, 1); // 拼写一次带上两篇
  const body = commentBody(cmds);
  assert.match(body, /文档审核通过 ✅/);
  assert.match(body, /范围:本次改动的 2 个文档/);
});

test("runCheck:占位 URL 跳过并注明,不让检查崩溃成空条目", async () => {
  setup();
  // 目标文档的检查「崩溃」:输出里没有 ✖ / ERROR / dead,v1.2.1 会过滤成一行文件名、下面空无一物
  const crash = "\nTypeError: Invalid URL\n    at new URL (node:internal/url:806:29)\n";
  const { cmds, run } = fakeRun({ mlc: (f) => (f === CHANGED_ZH ? crash : null) });
  const ok = await runCheck(7, [CHANGED_ZH, CHANGED_EN], { run });
  assert.equal(ok, false);
  const body = commentBody(cmds);
  assert.match(body, /检查未产出可解析结果\(工具自身报错,不代表链接有问题\):.*TypeError: Invalid URL/);
  assert.match(body, /已跳过的占位 URL/);
  assert.match(body, /`https:\/\/host:port\/auth\/realms\/apollo/);
  assert.match(body, /`https:\/\/example\.com\/a`/);
  // 传给 markdown-link-check 的配置里带上了占位 URL 的 ignorePatterns
  const conf = JSON.parse(readFileSync(cmds.find((c) => c.includes("markdown-link-check")).match(/--config (\S+)/)[1], "utf8"));
  assert.ok(conf.ignorePatterns.some((p) => /:port/.test(p.pattern)));
});

test("runCheck:真的坏链照常报出;本次没改文档则直接跳过、不贴评论", async () => {
  setup();
  const dead = "[✖] https://dead.example.invalid/x → Status: 0\n";
  const r1 = fakeRun({ mlc: (f) => (f === CHANGED_EN ? dead : null) });
  assert.equal(await runCheck(7, [CHANGED_ZH, CHANGED_EN], { run: r1.run }), false);
  assert.match(commentBody(r1.cmds), /坏链\(markdown-link-check\)[\s\S]*\[✖\] https:\/\/dead\.example\.invalid/);

  const r2 = fakeRun();
  assert.equal(await runCheck(7, ["src/main/java/Foo.java"], { run: r2.run }), true);
  assert.deepEqual(r2.cmds, []); // 一条命令都不发,更不会贴评论
});
