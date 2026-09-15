// token 预算与 diff 截断的离线单测。纯函数、零网络。
// 跑:node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, truncateLines, buildDiffText } from "../scripts/budget.mjs";

const fakeDiff = (name, lines) =>
  `diff --git a/${name} b/${name}\n@@ -1,1 +1,${lines} @@\n` +
  Array.from({ length: lines }, (_, i) => `+  private String field${i} = "value-${i}";`).join("\n");

test("estimateTokens:ASCII 4 字符/token,中文 1 字/token", () => {
  assert.equal(estimateTokens("abcdefgh"), 2);
  assert.equal(estimateTokens("中文"), 2);
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(null), 0);
});

test("truncateLines:按整行截取,不超过上限", () => {
  const cut = truncateLines("aaaa\nbbbb\ncccc\ndddd", 5);
  assert.equal(cut.text, "aaaa\nbbbb");
  assert.equal(cut.keptLines, 2);
  assert.equal(cut.totalLines, 4);
});

test("buildDiffText:预算够时原样保留,不出现「已截断」", () => {
  const files = [
    { path: "src/a.ts", text: fakeDiff("src/a.ts", 5) },
    { path: "src/b.ts", text: fakeDiff("src/b.ts", 3) },
  ];
  const out = buildDiffText(files, 5000);
  assert.deepEqual(out.truncated, []);
  assert.ok(!out.text.includes("已截断"));
  assert.ok(out.text.includes("=== src/a.ts ===") && out.text.includes("field4"));
});

test("buildDiffText:超预算按文件截断——小文件保全,大文件截断处显式标注", () => {
  const files = [
    { path: "big/Huge.java", text: fakeDiff("big/Huge.java", 2000) },
    { path: "small/A.java", text: fakeDiff("small/A.java", 4) },
    { path: "small/B.java", text: fakeDiff("small/B.java", 4) },
  ];
  const budget = 1500;
  const out = buildDiffText(files, budget);
  assert.ok(out.tokens <= budget, `tokens ${out.tokens} > ${budget}`);
  assert.deepEqual(out.truncated, ["big/Huge.java"]);
  assert.match(out.text, /=== big\/Huge\.java ===[\s\S]*\[已截断:该文件 diff 共 \d+ 行,超出预算,只保留前 \d+ 行\]/);
  assert.ok(out.text.includes("field3") && out.text.includes("=== small/B.java ==="));
  // 原顺序输出
  assert.ok(out.text.indexOf("big/Huge.java") < out.text.indexOf("small/A.java"));
});

test("buildDiffText:文件多到连标题都放不下,也不超预算且说明未列出的数量", () => {
  const files = Array.from({ length: 200 }, (_, i) => ({ path: `src/f${i}.ts`, text: fakeDiff(`src/f${i}.ts`, 10) }));
  const budget = 600;
  const out = buildDiffText(files, budget);
  assert.ok(out.tokens <= budget, `tokens ${out.tokens} > ${budget}`);
  assert.match(out.text, /另有 \d+ 个改动文件超出预算,未列出/);
  assert.equal(out.truncated.length, 200);
});
