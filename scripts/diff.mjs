// git 侧:列改动文件、出单文件 diff、列仓库文件。路径过滤不在这里做(统一走 config.mjs)。
// 用 execFileSync 免 shell 转义;-z 保证中文等非 ASCII 路径不会被 git 转义成 "\346..."。
import { execFileSync } from "node:child_process";
import { isCodePath } from "./config.mjs";

// --literal-pathspecs:这里传的都是真实文件路径,不让 git 把路径里的 * 或 : 当成通配/魔法
const git = (args) =>
  execFileSync("git", ["--literal-pathspecs", ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024, // 大 diff 不因默认 1MB 缓冲而 ENOBUFS
    stdio: ["ignore", "pipe", "pipe"],
  });
const nul = (out) => out.split("\0").filter(Boolean);

// 用合并提交的第一父(sha^1)做基准,得到的正是「这个 PR 的净改动」。
// 不能用 pull_request.base.sha——它是 PR 创建时的旧基准,会把这期间别人合进
// main 的改动也算进来(曾导致合并文档 PR 时误报要改 src)。rebase 合并下不成立,见 README 局限。
export const changedFiles = (sha) => nul(git(["diff", "--name-only", "--no-renames", "-z", `${sha}^1`, sha]));

export const fileDiff = (sha, path) =>
  git(["diff", "--no-color", "--no-ext-diff", "--no-renames", `${sha}^1`, sha, "--", path]);

export const trackedFiles = () => nul(git(["ls-files", "-z"]));

/** 配置的代码路径下的改动文件列表。 */
export const codeChangedFiles = (sha, cfg) => changedFiles(sha).filter((p) => isCodePath(p, cfg));

/** 逐文件取 diff:[{ path, text }]。 */
export const diffFilesFor = (sha, paths) => paths.map((path) => ({ path, text: fileDiff(sha, path) }));
