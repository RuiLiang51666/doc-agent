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
// - search/replace { path, old_string, new_string }:old_string 必须在文件中存在且唯一,否则报错(不静默,写明出现次数)——这样目标区之外
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
    // 报错都以「模型输出不符合约定」开头(归类为「模型输出校验失败」),带上匹配次数与片段,回帖里一眼看出是哪条编辑。
    // 空 old_string 先拦下(否则下面的计数循环停不下来)
    if (!e.old_string) throw new Error(`模型输出不符合约定:对 ${e.path} 的编辑缺少 old_string`);
    const snippet = JSON.stringify(e.old_string.slice(0, 80));
    let n = 0;
    for (let i = before.indexOf(e.old_string); i !== -1; i = before.indexOf(e.old_string, i + 1)) n++;
    if (n === 0) throw new Error(`模型输出不符合约定:old_string 未在 ${e.path} 中找到:${snippet}`);
    if (n > 1)
      throw new Error(
        `模型输出不符合约定:old_string 在 ${e.path} 中出现 ${n} 次,必须唯一——带上能区分这一处的前后文:${snippet}`
      );
    writeFileSync(e.path, before.replace(e.old_string, e.new_string));
    paths.add(e.path);
  }
  return [...paths];
}
