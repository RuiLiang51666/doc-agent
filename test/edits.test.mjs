// 新建文档与路径穿越防护的离线单测:applyEdits 的 create 编辑 + config.checkNewDocPath。临时目录,零网络。
// 另用 Apollo 的真实文档验 search/replace 的唯一性:文件里有重复行时,光给那一行被明确拒绝,带上区分上下文才成功。
// 跑:node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEdits } from "../scripts/edits.mjs";
import { loadConfig, checkNewDocPath, assertRepoPath } from "../scripts/config.mjs";
import { classifyError } from "../scripts/errors.mjs";

const root = mkdtempSync(join(tmpdir(), "doc-agent-edits-"));
const outside = mkdtempSync(join(tmpdir(), "doc-agent-outside-"));
mkdirSync(join(root, "docs/zh"), { recursive: true });
mkdirSync(join(root, "docs/en"), { recursive: true });
writeFileSync(join(root, "docs/zh/cache.md"), "# 缓存\n\n读取。\n");
symlinkSync(outside, join(root, "docs/zh/link")); // 源文档目录里指向外面的符号链接
process.chdir(root); // applyEdits 按相对路径读写
const cfg = loadConfig({});
const guard = (p) => checkNewDocPath(p, cfg);

test("applyEdits:create 在源文档目录内新建(含新子目录),同一文件可接着 search/replace;返回改动路径", () => {
  const paths = applyEdits(
    [
      { path: "docs/zh/guide/ttl.md", create: true, content: "# 过期策略\n\n默认不过期。" },
      { path: "docs/zh/guide/ttl.md", old_string: "默认不过期。", new_string: "默认不过期,可设置 ttl。" },
      { path: "docs/zh/cache.md", old_string: "读取。", new_string: "读取指定键。" },
    ],
    { assertCreatable: guard }
  );
  assert.deepEqual(paths, ["docs/zh/guide/ttl.md", "docs/zh/cache.md"]);
  assert.equal(readFileSync("docs/zh/guide/ttl.md", "utf8"), "# 过期策略\n\n默认不过期,可设置 ttl。\n");
});

test("checkNewDocPath / applyEdits:路径穿越、绝对路径、译文目录、非文档扩展名、.git、反斜杠一律拒绝且不落盘", () => {
  const bad = [
    "../escape.md",
    "docs/zh/../../escape.md",
    "/tmp/abs.md",
    "docs/en/new.md",
    "docs/zh/a.png",
    "docs\\zh\\evil.md",
    ".git/hooks/x.md",
    "docs/zh//x.md",
  ];
  for (const p of bad) {
    assert.throws(() => guard(p), /不合规|新建文档必须/, p);
    assert.throws(
      () => applyEdits([{ path: p, create: true, content: "x" }], { assertCreatable: guard }),
      (e) => classifyError(e).label === "模型输出校验失败",
      p
    );
  }
  assert.ok(!existsSync(join(root, "..", "escape.md")));
  assert.ok(!existsSync(join(root, "docs/en/new.md")));
});

test("checkNewDocPath:经符号链接落到源文档目录之外 → 拒绝;create 不许覆盖已有文件;没传守卫的阶段不许新建", () => {
  assert.throws(() => guard("docs/zh/link/evil.md"), /符号链接/);
  assert.ok(!existsSync(join(outside, "evil.md")));
  assert.throws(
    () => applyEdits([{ path: "docs/zh/cache.md", create: true, content: "覆盖" }], { assertCreatable: guard }),
    /已存在/
  );
  assert.match(readFileSync("docs/zh/cache.md", "utf8"), /读取指定键/); // 没被覆盖
  assert.throws(() => applyEdits([{ path: "docs/zh/new.md", create: true, content: "x" }]), /不允许新建/);
  assert.equal(assertRepoPath("docs/zh/a.md"), "docs/zh/a.md");
});

// ── 真实夹具:apolloconfig/apollo 的 docs/zh/deployment/quick-start.md(fork 的 replay-base 分支,blob e332d68c,原样复制)。
//    里面有 6 行一模一样的 export SPRING_PROFILES_ACTIVE=... 和 4 个 #### 注意事项,正是回放 #5649 时 draft 要插入内容的位置 ──
const QS = "docs/zh/deployment/quick-start.md";
const QS_TEXT = readFileSync(fileURLToPath(new URL("./fixtures/apollo-quick-start.zh.md", import.meta.url)), "utf8");
const PROFILE = 'export SPRING_PROFILES_ACTIVE="github,database-discovery,auth"';
const H2 = "export SPRING_H2_CONSOLE_ENABLED=false";
const count = (s, sub) => s.split(sub).length - 1;

test("applyEdits(Apollo quick-start):只写重复出现的那一行 → 明确拒绝(写明出现次数与片段、归类「模型输出校验失败」),文件不动", () => {
  mkdirSync("docs/zh/deployment", { recursive: true });
  writeFileSync(QS, QS_TEXT);
  assert.equal(count(QS_TEXT, PROFILE), 6);

  const cases = [
    [PROFILE, `${PROFILE}\n${H2}`, 6],
    ["#### 注意事项", "#### 注意事项\n1. 请勿将端口暴露到公网。", 4],
  ];
  for (const [old_string, new_string, n] of cases) {
    assert.throws(
      () => applyEdits([{ path: QS, old_string, new_string }]),
      (e) => {
        assert.ok(e.message.includes(`old_string 在 ${QS} 中出现 ${n} 次,必须唯一`), e.message);
        assert.ok(e.message.includes(JSON.stringify(old_string)), e.message); // 带上片段
        assert.equal(classifyError(e).label, "模型输出校验失败");
        return true;
      }
    );
  }
  assert.throws(() => applyEdits([{ path: QS, old_string: "", new_string: "x" }]), /缺少 old_string/);
  assert.equal(readFileSync(QS, "utf8"), QS_TEXT);
});

test("applyEdits(Apollo quick-start):6 处各带能唯一定位的前文 → 全部成功,每行 export 后紧跟新增行,其余字节不变", () => {
  writeFileSync(QS, QS_TEXT);
  // 每条的区分上下文:紧挨着的独有说明行或标题(2.2.2 / 2.3.2 的说明行本身重复两次,得再往上带上小标题)
  const anchors = [
    "> 注：使用内存数据库时，任何操作都会在 apollo 进程重启后丢失\n```bash\n",
    '首次启动使用 SPRING_SQL_CONFIG_INIT_MODE="always" 和 SPRING_SQL_PORTAL_INIT_MODE="always" 环境变量来进行初始化\n```bash\n',
    "### 2.2.2 后续启动\n后续启动去掉 SPRING_SQL_CONFIG_INIT_MODE 和 SPRING_SQL_PORTAL_INIT_MODE 环境变量来避免重复初始化\n```bash\n",
    '首次启动使用 SPRING_SQL_INIT_MODE="always" 环境变量来进行初始化\n```bash\n',
    "### 2.3.2 后续启动\n后续启动去掉 SPRING_SQL_CONFIG_INIT_MODE 和 SPRING_SQL_PORTAL_INIT_MODE 环境变量来避免重复初始化\n```bash\n",
    '"apollo-username" 和 "apollo-password" 需要填写实际的用户名和密码\n\n```bash\n',
  ];
  const edits = anchors.map((a) => ({ path: QS, old_string: a + PROFILE, new_string: `${a}${PROFILE}\n${H2}` }));
  assert.deepEqual(applyEdits(edits), [QS]);

  const after = readFileSync(QS, "utf8");
  assert.equal(count(after, `${PROFILE}\n${H2}\n`), 6);
  assert.equal(count(after, H2), 6);
  assert.equal(after.replaceAll(`\n${H2}`, ""), QS_TEXT); // 去掉新增行就与原文逐字节相同
});
