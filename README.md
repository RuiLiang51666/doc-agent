# doc-agent

让文档随代码 PR 自动同步的 GitHub Action:

```
代码 PR 合并 → 评估影响、开「文档更新计划」Issue → 评论 /approve
   → 写文档初稿、提文档 PR → 在 PR 上 review 评论 → 自动按评论返工
```

工具的内脏(prompts / scripts / 逻辑)全在本仓库,**版本化**。目标仓库只需放一个瘦触发器,升级时 bump 一下 tag 即可,不用动各仓库内容。

## 接入(目标仓库三步)

1. **加触发器**:把下面的 workflow 放到目标仓库 `.github/workflows/doc-agent.yml`(把 `OWNER/doc-agent@v1` 换成本仓库)。
2. **配 key**:目标仓库加 secret `LLM_API_KEY`。
3. **建标签**:`docs/plan`、`docs/draft` 两个 label(也可让 CI 首次自动建)。

```yaml
name: doc-agent
on:
  pull_request:
    types: [closed]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

jobs:
  plan:
    if: github.event_name == 'pull_request' && github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    permissions: { contents: read, issues: write }
    steps:
      - uses: OWNER/doc-agent@v1
        with:
          mode: plan
          github-token: ${{ github.token }}
          llm-api-key: ${{ secrets.LLM_API_KEY }}

  draft:
    if: >
      github.event_name == 'issue_comment' &&
      contains(github.event.issue.labels.*.name, 'docs/plan') &&
      startsWith(github.event.comment.body, '/approve') &&
      github.event.comment.user.type != 'Bot'
    runs-on: ubuntu-latest
    permissions: { contents: write, issues: write, pull-requests: write }
    steps:
      - uses: OWNER/doc-agent@v1
        with:
          mode: draft
          github-token: ${{ github.token }}
          llm-api-key: ${{ secrets.LLM_API_KEY }}

  revise:
    if: >
      github.event_name == 'pull_request_review_comment' &&
      contains(github.event.pull_request.labels.*.name, 'docs/draft') &&
      github.event.comment.user.type != 'Bot' &&
      !startsWith(github.event.comment.body, '/')
    runs-on: ubuntu-latest
    permissions: { contents: write, pull-requests: write }
    steps:
      - uses: OWNER/doc-agent@v1
        with:
          mode: revise
          ref: ${{ github.event.pull_request.head.ref }}
          github-token: ${{ github.token }}
          llm-api-key: ${{ secrets.LLM_API_KEY }}
```

## 配置

- `llm-base-url` / `llm-model`:默认 GLM(`glm-4.6`),改 input 即可切到 DeepSeek、Kimi 等任意 OpenAI 兼容接口。

## 约定 / 现有局限

- 代码默认在 `src/`、文档在 `docs/` 与 `README.md`(`scripts/assess.mjs` 里硬编码;换布局需改这里,日后可做成配置)。
- `MERGE_SHA^1` 取净改动,对 **merge / squash** 合并成立,**rebase** 合并不成立。
