(生成或修改文档时遵守的技术写作规范。中文为写作基准(docs/zh),英文由翻译环节承接。
依据 Google 开发者文档风格指南、Microsoft 写作风格指南、Diátaxis。)

# 通用原则(中英都适用)
1. 主动语态、面向读者的第二人称(you / 调用方),避免 "we"。
2. 一句话只说一件事;条件前置于指令 —— "要启用 X,设置 Y" / "To enable X, set Y",不写 "设置 Y 可以启用 X"。
3. 同一概念全程同一术语;缩写或专有名词首次出现即给全称或一句解释。
4. 并列结构:列表项、参数说明用同样句式开头(要么都动词,要么都名词)。
5. 描述 API:先一句话说它做什么,再说参数、返回值、错误 / 边界。
6. 不臆造:只写代码确实支持的行为,不确定就不写;不预告未发布特性,不抄第三方文字。

# 中文特有(写 docs/zh 时)
7. 删冗余:去掉「进行了 / 的的不休 / 一个 / 我们可以看到 / 值得注意的是」这类虚词。
8. 操作步骤用祈使句,一步一动作:「运行 `kwbase init` 初始化。」
9. 中英文、中文与数字之间加半角空格:「KaiwuDB 3.1 版本」「返回 `Session` 对象」。
10. 用全角标点(,。;:「」),代码 / 标识符 / 路径仍用半角反引号包裹。

# 英文特有(翻译 / 校对时)
11. 一般现在时:写 "Returns the URL",不写 "The URL will be returned"。
12. 标题句子式大小写(Sentence case),不用 Title Case。
13. 列举用串行逗号(a, b, and c);冠词、单复数符合英语习惯。
14. 词表 —— 该用 / 别用:
    - use(别用 utilize / leverage)、to(别用 in order to)、lets you(别用 allows you to)
    - can(别用 is able to)、because(别用 due to the fact that)、with / by(别用 via)
    - 删掉 simply / just / easily / obviously / please(指令中)/ note that

# 结构 · 格式(中英都适用)
15. 有序列表 = 顺序步骤,无序列表 = 无先后项,描述列表 = 「名称—说明」成对数据。
16. 代码 / 标识符 / 字段名 / 路径用反引号;UI 元素(按钮、菜单名)用粗体。
17. 链接文字要有描述性(写「见认证指南」/ "see the authentication guide",不写「点击这里」/ "click here")。
18. 图片配替代文字(alt);数字与单位之间留空格(如 `10 ms`、`512 MB`)。
19. 注意事项统一样式:全篇用同一种(如 `> **注意:**` / `> **Note:**`),不要「注意 / Note / ⚠️」混用。
20. 交叉引用指向具体小节标题,不写「见上文 / 见下文」。产品名、功能名大小写全篇一致。

# 按文档类型调整语气(Diátaxis)
21. 参考型(reference):冷静、完备、无解释的事实。
22. 操作型(how-to):面向已会的用户解决具体问题,祈使句步骤,含必要的前置与结果。
23. 说明型(explanation):可展开背景与权衡;教程型(tutorial):手把手、保证读者跑通。

# 示例(改前 → 改后)
- 中文冗余:❌「我们可以通过调用该方法来进行数据的删除操作。」→ ✅「调用该方法删除数据。」
- 英文时态 / 冗余:❌ "After the connection is successful, it will return a `Session` object." → ✅ "On success, returns a `Session` object."
- 描述性链接:❌「详情请点击这里。」→ ✅「详见 [认证指南](auth.md)。」
