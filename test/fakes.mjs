// e2e 测试共用的替身(文件名不以 .test.mjs 结尾,node --test 不会把它当用例跑):
// 假 gh(按规则回放输出,记录每次调用及正文)、假 npx(文档审核不联网)、本机 mock 大模型接口、临时 git 仓库工具。
import http from "node:http";
import { writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFile, execFileSync } from "node:child_process";

/**
 * 在 dir 下写假 gh 与 npx。
 * gh:把参数拼成一行,按 FAKE_GH_RULES(JSON:[[正则, 输出, 退出码?], ...])逐条匹配,第一条命中的生效
 * (退出码非 0 时输出写到 stderr,模拟 gh 报错,如 "gh: Resource not accessible by integration (HTTP 403)");
 * 都没命中时,api 读请求(不带 -f / -F)按 404 失败,其余调用成功、无输出。
 * 每次调用连同 --body-file / -F body=@file 的正文追加写进 FAKE_GH_LOG。
 */
export function writeFakeBin(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "gh"),
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const line = args.join(" ");
let entry = "gh " + line;
args.forEach((a, i) => {
  if (a === "--body-file") entry += "\\n" + fs.readFileSync(args[i + 1], "utf8");
  if ((a === "-F" || a === "-f") && /^body=@/.test(args[i + 1] || "")) entry += "\\n" + fs.readFileSync(args[i + 1].slice(6), "utf8");
});
fs.appendFileSync(process.env.FAKE_GH_LOG, entry + "\\n");
for (const [re, out, code] of JSON.parse(process.env.FAKE_GH_RULES || "[]")) {
  if (new RegExp(re).test(line)) {
    (code ? process.stderr : process.stdout).write(out);
    process.exit(code || 0);
  }
}
if (args[0] === "api" && !args.includes("-f") && !args.includes("-F")) {
  process.stderr.write("gh: Not Found (HTTP 404)\\n");
  process.exit(1);
}
`
  );
  writeFileSync(join(dir, "npx"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "gh"), 0o755);
  chmodSync(join(dir, "npx"), 0o755);
}

/**
 * 本机 mock 大模型(OpenAI 兼容 /chat/completions)。handler(请求体) → { content, finish?, usage? } 或 { status, body };
 * 可以是 async。requests 记下每次请求体。usage 原样放进响应(没给就不带,模拟接口不返回用量)。
 *
 * 铁律:替身自己出错(handler 抛异常、新加的分支忘了 return、请求体不是 JSON)也必须回一个响应。
 * 不回响应的代价不是「这条用例报错」,而是「这条用例永远不结束」:被测的 callLLM 会干等 LLM_TIMEOUT_MS
 * (默认 120s)才 abort,abort 归类为网络异常还要再重试到 NETWORK_MAX_ATTEMPTS 次(≈6 分钟),
 * 期间 --test-timeout 早就把用例判成 timed out,真正的原因(替身写错了)却一个字都看不到。
 * 所以这里统一兜成 400(llm.mjs 对 4xx 不重试):用例立刻失败,且失败信息直接写着替身哪里错了。
 */
export async function startMockLLM(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      try {
        const body = JSON.parse(raw);
        requests.push(body);
        const r = await handler(body);
        if (!r || typeof r !== "object")
          throw new Error(`handler 对 model=${body?.model} 没有返回值(漏了 return?)`);
        if (r.status && r.status !== 200) {
          res.writeHead(r.status);
          return res.end(r.body || "{}");
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ choices: [{ message: { content: r.content }, finish_reason: r.finish || "stop" }], usage: r.usage })
        );
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `mock LLM 替身出错:${e.message}` } }));
      }
    });
  });
  server.unref(); // 替身不该拖住测试进程退出
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    // close 必须先掐掉连接:server.close() 只等现有连接自己结束,
    // 万一有个子进程挂住没退,after 钩子就会一直等下去,整个测试文件再也跑不完。
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  };
}

/** 在 cwd 里跑 git,返回去掉首尾空白的输出。 */
export const gitIn = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** 写文件(自动建目录)。 */
export function put(root, p, s) {
  mkdirSync(dirname(join(root, p)), { recursive: true });
  writeFileSync(join(root, p), s);
}

/** 异步跑一个 node 脚本(不阻塞本进程的事件循环,mock 接口才能响应)。 */
export function runNode(script, { cwd, env }) {
  return new Promise((resolve) =>
    execFile(process.execPath, [script], { cwd, env }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr })
    )
  );
}

/** 读假 gh 的调用日志(不存在返回空串)。 */
export const readLog = (file) => (existsSync(file) ? readFileSync(file, "utf8") : "");
