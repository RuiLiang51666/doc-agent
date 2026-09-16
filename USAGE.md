# doc-agent 操作说明

让文档随代码自动同步:研发提交代码 PR,合并后 AI 评估要不要改文档、出计划、人工
批准后写文档(中文为准、自动同步英文)、提 PR、按 review 意见自动返工。

---

## 一、日常工作流(研发视角)

```
1. 照常提代码 PR、合并到主分支
2. 若改动影响文档 → 仓库里自动出现一个「📝 docs: <描述> (#PR号)」Issue,列出要改哪些文档
   (没影响就什么都不出现;需要新页面的会标「(新建)」)
3. 看一眼计划,在该 Issue 下评论  /approve
4. 机器人提一个「文档 PR」:中文 docs/zh 更新 + 英文 docs/en 自动同步
   PR 上会自动附两条提示性评论:
     📋 文档审核 —— 拼写、坏链
     🌐 译文质检 —— 译文准确性 / 连贯性 / 翻译腔
5. 在文档 PR 上像平常一样做 code review:圈几行留几条意见,Submit review 后机器人一次全改完、
   一个提交,逐条回复 "Done in <sha>",并把这些评论线程标为 resolved
6. 还不满意就在原线程下再回一条,下次 review 提交时会重新处理;满意了合并文档 PR —— 计划 Issue 自动关闭
```

> 目前只有 `/approve` 一个指令。只有**行内**评论算意见,review 的顶层正文不作为指令。

---

## 二、目标仓库的要求

| 项 | 说明 |
|---|---|
| 文档结构 | 默认中文为准放 `docs/zh/`,英文镜像放 `docs/en/` 同路径(由机器人自动维护,**别手改**);其它布局用 `docs-source-dir` / `docs-target-dir` 配置 |
| 代码↔文档映射 | 可选:在源文档 frontmatter 写 `covers:` 列出覆盖的代码路径,命中改动的文档优先附全文;不写也行,评估时按 diff 里的标识符给文档打分预筛 |
| 两个标签 | `docs/plan`(计划 Issue)、`docs/draft`(文档 PR)——首次需手动建 |
| 模型 key | 仓库 secret `LLM_API_KEY`(GLM 等 OpenAI 兼容接口) |
| 代码/文档布局 | 代码默认在 `src/`;换布局用 action inputs(`code-paths` 等)或同名环境变量配置,见 README「配置」 |

---

## 三、两种部署形态(二选一)

### A. GitHub Actions(目标仓库放一个瘦 workflow)

把下面这个放到目标仓库 `.github/workflows/doc-agent.yml`(`OWNER` 换成 doc-agent 仓库所有者),
配好 `LLM_API_KEY` secret、建两个 label 即可。逻辑全在 `doc-agent@v1`,升级只需 bump tag。
`concurrency` 让同一 PR / Issue 的运行串行;老的 `pull_request_review_comment` 触发仍兼容,迁移说明见 README。

```yaml
name: doc-agent
on:
  pull_request: { types: [closed] }
  issue_comment: { types: [created] }
  pull_request_review: { types: [submitted] }
jobs:
  plan:
    if: github.event_name == 'pull_request' && github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    concurrency: { group: "doc-agent-${{ github.event.pull_request.number || github.event.issue.number }}", cancel-in-progress: false }
    permissions: { contents: read, issues: write, pull-requests: read }
    steps: [{ uses: OWNER/doc-agent@v1, with: { mode: plan, github-token: "${{ github.token }}", llm-api-key: "${{ secrets.LLM_API_KEY }}" } }]
  draft:
    if: github.event_name == 'issue_comment' && contains(github.event.issue.labels.*.name, 'docs/plan') && startsWith(github.event.comment.body, '/approve') && github.event.comment.user.type != 'Bot'
    runs-on: ubuntu-latest
    concurrency: { group: "doc-agent-${{ github.event.pull_request.number || github.event.issue.number }}", cancel-in-progress: false }
    permissions: { contents: write, issues: write, pull-requests: write }
    steps: [{ uses: OWNER/doc-agent@v1, with: { mode: draft, github-token: "${{ github.token }}", llm-api-key: "${{ secrets.LLM_API_KEY }}" } }]
  revise:
    if: github.event_name == 'pull_request_review' && contains(github.event.pull_request.labels.*.name, 'docs/draft') && github.event.review.user.type != 'Bot'
    runs-on: ubuntu-latest
    concurrency: { group: "doc-agent-${{ github.event.pull_request.number || github.event.issue.number }}", cancel-in-progress: false }
    permissions: { contents: write, pull-requests: write }
    steps: [{ uses: OWNER/doc-agent@v1, with: { mode: revise, ref: "${{ github.event.pull_request.head.ref }}", github-token: "${{ github.token }}", llm-api-key: "${{ secrets.LLM_API_KEY }}" } }]
```

### B. GitHub App + 后端(目标仓库零文件)

目标仓库**一个文件都不放**,装上 GitHub App 即用。注册 + 运行见 [`server/README.md`](server/README.md):
注册 App(Contents/Issues/PRs 读写 + 订阅事件)→ 装到目标仓库 → 在自己的服务器上跑后端。
后端按 PR / Issue 在进程内排队,同一个 PR 的事件串行处理。本地开发可用 smee 把公网 webhook 转发到 localhost。

---

## 四、配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `llm-model` / `LLM_MODEL` | `glm-4.6` | 核心文档生成与中英同步(重质量) |
| `llm-fast-model` / `LLM_FAST_MODEL` | `glm-4-flash` | 整篇翻译、译文质检(重速度) |
| `llm-base-url` / `LLM_BASE_URL` | 智谱地址 | 任意 OpenAI 兼容接口,可切 DeepSeek/Kimi |
| `llm-retry-max-wait-ms` / `LLM_RETRY_MAX_WAIT_MS` | `180000` | 限流 / 5xx 退避重试的累计等待上限 |
| `llm-max-tokens` / `LLM_MAX_TOKENS` | 空 | 模型单次输出上限;输出被截断时会明确失败,可调大 |
| 写作规范 | 内置 `prompts/style.md` | 目标仓库放 `.doc-agent/style.md` 即用自己的家规 |
| 路径 / 语言 / 预算 | 历史行为 | `code-paths`、`docs-source-dir`、`docs-target-dir`、`docs-glob`、`docs-exclude`、`source-lang`、`plan-token-budget`、`diff-token-budget`,详见 README「配置」 |

---

## 五、出问题时

- **评估失败**:机器人会在被合并的代码 PR 下回帖原因类别(超预算 / 模型接口报错 / 模型输出被截断 / 模型输出校验失败 / 其他异常);排查后 Re-run 该 job 即可(同一 PR 已有计划 Issue 会自动跳过,不会重复开)。
- **生成失败**:机器人会在计划 Issue 下留言报错(带原因类别);修掉后重新 `/approve`(幂等,不会重复建 PR)即可重试。
- **返工失败**:机器人在对应的 review 线程下回帖说明原因类别。该意见随即算作「已答复」,不会被后续运行反复重试——要重试,在那条线程下再回一条意见即可。
- **模型限流(429 / 智谱 1302 等)**:自动指数退避 + 随机抖动重试,累计等待到 `llm-retry-max-wait-ms` 为止;仍不行就如实失败回帖。欠费、当日额度用尽这类不重试。
- **输出被截断**:`finish_reason=length` 时按「模型输出被截断」失败,绝不把半截 JSON / 半截译文写进文档;可调大 `llm-max-tokens` 或换输出上限更大的模型后重试。
- **推送冲突**:同一文档分支被别的运行先推了,机器人会 `git pull --rebase` 后重试(最多 3 次);改到同一段落而冲突时,回滚变基并如实回帖。
- **网络瞬时抖动**:`gh` 读调用与推送会自动重试(EOF/超时等);开 Issue / PR / 评论这类写操作不重试,以免重复。
- **文档 PR 冲突**:文档 PR 还没合并时,别的改动又落地了同一篇 → 当普通冲突解决(把主分支合进文档 PR 分支)。

## 六、审核 gate 设成必过(可选)

`📋 审核` 与 `🌐 质检` 默认是**提示性**(贴评论,不阻断合并)。要硬卡,把对应的 check
加进目标仓库的 branch protection「必过项」即可。
