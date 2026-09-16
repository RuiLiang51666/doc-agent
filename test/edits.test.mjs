// 新建文档与路径穿越防护的离线单测:applyEdits 的 create 编辑 + config.checkNewDocPath。临时目录,零网络。
// 跑:node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
