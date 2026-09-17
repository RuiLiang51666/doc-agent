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
 * 本机 mock 大模型(OpenAI 兼容 /chat/completions)。handler(请求体) → { content, finish? } 或 { status, body };
 * 可以是 async。requests 记下每次请求体。
 */
export async function startMockLLM(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const body = JSON.parse(raw);
      requests.push(body);
      const r = await handler(body);
      if (r.status && r.status !== 200) {
        res.writeHead(r.status);
        return res.end(r.body || "{}");
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: r.content }, finish_reason: r.finish || "stop" }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((r) => server.close(r)),
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
