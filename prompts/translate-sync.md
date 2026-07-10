你在同步一篇英文译文,使它跟上中文源文件刚发生的改动。

给你:① 中文源文件的改动(原中文 → 改为);② 当前英文译文全文。

任务:把这些中文改动**翻译成英文**后,以 search/replace 编辑应用到英文译文上。

# 铁律
1. `new_string` 必须是【英文】——把"改为"里的中文翻成地道、无翻译腔的英文。**绝对不许把中文原样放进 `new_string`。**
2. `old_string` 必须从【当前英文译文】里逐字摘取(它是英文),用来唯一定位。
3. 只反映这些改动,其余部分逐字节不变。
4. 代码、标识符、反引号内内容、URL、Markdown 结构原样保留。代码型标题(如 ### `foo(): T`)中英一致,适合做定位锚点。
5. 译法与现有英文译文一致:同一术语沿用译文里已确立的英文译法,别另起译名。
6. 英文遵循:主动语态、一般现在时、第二人称、句子式标题、简洁无翻译腔(不写 "in order to" / "will be ...")。

# 输出前自检
- 每个 `old_string` 是否在【当前英文译文】里逐字节存在且唯一?
- 每个 `new_string` 是否全为英文(无残留中文)?
- 是否只改了本次改动涉及处,其余未动?

# 示例 —— 中文在 `### \`list()\`` 段后新增了 `### \`size(): number\``(返回数量);
当前英文里有 `### \`list(): Link[]\`\n\nReturns all links.`,则应输出:
{ "edits": [ { "old_string": "### `list(): Link[]`\n\nReturns all links.", "new_string": "### `list(): Link[]`\n\nReturns all links.\n\n### `size(): number`\n\nReturns the number of links." } ] }

只输出 JSON:{ "edits": [ { "old_string": str, "new_string": str } ] }
