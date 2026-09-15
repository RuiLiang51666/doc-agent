// 路径与语言配置:action.yml 的 inputs → 环境变量;server 形态直接读同名环境变量。
// 默认值 == 历史写死的行为(代码 src、中文 docs/zh、英文 docs/en、*.md),老 workflow 不改照跑。

export const DEFAULTS = {
  CODE_PATHS: "src",
  DOCS_SOURCE_DIR: "docs/zh",
  DOCS_TARGET_DIR: "docs/en",
  DOCS_GLOB: "*.md",
  DOCS_EXCLUDE: "",
  SOURCE_LANG: "zh",
  PLAN_TOKEN_BUDGET: "60000",
  DIFF_TOKEN_BUDGET: "20000",
};

const LANGS = { zh: "中文", en: "英文" };

/** 列表型配置:按换行或逗号分隔,去空白,忽略空项与 # 注释行。 */
export function parseList(v) {
  return String(v || "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
}

// 目录归一:去掉 ./ 前缀与结尾 /;"." 或空 = 仓库根目录(用空串表示)
const normDir = (d) => String(d).trim().replace(/^\.\/+/, "").replace(/\/+$/, "").replace(/^\.$/, "");

// glob → 正则。语义对齐 git pathspec 的常见用法,但只在 JS 里实现一份,便于离线测试:
// - 相对仓库根;`**` 匹配任意层目录(含零层),`*` / `?` 不跨 `/`;
// - 任何模式也按「目录前缀」匹配:`src` 命中 `src/a.ts`,`apollo-*/src/main/java` 命中其下全部文件。
export function globToRegExp(glob) {
  const g = String(glob).replace(/^\.\/+/, "").replace(/\/+$/, "");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      const atStart = i === 0 || g[i - 1] === "/";
      i++;
      if (atStart && g[i + 1] === "/") {
        re += "(?:.*/)?"; // `**/`:任意层目录前缀
        i++;
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}(?:/.*)?$`);
}

// 排除写法兼容 git:`!pat`、`:!pat`、`:(exclude)pat`
const EXCLUDE_RE = /^(?:!|:!|:\(exclude\))/;

/** 按「包含 + 排除」模式列表判断路径是否命中:命中任一包含、且不命中任一排除。 */
export function matchPaths(path, patterns) {
  const inc = [];
  const exc = [];
  for (const p of patterns) (EXCLUDE_RE.test(p) ? exc : inc).push(globToRegExp(p.replace(EXCLUDE_RE, "")));
  return inc.some((r) => r.test(path)) && !exc.some((r) => r.test(path));
}

// 文件名通配(不含 /,只比 basename),如 *.md / *.mdx
const basename = (p) => p.slice(p.lastIndexOf("/") + 1);
const underDir = (p, dir) => dir === "" || p.startsWith(dir + "/");

/** 读配置(默认读 process.env);空字符串视同未配置,回落默认值。 */
export function loadConfig(env = process.env) {
  const get = (k) => (String(env[k] ?? "").trim() ? String(env[k]) : DEFAULTS[k]);
  const sourceLang = get("SOURCE_LANG").trim();
  if (!LANGS[sourceLang]) throw new Error(`source-lang 只支持 zh / en,收到:${sourceLang}`);
  const num = (k) => {
    const n = Number(get(k));
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${k} 应为正数,收到:${get(k)}`);
    return n;
  };
  const cfg = {
    codePaths: parseList(get("CODE_PATHS")),
    sourceDir: normDir(get("DOCS_SOURCE_DIR")),
    targetDir: normDir(get("DOCS_TARGET_DIR")),
    docsGlobs: parseList(get("DOCS_GLOB")),
    docsExclude: parseList(get("DOCS_EXCLUDE")),
    sourceLang,
    targetLang: sourceLang === "zh" ? "en" : "zh",
    planTokenBudget: num("PLAN_TOKEN_BUDGET"),
    diffTokenBudget: num("DIFF_TOKEN_BUDGET"),
  };
  if (cfg.targetDir === "") throw new Error("docs-target-dir 不能是仓库根目录");
  if (cfg.targetDir === cfg.sourceDir) throw new Error("docs-source-dir 与 docs-target-dir 不能相同");
  cfg.sourceName = LANGS[cfg.sourceLang];
  cfg.targetName = LANGS[cfg.targetLang];
  return cfg;
}

/** 是否为配置的代码路径(plan 只评估这些文件的改动)。 */
export const isCodePath = (path, cfg) => matchPaths(path, cfg.codePaths);

const isDocFile = (path, cfg) => cfg.docsGlobs.some((g) => globToRegExp(g).test(basename(path)));

/**
 * 是否为源语言文档(canonical):在源目录下、不在译文目录下(KWDB 式「根目录 → en/」时靠这条排除 en/)、
 * 文件名命中 docs-glob(顺带滤掉图片)、且不命中 docs-exclude。
 */
export function isSourceDoc(path, cfg) {
  return (
    underDir(path, cfg.sourceDir) &&
    !underDir(path, cfg.targetDir) &&
    isDocFile(path, cfg) &&
    !(cfg.docsExclude.length && cfg.docsExclude.some((p) => globToRegExp(p).test(path)))
  );
}

/** 源语言文档路径 → 译文镜像路径(同相对路径)。 */
export function toTarget(path, cfg) {
  if (!underDir(path, cfg.sourceDir)) throw new Error(`${path} 不在源文档目录 ${cfg.sourceDir || "(仓库根)"} 下`);
  const rel = cfg.sourceDir === "" ? path : path.slice(cfg.sourceDir.length + 1);
  return `${cfg.targetDir}/${rel}`;
}
