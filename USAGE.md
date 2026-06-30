# doc-agent 操作说明

让文档随代码自动同步:研发提交代码 PR,合并后 AI 评估要不要改文档、出计划、人工
批准后写文档(中文为准、自动同步英文)、提 PR、按 review 评论自动返工。

---

## 一、日常工作流(研发视角)

```
1. 照常提代码 PR、合并到主分支
2. 若改动影响文档 → 仓库里自动出现一个「📝 docs: <描述> (#PR号)」Issue,列出要改哪些文档
   (没影响就什么都不出现)
3. 看一眼计划,在该 Issue 下评论  /approve
4. 机器人提一个「文档 PR」:中文 docs/zh 更新 + 英文 docs/en 自动同步
   PR 上会自动附两条提示性评论:
     📋 文档审核 —— 拼写、坏链
     🌐 译文质检 —— 译文准确性 / 连贯性 / 翻译腔
5. 在文档 PR 上像平常一样做 code review:对某行留评论,机器人会自动改、回复 "Done in <sha>"、
   并把该评论线程标为 resolved
6. 满意了就合并文档 PR —— 对应的计划 Issue 自动关闭
```

> 目前只有 `/approve` 一个指令。

---

## 二、目标仓库的要求

| 项 | 说明 |
|---|---|
| 文档结构 | 中文为准放 `docs/zh/`,英文镜像放 `docs/en/`(由机器人自动维护,**别手改**) |
| 代码↔文档映射 | 在 `docs/zh/*.md` 的 frontmatter 写 `covers:`,列出它覆盖的代码路径(评估时按改动路径反查) |
| 两个标签 | `docs/plan`(计划 Issue)、`docs/draft`(文档 PR)——首次需手动建 |
| 模型 key | 仓库 secret `LLM_API_KEY`(GLM 等 OpenAI 兼容接口) |
| 代码/文档布局 | 代码默认在 `src/`,文档在 `docs/`(`scripts/plan.mjs` 里硬编码,换布局改那里) |

---

## 三、两种部署形态(二选一)

### A. GitHub Actions(目标仓库放一个瘦 workflow)

把下面这个放到目标仓库 `.github/workflows/doc-agent.yml`(`OWNER` 换成 doc-agent 仓库所有者),
配好 `LLM_API_KEY` secret、建两个 label 即可。逻辑全在 `doc-agent@v1`,升级只需 bump tag。

```yaml
name: doc-agent
on:
  pull_request: { types: [closed] }
  issue_comment: { types: [created] }
  pull_request_review_comment: { types: [created] }
jobs:
  plan:
    if: github.event_name == 'pull_request' && github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    permissions: { contents: read, issues: write }
    steps: [{ uses: OWNER/doc-agent@v1, with: { mode: plan, github-token: "${{ github.token }}", llm-api-key: "${{ secrets.LLM_API_KEY }}" } }]
  draft:
    if: github.event_name == 'issue_comment' && contains(github.event.issue.labels.*.name, 'docs/plan') && startsWith(github.event.comment.body, '/approve') && github.event.comment.user.type != 'Bot'
    runs-on: ubuntu-latest
    permissions: { contents: write, issues: write, pull-requests: write }
    steps: [{ uses: OWNER/doc-agent@v1, with: { mode: draft, github-token: "${{ github.token }}", llm-api-key: "${{ secrets.LLM_API_KEY }}" } }]
  revise:
    if: github.event_name == 'pull_request_review_comment' && contains(github.event.pull_request.labels.*.name, 'docs/draft') && github.event.comment.user.type != 'Bot' && !startsWith(github.event.comment.body, '/')
    runs-on: ubuntu-latest
    permissions: { contents: write, pull-requests: write }
    steps: [{ uses: OWNER/doc-agent@v1, with: { mode: revise, ref: "${{ github.event.pull_request.head.ref }}", github-token: "${{ github.token }}", llm-api-key: "${{ secrets.LLM_API_KEY }}" } }]
```

### B. GitHub App + 后端(目标仓库零文件)

目标仓库**一个文件都不放**,装上 GitHub App 即用。注册 + 运行见 [`server/README.md`](server/README.md):
注册 App(Contents/Issues/PRs 读写 + 订阅三事件)→ 装到目标仓库 → 在自己的服务器上跑后端。
本地开发可用 smee 把公网 webhook 转发到 localhost。

---

## 四、配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `llm-model` / `LLM_MODEL` | `glm-4.6` | 核心文档生成与中英同步(重质量) |
| `llm-fast-model` / `LLM_FAST_MODEL` | `glm-4-flash` | 整篇翻译、译文质检(重速度) |
| `llm-base-url` / `LLM_BASE_URL` | 智谱地址 | 任意 OpenAI 兼容接口,可切 DeepSeek/Kimi |
| 写作规范 | 内置 `prompts/style.md` | 目标仓库放 `.doc-agent/style.md` 即用自己的家规 |

---

## 五、出问题时

- **生成失败**:机器人会在计划 Issue 或那条 review 评论下留言报错;修掉后重新 `/approve`(幂等,不会重复建 PR)即可重试。
- **网络瞬时抖动**:`gh` 读调用与 `git push` 会自动重试(EOF/超时等);写操作不重试以免重复。
- **文档 PR 冲突**:文档 PR 还没合并时,别的改动又落地了同一篇 → 当普通冲突解决(把主分支合进文档 PR 分支)。

## 六、审核 gate 设成必过(可选)

`📋 审核` 与 `🌐 质检` 默认是**提示性**(贴评论,不阻断合并)。要硬卡,把对应的 check
加进目标仓库的 branch protection「必过项」即可。
