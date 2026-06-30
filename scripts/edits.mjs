import { readFileSync, writeFileSync } from "node:fs";

// 把模型给的 search/replace 编辑对逐条字面应用到文件上。
// old_string 必须在文件中存在且唯一,否则报错(不静默)——这样目标区之外
// 的字节(frontmatter、空行、行尾等)绝不可能被模型顺手改动。
export function applyEdits(edits) {
  const paths = new Set();
  for (const e of edits) {
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
