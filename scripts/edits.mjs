import { readFileSync, writeFileSync, mkdirSync, lstatSync } from "node:fs";
import { dirname } from "node:path";

// 路径上已经有东西(含悬空的符号链接:existsSync 对它返回 false,写入却会顺着链接落到别处)
const taken = (p) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

// 把模型给的编辑逐条字面应用到文件上。两种编辑:
// - search/replace { path, old_string, new_string }:old_string 必须在文件中存在且唯一,否则报错(不静默)——这样目标区之外
//   的字节(frontmatter、空行、行尾等)绝不可能被模型顺手改动;
// - 新建 { path, create: true, content }:调用方必须传 assertCreatable(不合规就抛,如 draft 限定在源文档目录内、禁止穿越),
//   目标已存在则报错、绝不覆盖。同一文件可以先新建、再接 search/replace。
export function applyEdits(edits, { assertCreatable } = {}) {
  const paths = new Set();
  for (const e of edits) {
    if (e.create) {
      try {
        if (!assertCreatable) throw new Error("本阶段不允许新建文件");
        assertCreatable(e.path);
        if (taken(e.path)) throw new Error("文件已存在;修改已有文件请用 old_string / new_string");
      } catch (err) {
        throw new Error(`模型输出不符合约定:新建 ${e.path} 被拒——${err.message}`);
      }
      mkdirSync(dirname(e.path), { recursive: true });
      writeFileSync(e.path, e.content.endsWith("\n") ? e.content : e.content + "\n", { flag: "wx" });
      paths.add(e.path);
      continue;
    }
    const before = readFileSync(e.path, "utf8");
    const i = before.indexOf(e.old_string);
    if (i === -1) throw new Error(`old_string 未在 ${e.path} 中找到:${e.old_string.slice(0, 80)}`);
    if (before.indexOf(e.old_string, i + 1) !== -1)
      throw new Error(`old_string 在 ${e.path} 中不唯一,需要更多上下文:${e.old_string.slice(0, 80)}`);
    writeFileSync(e.path, before.replace(e.old_string, e.new_string));
    paths.add(e.path);
  }
  return [...paths];
}
