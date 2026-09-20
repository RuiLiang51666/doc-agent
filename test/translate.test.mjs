// 整篇翻译的分块、显式输出上限与截断识别,以及「增量同步失败不再静默兜底」的离线测试。
// 夹具是 Apollo 真实文档(docs/zh 与 docs/en 的 portal-how-to-implement-user-login-function.md,
// 17043 / 25230 字符),正是 #5655 回放里整篇重译被截断、整份初稿作废的那一篇。
// 跑:node --test --test-timeout=15000 test/translate.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockLLM, put } from "./fakes.mjs";

const ZH = readFileSync(new URL("./fixtures/apollo-oidc-login.zh.md", import.meta.url), "utf8");
const EN = readFileSync(new URL("./fixtures/apollo-oidc-login.en.md", import.meta.url), "utf8");
const DOC = "docs/zh/extension/portal-how-to-implement-user-login-function.md";
const DST = "docs/en/extension/portal-how-to-implement-user-login-function.md";

// mock 模型:强制一个输出上限。真接口按 token 计,这里按**字符**计(好写死);没带 max_tokens 就按 1024,
// 即实测 glm-4-flash 的接口默认值——v1.2.1 的整篇翻译正是栽在这个默认值上。
// 「译文」= 原文前面加一行标记:长度与原文相当,既能数块数,又能验出截断。
const llm = await startMockLLM((body) => {
  // 增量同步的「跑偏」替身:该给 JSON 却回了一段文字 → 归类「模型输出校验失败」,正是要验的兜底入口
  if (body.model === "sync-bad-x") return { content: "这条改动我不确定该怎么同步,建议人工处理。" };
  const user = body.messages[1].content;
  const src = user.slice(user.indexOf("\n\n") + 2); // 提示语之后才是要翻译的原文
  const out = `<<EN>>\n${src}`;
  const cap = body.max_tokens || 1024;
  return out.length > cap ? { content: out.slice(0, cap), finish: "length" } : { content: out };
});
after(() => llm.close());

process.env.LLM_BASE_URL = llm.url;
process.env.LLM_API_KEY = "test-key";
process.env.LLM_MODEL = "strong-x";
process.env.LLM_FAST_MODEL = "fast-x";
const { splitByHeadings, syncTranslation, DEFAULT_CHUNK_CHARS, DEFAULT_OUTPUT_MAX_TOKENS } = await import(
  "../scripts/translate.mjs"
);
const { classifyError } = await import("../scripts/errors.mjs");

// 每个用例一个临时仓库目录(相对路径靠 cwd 解析)
function setup({ withTarget = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "doc-agent-translate-"));
  put(root, DOC, ZH);
  if (withTarget) put(root, DST, EN);
  process.chdir(root);
  return root;
}
const seen = () => llm.requests.length;
const since = (n) => llm.requests.slice(n);

test("splitByHeadings:按标题切块,代码围栏里的 # 不当标题;块拼回来即原文", () => {
  const chunks = splitByHeadings(ZH);
  assert.equal(chunks.join("\n"), ZH); // 逐字节拼回原文
  assert.ok(chunks.length >= 5, `块数 ${chunks.length}`);
  // 除第一块(标题前的开头段)外,每块都从标题行开始
  for (const c of chunks.slice(1)) assert.match(c.split("\n")[0], /^#{1,6}\s/);
  // 围栏里的 `## Adjust log dir if necessary` 是 startup.sh 示例的注释,不许成为切点
  assert.ok(!chunks.some((c) => c.startsWith("## Adjust log dir")), "代码围栏里的 # 被当成标题切开了");
  const fenced = chunks.find((c) => c.includes("## Adjust log dir if necessary"));
  assert.ok(fenced && fenced.includes("```bash"), "代码块被劈成了两半");
  // 相邻小节会合并,单个小节超限时单独成块
  const oversize = chunks.filter((c) => c.length > DEFAULT_CHUNK_CHARS);
  for (const c of oversize) assert.equal(splitByHeadings(c).length, 1, "超限的块应当是不可再分的单个小节");
});

test("整篇翻译:按块逐块调用、每次显式带 max_tokens,拼出完整译文(不再被接口默认上限截断)", async () => {
  setup(); // 译文镜像不存在 → 走整篇翻译
  const n = seen();
  const pair = await syncTranslation(DOC, [{ path: DOC, create: true }]);
  const calls = since(n);
  assert.equal(pair.target, DST);

  // 块数 = splitByHeadings 的块数;每次调用都显式设了输出上限(不传 LLM_MAX_TOKENS 时用默认 4096)
  const chunks = splitByHeadings(ZH);
  assert.equal(calls.length, chunks.length);
  for (const c of calls) assert.equal(c.max_tokens, DEFAULT_OUTPUT_MAX_TOKENS);

  // 译文完整落盘:每块一段,首尾内容都在
  const out = readFileSync(DST, "utf8");
  assert.equal(out.match(/<<EN>>/g).length, chunks.length);
  assert.ok(out.includes("Apollo是配置管理系统"), "缺开头那一块");
  assert.ok(out.includes("实现方式四"), "缺最后一块");
  assert.ok(out.includes("user-id-claim-name") || out.includes("实现方式三"), "缺中间的 OIDC 小节");
  assert.ok(out.endsWith("\n"));
});

test("整篇翻译:不切块(块大到装下全文)→ 识别为截断、明确报错,半篇译文不落盘", async () => {
  setup();
  process.env.TRANSLATE_CHUNK_CHARS = "100000"; // 全文一块,必然超过输出上限
  const n = seen();
  await assert.rejects(
    () => syncTranslation(DOC, [{ path: DOC, create: true }]),
    (e) =>
      classifyError(e).key === "truncated" &&
      /第 1\/1 块被截断/.test(e.message) &&
      /译文没有落盘/.test(e.message)
  );
  assert.equal(since(n).length, 1);
  assert.ok(!existsSync(DST), "被截断时不许写出半篇译文");
  delete process.env.TRANSLATE_CHUNK_CHARS;
});

test("增量同步失败:原因类别与错误信息进日志和 Step Summary,再转整篇重译兜底(不再静默)", async () => {
  const root = setup({ withTarget: true });
  const summary = join(root, "summary.md");
  process.env.GITHUB_STEP_SUMMARY = summary;
  process.env.LLM_MODEL_SYNC = "sync-bad-x";
  appendFileSync(summary, "");
  const errs = [];
  const realError = console.error;
  console.error = (m) => errs.push(String(m));
  const n = seen();
  try {
    // sync 阶段要 JSON,mock 回的是译文文本 → 解析失败 → 归类「模型输出校验失败」→ 兜底整篇重译
    await syncTranslation(DOC, [{ path: DOC, old_string: "x", new_string: "y" }]);
  } finally {
    console.error = realError;
    delete process.env.GITHUB_STEP_SUMMARY;
    delete process.env.LLM_MODEL_SYNC;
  }
  const logged = errs.join("\n");
  assert.match(logged, /译文增量同步失败\(原因类别:\*\*模型输出校验失败\*\*\),转整篇重译兜底/);
  assert.match(logged, new RegExp(`${DOC} → ${DST}`));
  assert.match(logged, /无法从模型输出解析 JSON/); // 错误原文也写出来了
  assert.match(readFileSync(summary, "utf8"), /译文增量同步失败\(原因类别:\*\*模型输出校验失败\*\*\)/);
  // 兜底的整篇重译照样是分块的,译文完整
  assert.equal(since(n).length, 1 + splitByHeadings(ZH).length);
  assert.ok(readFileSync(DST, "utf8").includes("<<EN>>"));
});
