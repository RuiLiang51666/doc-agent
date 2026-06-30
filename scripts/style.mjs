import { readFileSync, existsSync } from "node:fs";

// 加载技术写作规范:目标仓库放了 .doc-agent/style.md 就用它(家规覆盖),
// 否则用工具内置的默认规范。
export function loadStyle() {
  const local = ".doc-agent/style.md";
  return existsSync(local)
    ? readFileSync(local, "utf8")
    : readFileSync(new URL("../prompts/style.md", import.meta.url), "utf8");
}
