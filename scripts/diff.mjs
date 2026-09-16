// git 侧:列改动文件、出单文件 diff、列仓库文件;以及「这个 PR 的净改动」对应哪段提交区间(resolveDiffRange)。
// 路径过滤不在这里做(统一走 config.mjs)。
// 用 execFileSync 免 shell 转义;-z 保证中文等非 ASCII 路径不会被 git 转义成 "\346..."。
import { execFileSync } from "node:child_process";
import { isCodePath } from "./config.mjs";
import { ghGet, ghList } from "./gh.mjs";

// --literal-pathspecs:这里传的都是真实文件路径,不让 git 把路径里的 * 或 : 当成通配/魔法
const git = (args) =>
  execFileSync("git", ["--literal-pathspecs", ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024, // 大 diff 不因默认 1MB 缓冲而 ENOBUFS
    stdio: ["ignore", "pipe", "pipe"],
  });
const nul = (out) => out.split("\0").filter(Boolean);

// 区间 range = { base, head }:取 base..head 的改动,base / head 由 resolveDiffRange 按合并方式给出。
// 不能用 pull_request.base.sha 做 base——它是 PR 创建时的旧基准,会把这期间别人合进 main 的改动也算进来
// (曾导致合并文档 PR 时误报要改 src)。
export const changedFiles = (range) =>
  nul(git(["diff", "--name-only", "--no-renames", "-z", range.base, range.head]));

export const fileDiff = (range, path) =>
  git(["diff", "--no-color", "--no-ext-diff", "--no-renames", range.base, range.head, "--", path]);

export const trackedFiles = () => nul(git(["ls-files", "-z"]));

/** 配置的代码路径下的改动文件列表。 */
export const codeChangedFiles = (range, cfg) => changedFiles(range).filter((p) => isCodePath(p, cfg));

/** 逐文件取 diff:[{ path, text }]。 */
export const diffFilesFor = (range, paths) => paths.map((path) => ({ path, text: fileDiff(range, path) }));

const firstLine = (e) =>
  String((e && (e.stderr || e.message)) || e)
    .trim()
    .split("\n")[0]
    .slice(0, 200);
const shortRev = (rev) => String(rev).replace(/^([0-9a-f]{12})[0-9a-f]+/, "$1");
const HOW = {
  merge: "merge 合并",
  squash: "squash 合并",
  rebase: "rebase 合并",
  fallback: "未取到 GitHub 数据,按合并提交的第一父",
};

/** 一句话说明取 diff 的口径,如「rebase 合并:30d19853cf9c~2..30d19853cf9c」。 */
export const describeRange = (r) => `${HOW[r.how] || r.how}:${shortRev(r.base)}..${shortRev(r.head)}`;

// rebase 合并判定:沿 sha 的第一父往回数 k 个提交,与 PR 的提交列表(旧 → 新)逐个比对「提交说明 + 作者时间」。
// GitHub 的 rebase 合并把 PR 的提交逐个重放到目标分支,这两项原样保留;squash 合并只生成一个新提交,对不上。
function isRebaseMerge(sha, prCommits) {
  const k = prCommits.length;
  const chain = git(["log", "--first-parent", `-n${k}`, "--format=%aI%x1f%B%x1e", sha])
    .split("\x1e")
    .map((s) => s.replace(/^\n/, ""))
    .filter((s) => s.includes("\x1f"))
    .map((s) => {
      const [date, msg] = s.split("\x1f");
      return { date: Date.parse(date), msg: msg.trim() };
    })
    .reverse();
  return (
    chain.length === k &&
    prCommits.every(
      (c, i) =>
        chain[i].msg === String(c.commit.message).trim() && chain[i].date === Date.parse(c.commit.author.date)
    )
  );
}

/**
 * 这个 PR 合进目标分支的净改动,对应哪段提交区间:{ base, head, how }。以 GitHub 上该 PR 的数据为准:
 * - merge 合并:合并提交有两个父 → M^1..M;
 * - squash 合并,或 PR 只有一个提交:目标分支上只多了 M 这一个提交 → M^1..M;
 * - rebase 合并:PR 的 k 个提交被逐个重放到目标分支,M 是最后一个 → M~k..M(判定见 isRebaseMerge)。
 * 定下区间后,拿 GitHub 的 PR 文件列表核对本地区间的改动文件,不一致就打警告日志(不静默)。
 * 拿不到 GitHub 数据(没传仓库名 / PR 号、离线、接口报错)→ 退回 M^1..M,并在日志里写明原因与后果。
 * @param api 注入 GitHub 只读接口 { get, list }(测试用),默认走 gh
 */
export function resolveDiffRange({ sha, prNumber, repo, api = { get: ghGet, list: ghList }, log = console.log }) {
  const at = (how, base) => ({ base, head: sha, how });
  const fallback = (why) => {
    log(
      `[diff] ${why};退回 ${shortRev(sha)}^1..${shortRev(sha)}:merge / squash 合并下正确,rebase 合并下只含 PR 的最后一个提交`
    );
    return at("fallback", `${sha}^1`);
  };
  if (!repo || !prNumber) return fallback("没有仓库名或 PR 号,拿不到 GitHub 上的 PR 数据");

  const parents = git(["rev-list", "--parents", "-n", "1", sha]).trim().split(/\s+/).length - 1;
  const pr = `repos/${repo}/pulls/${prNumber}`;
  let info;
  try {
    info = api.get(pr);
  } catch (e) {
    return fallback(`读取 GitHub 上 PR #${prNumber} 失败(${firstLine(e)})`);
  }
  if (info.merge_commit_sha && info.merge_commit_sha !== sha)
    log(`[diff] 注意:GitHub 记录的合并提交是 ${shortRev(info.merge_commit_sha)},与传入的 ${shortRev(sha)} 不同,按传入的取`);

  const k = Number(info.commits) || 1;
  let range;
  if (parents >= 2) range = at("merge", `${sha}^1`);
  else if (k === 1) range = at("squash", `${sha}^1`);
  else {
    let prCommits;
    try {
      prCommits = api.list(`${pr}/commits?per_page=100`);
    } catch (e) {
      return fallback(`读取 GitHub 上 PR #${prNumber} 的提交列表失败(${firstLine(e)})`);
    }
    // 提交列表接口最多返回 250 个;不全就没法逐个比对,按 squash 取,由下面的文件列表核对兜底报警
    range =
      prCommits.length === k && isRebaseMerge(sha, prCommits) ? at("rebase", `${sha}~${k}`) : at("squash", `${sha}^1`);
  }

  try {
    const remote = new Set(
      api
        .list(`${pr}/files?per_page=100`)
        .flatMap((f) => [f.filename, f.previous_filename])
        .filter(Boolean)
    );
    const local = changedFiles(range);
    const onlyLocal = local.filter((p) => !remote.has(p));
    const onlyRemote = [...remote].filter((p) => !local.includes(p));
    if (onlyLocal.length || onlyRemote.length)
      log(
        `[diff] 警告:${describeRange(range)} 的改动文件(${local.length} 个)与 GitHub 上 PR #${prNumber} 的文件列表(${remote.size} 个)不一致;` +
          `只在本地:${onlyLocal.slice(0, 5).join(", ") || "无"};只在 GitHub:${onlyRemote.slice(0, 5).join(", ") || "无"}`
      );
    else
      log(`[diff] PR #${prNumber} 按 ${describeRange(range)} 取 diff,改动 ${local.length} 个文件,与 GitHub PR 文件列表一致`);
  } catch (e) {
    log(`[diff] PR #${prNumber} 按 ${describeRange(range)} 取 diff;未能核对 GitHub PR 文件列表(${firstLine(e)})`);
  }
  return range;
}
