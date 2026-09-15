import { execSync } from "node:child_process";

// 输出缓冲上限:默认 1MB 在真实仓库上不够(大 diff、带正文的 Issue 列表),超了会 ENOBUFS
const MAX_BUFFER = 256 * 1024 * 1024;

// 普通执行(写操作用这个,失败即抛——绝不重试,避免重复开 Issue/PR/评论)
export const sh = (cmd) => execSync(cmd, { encoding: "utf8", maxBuffer: MAX_BUFFER });

// 带重试的执行:只对**网络瞬时错误**重试,且只该用于**幂等**命令
// (gh 的读查询、git push 等)。退避 1s/2s,最多 3 次。
const TRANSIENT = /EOF|timeout|timed out|connection reset|handshake|temporar|GOAWAY|\b50[234]\b/i;
export function shRead(cmd, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      return execSync(cmd, { encoding: "utf8", stdio: "pipe", maxBuffer: MAX_BUFFER });
    } catch (e) {
      const msg = String(e.stderr || "") + String(e.message || "");
      if (i >= tries || !TRANSIENT.test(msg)) throw e;
      execSync(`sleep ${2 ** (i - 1)}`); // 同步退避
    }
  }
}
