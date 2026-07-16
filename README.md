# doc-agent

**让文档随代码 PR 自动演进的虚拟文档工程师** —— 一个 GitHub Action(也可作为 GitHub App 后端部署),托管「监测代码变更 → 评估文档影响 → 出计划 → 写初稿 → 中英同步 → 按 review 评论返工」的完整闭环。

```
代码 PR 合并 → 评估影响、开「文档更新计划」Issue → 评论 /approve
   → 写文档初稿、提文档 PR → 在 PR 上 review 评论 → 自动按评论返工
```

📄 [案例详解(交互演示)](https://liangrui.vercel.app/docs-agent.html) · ✍️ [作者作品集](https://liangrui.vercel.app)

## 设计要点

- **版本化内核,轻量触发**:prompts / scripts / 逻辑全在本仓库,目标仓库只放一个瘦 workflow。升级只需 bump tag(如 `@v1.1`),多仓库无缝跟进。
- **工程化流水线**:阶段间机读契约(`scripts/contract.mjs`,计划嵌入 Issue、初稿阶段回读)+ 每阶段 JSON Schema 快速失败(`scripts/llm.mjs` 的 `parseStage`);分阶段模型映射(推理用强模型、翻译用快模型);统一 `runStage()` 收口;写操作幂等、网络调用重试。
- **对标国际标准的文档质量**:写作按 Google / Microsoft 风格指南把关,按 Diátaxis 区分文档类型;译文按 **MQM 类型学**多维质检(准确 / 流畅 / 术语 / 风格 + 严重度分级)。规则全部落在 `prompts/` 里,可审阅、可版本化。
- **拒绝静默失败**:返工失败时在评论下如实回帖原因,异常链路透明可查。
- **两种部署形态,模型无关**:GitHub Actions 零基建,或 GitHub App + 后端(见 [`server/`](server/))零目标仓库文件;兼容任意 OpenAI 接口,GLM / DeepSeek / Kimi 一行配置切换。

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
- 更多输入项见 [`action.yml`](action.yml);日常工作流的研发视角说明见 [`USAGE.md`](USAGE.md)。

## 仓库结构

```
action.yml       # GitHub Action 入口(mode: plan / draft / revise)
prompts/         # 全部提示词:assess / draft / style / translate / translate-sync / translate-qa
scripts/         # 流水线:plan / draft / revise + contract(阶段契约) / llm(schema 校验、分阶段模型) / edits / checklib
config/          # cspell(拼写)/ mlc(坏链)配置
server/          # GitHub App 后端形态(webhook 驱动,复用同一套 scripts)
test/            # node --test 离线测试(契约嵌入/回读、runStage、schema 快速失败)
```

## 测试

```bash
node --test test/*.test.mjs   # 13 个用例,离线可跑(不调用 LLM)
```

覆盖阶段契约的嵌入与回读、`runStage()` 的 schema 快速失败与重试路径。

## 约定 / 现有局限

- 代码默认在 `src/`、文档在 `docs/` 与 `README.md`(`scripts/assess.mjs` 里硬编码;换布局需改这里,日后可做成配置)。
- `MERGE_SHA^1` 取净改动,对 **merge / squash** 合并成立,**rebase** 合并不成立。
- 目前只有 `/approve` 一个人工指令,评审计划即批准;更细的指令集(改范围/驳回)在路线图上。
