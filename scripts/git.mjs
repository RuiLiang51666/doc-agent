// git 写操作:显式 add 本次生成 / 修改的路径再提交;推送被远端拒绝时先变基再重试。
// 不用 `git commit -a`:它不暂存未跟踪的新文件,新建的文档和新生成的译文会被静默丢掉。
// 用 execFileSync 免 shell 转义(路径里可能有中文、空格)。
import { execFileSync } from "node:child_process";
import { PushError } from "./errors.mjs";

const runGit = (args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
const output = (e) => `${e.stderr || ""}${e.stdout || ""}${e.message || ""}`;
const lastLine = (s) => String(s).trim().split("\n").filter(Boolean).pop() || "";
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export const PUSH_ATTEMPTS = 3; // 推送最多尝试次数(含第一次)
// 远端有本地没有的提交(别的运行先推了)。不含 "failed to push some refs":分支保护、鉴权失败也会打这句
const REJECTED = /\[rejected\]|non-fast-forward|fetch first|Updates were rejected because/i;
// 网络瞬时错误(与 sh.mjs 同口径)
const TRANSIENT = /EOF|timeout|timed out|connection reset|handshake|temporar|GOAWAY|\b50[234]\b/i;

/** 只暂存给定路径并提交(message 为数组时,第一项是标题,其余各成一段)。没有改动可提交时报错,不静默。返回短 sha。 */
export function commitPaths(paths, message, { git = runGit } = {}) {
  const files = [...new Set(paths.filter(Boolean))];
  if (!files.length) throw new Error("没有可提交的文件");
  git(["add", "--", ...files]);
  let staged = false;
  try {
    git(["diff", "--cached", "--quiet"]);
  } catch {
    staged = true; // 暂存区与 HEAD 有差异时 --quiet 以退出码 1 结束
  }
  if (!staged) throw new Error(`没有可提交的改动:${files.join(", ")} 与 HEAD 相同`);
  const [subject, ...paras] = [].concat(message);
  git(["commit", "-q", "-m", subject, ...paras.flatMap((p) => ["-m", p])]);
  return git(["rev-parse", "--short", "HEAD"]).trim();
}

/** 当前分支名;detached HEAD 时报错(没有分支就无从推送、无从变基)。 */
export function currentBranch({ git = runGit } = {}) {
  const b = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (!b || b === "HEAD") throw new Error("当前不在任何分支上(detached HEAD),无法推送");
  return b;
}

/**
 * 推送 HEAD 到 origin/<branch>:
 * - 被拒(远端有别的运行先推的提交)→ `git pull --rebase` 把本地提交接到远端最新提交之后,再推;
 * - 网络瞬时错误 → 退避 1s / 2s 后再推;
 * - 最多尝试 attempts 次,仍失败抛 PushError。变基冲突不再重试(再试也一样):先 `rebase --abort` 还原,再抛。
 * @returns 实际尝试次数
 */
export function pushWithRebase(branch, { attempts = PUSH_ATTEMPTS, git = runGit, log = console.log, sleep = sleepSync } = {}) {
  for (let i = 1; ; i++) {
    let msg;
    try {
      git(["push", "-u", "origin", `HEAD:refs/heads/${branch}`]);
      return i;
    } catch (e) {
      msg = output(e);
    }
    const rejected = REJECTED.test(msg);
    if (!rejected && !TRANSIENT.test(msg)) throw new PushError(`推送 ${branch} 失败:${lastLine(msg)}`);
    if (i >= attempts)
      throw new PushError(
        `推送 ${branch} 失败:${rejected ? "远端分支已被其他运行更新" : "网络异常"},已尝试 ${attempts} 次仍未成功(最后一次:${lastLine(msg)})`
      );
    if (!rejected) {
      sleep(2 ** (i - 1) * 1000);
      continue;
    }
    log(`[git] 推送 ${branch} 被拒(远端有新提交),拉取变基后重试(第 ${i + 1}/${attempts} 次)`);
    try {
      git(["pull", "--rebase", "origin", branch]);
    } catch (e) {
      const out = output(e);
      try {
        git(["rebase", "--abort"]);
      } catch {} // 拉取本身失败时没有进行中的变基,abort 报错可忽略
      if (TRANSIENT.test(out) && i + 1 < attempts) {
        sleep(2 ** (i - 1) * 1000);
        continue;
      }
      throw new PushError(
        `推送 ${branch} 被拒,拉取远端最新提交变基时失败(多半是同一处已被其他运行改过),本次改动未推送:${lastLine(out)}`
      );
    }
  }
}
