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
- **面向真实仓库布局**:代码路径、文档目录、中英路径规则、源语言都可配置;plan 阶段按 diff 里的标识符给文档打分预筛,在 token 预算内放全文、其余给索引。预筛是确定性的,离线可测,不额外调模型。
- **对标国际标准的文档质量**:写作按 Google / Microsoft 风格指南把关,按 Diátaxis 区分文档类型;译文按 **MQM 类型学**多维质检(准确 / 流畅 / 术语 / 风格 + 严重度分级)。规则全部落在 `prompts/` 里,可审阅、可版本化。
- **拒绝静默失败**:评估失败时在被合并的代码 PR 下回帖原因类别;写初稿、返工失败时在计划 Issue 或评论下如实回帖;配置的代码路径没有改动时,也会在日志和 Step Summary 里写明跳过。
- **两种部署形态,模型无关**:GitHub Actions 零基建,或 GitHub App + 后端(见 [`server/`](server/))零目标仓库文件;兼容任意 OpenAI 接口,GLM / DeepSeek / Kimi 一行配置切换。

## 接入(目标仓库三步)

1. **加触发器**:把下面的 workflow 放到目标仓库 `.github/workflows/doc-agent.yml`(把 `OWNER/doc-agent@v1` 换成本仓库)。代码不在 `src/`、文档不是 `docs/zh` + `docs/en` 的仓库,在 `with:` 里加路径配置,见下文「配置」与两份示例。
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

### 模型

- `llm-base-url` / `llm-model`:默认 GLM(`glm-4.6`),改 input 即可切到 DeepSeek、Kimi 等任意 OpenAI 兼容接口。
- `llm-fast-model`:翻译与译文质检用的快模型,默认 `glm-4-flash`。
- 全部输入项见 [`action.yml`](action.yml);日常工作流的研发视角说明见 [`USAGE.md`](USAGE.md)。

### 路径、语言与预算

下表输入项的默认值都等于历史行为(代码 `src/`、中文 `docs/zh/`、英文 `docs/en/`、`*.md`),老仓库的 workflow 不改也照跑。GitHub App 后端形态读同名环境变量。

| 输入项 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `code-paths` | `CODE_PATHS` | `src` | 代码路径 glob,换行或逗号分隔。`**` 跨目录,`*` 不跨目录;任何模式都按目录前缀匹配;`!` 或 `:!` 开头为排除。只有命中的文件改动才触发评估 |
| `docs-source-dir` | `DOCS_SOURCE_DIR` | `docs/zh` | 源语言(canonical)文档目录;仓库根目录写 `.` |
| `docs-target-dir` | `DOCS_TARGET_DIR` | `docs/en` | 译文镜像目录,与源文档同相对路径。位于源目录之内时(如根目录 → `en/`)自动从源文档中排除 |
| `docs-glob` | `DOCS_GLOB` | `*.md` | 文档文件名通配,顺带滤掉图片;拼写与坏链检查也按它取文件 |
| `docs-exclude` | `DOCS_EXCLUDE` | 空 | 从源文档中排除的路径 glob(相对仓库根),如 `README.md, .github/**` |
| `source-lang` | `SOURCE_LANG` | `zh` | 源语言,`zh` 或 `en`。译文同步目前只支持中文 → 英文,设为 `en` 时同步步骤会明确报错 |
| `plan-token-budget` | `PLAN_TOKEN_BUDGET` | `60000` | plan 输入(提示词 + diff + 文档索引 + 文档全文)的估算 token 上限 |
| `diff-token-budget` | `DIFF_TOKEN_BUDGET` | `20000` | 代码 diff 的估算 token 上限,plan 与 draft 共用;超出时按文件截断,并在截断处标注「已截断」 |

token 按「ASCII 4 字符/token、中文 1 字/token」估算,偏保守,误差约 ±30%。默认的 60000 给 128K 上下文的模型留足了余量。

### plan 阶段怎么挑文档

1. 取配置的代码路径下的改动,逐文件拿 diff。超出 `diff-token-budget` 时按文件截断:小文件保全,大文件在截断处标注。
2. 从 diff 抽标识符:配置键、类名 / 文件名、方法名、环境变量、字符串常量,以及从中拆出的单词。
3. 给每篇源文档打分:权重 × IDF × 命中次数,并做 BM25 式长度归一化。frontmatter `covers:` 覆盖了改动文件的文档直接排到最前。
4. 全部文档的「路径 + 标题」索引固定放进 prompt,余下预算按得分从高到低放全文。连固定部分都放不下时失败,并在 PR 下回帖「超预算」。

在本地预演这一步(不调模型、不访问 GitHub):

```bash
cd <目标仓库>
CODE_PATHS='apollo-*/src/**' node <doc-agent 路径>/scripts/plan-dryrun.mjs <merge_sha> <PR 号> "<PR 标题>"
```

### 示例一:Apollo(代码 PR → 文档)

[apolloconfig/apollo](https://github.com/apolloconfig/apollo) 是多模块 Java 项目,代码在 `apollo-*/src/main/**`,中文文档在 `docs/zh/**`,英文在 `docs/en/**` 同路径。文档目录恰好是默认值,只需配置代码路径;plan 与 draft 都要用它取 diff。

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
    steps:
      - uses: OWNER/doc-agent@v1
        with:
          mode: plan
          github-token: ${{ github.token }}
          llm-api-key: ${{ secrets.LLM_API_KEY }}
          code-paths: |
            apollo-*/src/**
            scripts/**
            :!**/src/test/**

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
          code-paths: |
            apollo-*/src/**
            scripts/**
            :!**/src/test/**

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

### 示例二:KWDB 文档(中英同步 + 译文质检)

KWDB 用户文档仓库只有文档:中文在仓库根目录的各个子目录里,英文在 `en/` 下同相对路径镜像。仓库里没有代码,所以不挂 plan。中文改动走文档 PR(打 `docs/draft` 标签),在中文行上留 review 意见,就会触发返工,随后做英文增量同步和译文质检。

```yaml
name: doc-agent
on:
  pull_request_review_comment: { types: [created] }

jobs:
  revise:
    if: >
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
          docs-source-dir: .
          docs-target-dir: en
          # 根目录下不属于用户文档的 md,按仓库实际情况增删
          docs-exclude: |
            README.md
            CONTRIBUTING.md
            style-guide.md
            .github/**
```

仓库自带的写作规范可以复制为 `.doc-agent/style.md`,它会替换内置规范。

## 仓库结构

```
action.yml       # GitHub Action 入口(mode: plan / draft / revise)
prompts/         # 全部提示词:assess / draft / style / translate / translate-sync / translate-qa
scripts/         # 流水线:plan / draft / revise
                 #   config(路径配置)· diff(取 diff)· prefilter + budget(文档预筛与 token 预算)· planlib(plan 护栏)
                 #   contract(阶段契约)· llm(schema 校验、分阶段模型)· edits · checklib · plan-dryrun(本地干跑)
config/          # cspell(拼写)/ mlc(坏链)配置
server/          # GitHub App 后端形态(webhook 驱动,复用同一套 scripts)
test/            # node --test 离线测试
```

## 测试

```bash
node --test test/*.test.mjs   # 38 个用例,离线可跑(不调用 LLM)
```

覆盖范围:
- 阶段契约的嵌入与回读、`runStage()` 的 schema 快速失败;
- 路径配置:默认值、Apollo 布局、KWDB 文档布局;
- diff 截断与 token 预算、文档预筛打分与 prompt 组装;
- plan 端到端(临时 git 仓库 + 假 `gh` + 本机 mock 接口):无代码改动时写 Step Summary、已有计划 Issue 时跳过、各类异常回帖并以失败退出。

## 约定 / 现有局限

- 代码路径、文档目录、中英路径规则、源语言和 token 预算都是输入项(见「配置」),默认值即历史行为。支持「`docs/zh` ↔ `docs/en`」式与「根目录 ↔ `en/`」式两种布局;同目录后缀成对的布局(`foo.zh-CN.md` / `foo.en-US.md`)暂不支持。
- 译文同步只支持中文 → 英文(内置翻译提示词只有这个方向)。`source-lang: en` 时,评估与写初稿可用,同步步骤会明确报错。
- 文档预筛是基于标识符的词法打分,不理解语义:改动只体现在行为上、文档里又没有对应标识符时,相关文档可能只进索引、不附全文。全部文档都在索引里,模型仍可以把它列进计划。token 数是估算值。
- `MERGE_SHA^1` 取净改动,对 **merge / squash** 合并成立,**rebase** 合并不成立。
- plan 在调模型前后各查一次重,但同一 PR 的两次运行如果真正并发,仍可能各开一个 Issue;revise 也没有并发互斥。
- draft 只能改已有文档,计划里出现尚不存在的文档会失败;大文档仍整篇放进 draft 与翻译的 prompt。
- 质检扫描的是全仓符合 `docs-glob` 的文件,不是只查本次改动。
- 还没有「文档 PR 合并即触发中英同步」的入口;KWDB 这类纯文档仓库目前经 review 返工触发同步。
- GitHub App 后端形态的配置对它服务的所有仓库生效。
- 目前只有 `/approve` 一个人工指令,评审计划即批准;更细的指令集(改范围/驳回)在路线图上。
