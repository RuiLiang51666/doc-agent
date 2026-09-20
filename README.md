# doc-agent

**让文档随代码 PR 自动演进的虚拟文档工程师** —— 一个 GitHub Action(也可作为 GitHub App 后端部署),托管「监测代码变更 → 评估文档影响 → 出计划 → 写初稿 → 中英同步 → 按 review 评论返工」的完整闭环。

```
代码 PR 合并 → 评估影响、开「文档更新计划」Issue → 评论 /approve
   → 写文档初稿、提文档 PR → 提交 review → 自动按整批评论返工
```

📄 [案例详解(交互演示)](https://liangrui.vercel.app/docs-agent.html) · ✍️ [作者作品集](https://liangrui.vercel.app)

## 设计要点

- **版本化内核,轻量触发**:prompts / scripts / 逻辑全在本仓库,目标仓库只放一个瘦 workflow。升级只需 bump tag(如 `@v1.1`),多仓库无缝跟进。
- **工程化流水线**:阶段间机读契约(`scripts/contract.mjs`,计划嵌入 Issue、初稿阶段回读)+ 每阶段 JSON Schema 快速失败(`scripts/llm.mjs` 的 `parseStage`);分阶段模型映射(推理用强模型、翻译用快模型);统一 `runStage()` 收口;写操作幂等。
- **面向真实仓库布局**:代码路径、文档目录、中英路径规则、源语言都可配置;plan 阶段按 diff 里的标识符给文档打分预筛,在 token 预算内放全文、其余给索引。预筛是确定性的,离线可测,不额外调模型。取 diff 以 GitHub 上该 PR 的提交为准,merge / squash / rebase 三种合并方式都正确。
- **经得起并发与限流**:同一 PR / Issue 的运行串行(workflow 并发组 / 后端进程内队列);一次 review 的多条意见在一次运行里处理、形成一个提交;推送被别的运行抢先就变基重试;模型限流按指数退避 + 随机抖动重试,总等待有上限。
- **对标国际标准的文档质量**:写作按 Google / Microsoft 风格指南把关,按 Diátaxis 区分文档类型;译文按 **MQM 类型学**多维质检(准确 / 流畅 / 术语 / 风格 + 严重度分级)。规则全部落在 `prompts/` 里,可审阅、可版本化。
- **拒绝静默失败**:失败一律归类回帖(超预算 / 模型接口报错 / 模型输出被截断 / 模型输出校验失败 / 推送失败 / 其他异常)——评估失败回到被合并的代码 PR,写初稿失败回到计划 Issue,返工失败回到对应 review 线程;回帖本身被拒(如 403 权限不足)时,日志和 Step Summary 写明原因类别与该检查哪项权限;配置的代码路径没有改动时,也会在日志和 Step Summary 里写明跳过。模型输出被长度截断时绝不把半截 JSON 或半截译文当成功结果。**提示性步骤(文档审核、译文质检)与译文增量同步转兜底也一样**:失败必须看得见——日志、Step Summary、必要时 PR 回帖写明原因类别,运行结论可以仍判成功,但不许一声不响。
- **两种部署形态,模型无关**:GitHub Actions 零基建,或 GitHub App + 后端(见 [`server/`](server/))零目标仓库文件;兼容任意 OpenAI 接口,GLM / DeepSeek / Kimi 一行配置切换。

## 接入(目标仓库三步)

1. **加触发器**:把下面的 workflow 放到目标仓库 `.github/workflows/doc-agent.yml`(把 `OWNER/doc-agent@v1.2.3` 换成本仓库)。代码不在 `src/`、文档不是 `docs/zh` + `docs/en` 的仓库,在 `with:` 里加路径配置,见下文「配置」与两份示例。
2. **配 key**:目标仓库加 secret `LLM_API_KEY`。
3. **建标签**:`docs/plan`、`docs/draft` 两个 label(也可让 CI 首次自动建)。

```yaml
name: doc-agent
on:
  pull_request:
    types: [closed]
  issue_comment:
    types: [created]
  pull_request_review:
    types: [submitted]

jobs:
  plan:
    if: github.event_name == 'pull_request' && github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    # 同一 PR / Issue 的运行串行,互不踩踏;cancel-in-progress: false 不打断正在跑的那次
    concurrency:
      group: doc-agent-${{ github.event.pull_request.number || github.event.issue.number }}
      cancel-in-progress: false
    # pull-requests: write 两用:读 PR 的提交与文件列表(取 diff),失败时在被合并的代码 PR 下回帖(read 会 403)
    permissions: { contents: read, issues: write, pull-requests: write }
    steps:
      - uses: OWNER/doc-agent@v1.2.3
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
    concurrency:
      group: doc-agent-${{ github.event.pull_request.number || github.event.issue.number }}
      cancel-in-progress: false
    permissions: { contents: write, issues: write, pull-requests: write }
    steps:
      - uses: OWNER/doc-agent@v1.2.3
        with:
          mode: draft
          github-token: ${{ github.token }}
          llm-api-key: ${{ secrets.LLM_API_KEY }}

  revise:
    if: >
      github.event_name == 'pull_request_review' &&
      contains(github.event.pull_request.labels.*.name, 'docs/draft') &&
      github.event.review.user.type != 'Bot'
    runs-on: ubuntu-latest
    concurrency:
      group: doc-agent-${{ github.event.pull_request.number || github.event.issue.number }}
      cancel-in-progress: false
    permissions: { contents: write, pull-requests: write }
    steps:
      - uses: OWNER/doc-agent@v1.2.3
        with:
          mode: revise
          ref: ${{ github.event.pull_request.head.ref }}
          github-token: ${{ github.token }}
          llm-api-key: ${{ secrets.LLM_API_KEY }}
```

### 返工怎么触发:一次 review 一次运行

`pull_request_review: [submitted]` 在审阅者**提交整个 review** 时触发一次。revise 会处理该 PR 上**全部还没被 doc-agent 答复过、线程也没被解决**的行内意见:一次调模型、一个提交、每个线程回一条 `Done in <sha> ✅` 并标记 resolved。

这样「一次提交 N 条意见」不再是 N 个互相踩踏的运行。并发组只保留一个排队中的运行(GitHub 的行为),被顶掉的那次也不会丢意见——后一次运行照样把它们一并处理。

**整批太重跑不动时会自动退化**:整批那次调用超时或输出被截断,revise 会改成**按线程逐条调模型**(单条意见要生成的 edits 短得多),仍然只提交一次、逐条回帖;逐条阶段有总预算(`llm-timeout-total-ms`),用满后剩下的线程如实回失败帖。

**失败回帖不算「已答复」**:返工失败的回帖带隐藏标记 `<!-- doc-agent:revise-failed -->`,下一次 review 仍会把该意见当待处理重新处理(v1.2.2 把失败回帖也算已答复,一次失败后整批意见就再也不会被重跑)。

### 从老 workflow 迁移

- 老 workflow(revise 挂 `pull_request_review_comment`、没有 concurrency)**不改也能跑**:脚本发现只有单条评论信息时,沿用历史行为逐条返工。新增的「推送被拒 → 变基重试」让同一次 review 里改不同位置的多条意见都能落地;但仍是 N 次运行 N 个提交,若两条意见改到同一段落,后到的会变基冲突并如实回帖失败。
- **不要只给老的逐条触发加 concurrency**:同一并发组里 GitHub 只保留一个排队中的运行,更早排队的会被取消,逐条模式下那条意见就丢了。要加并发组,请连触发方式一起换成上面的 `pull_request_review`。
- plan job 的 `permissions` 要补上 `pull-requests: write`,两个用途:
  - 取 diff 时读 PR 的提交与文件列表。读不到不会中断,只是退回 `MERGE_SHA^1`(rebase 合并下会漏掉最后一个提交之前的改动),并在日志里写明。
  - 失败时在被合并的代码 PR 下回帖。评论虽走 issues 接口,对 PR 编号 GitHub 按 Pull requests 权限判定:`issues: write` 加上只读的 `pull-requests` 会被拒(`Resource not accessible by integration (HTTP 403)`)。v1.2.1 起回帖被拒时,日志与 Step Summary 会写明原因类别和「请检查 workflow 的 pull-requests: write 权限」,job 仍失败退出。
- 新增的输入项都有默认值,`with:` 不必改。

## 配置

### 模型

- `llm-base-url` / `llm-model`:默认 GLM(`glm-4.6`),改 input 即可切到 DeepSeek、Kimi 等任意 OpenAI 兼容接口。
- `llm-fast-model`:翻译与译文质检用的快模型,默认 `glm-4-flash`。
- 全部输入项见 [`action.yml`](action.yml);日常工作流的研发视角说明见 [`USAGE.md`](USAGE.md)。

| 输入项 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `llm-retry-max-wait-ms` | `LLM_RETRY_MAX_WAIT_MS` | `180000` | 单次调用遇限流(429、智谱 `1302` / `1303` / `1305`)或 5xx 时,指数退避 + 随机抖动的**累计等待上限**。再等就超限时,按「模型接口报错」如实失败回帖。额度类业务码(欠费 `1113`、当日次数用尽 `1304`、次数上限 `1308`)与其余 4xx 不重试 |
| `llm-max-tokens` | `LLM_MAX_TOKENS` | 空(接口默认) | 模型单次输出上限。**长输出阶段例外**,始终显式设上限(取本项,没配则:整篇翻译与译文质检 4096、返工 revise 8192),因为接口默认可能只有 1024 token(实测 `glm-4-flash`),长文必被截断。输出被截断(`finish_reason=length`)时按「模型输出被截断」失败回帖 |
| `llm-timeout-ms` | `LLM_TIMEOUT_MS` | 空(按阶段默认) | 单次模型调用的客户端超时,填了对所有阶段生效。**阶段默认**:plan / draft / sync / translate / qa `300000`(`glm-4.6` 带思考时大文档一次调用实测约 210s),**revise `600000`**(返工一次要给出整节搬家 + 多处改号的 edits,300s 实测不够:#5655 连撞三次)。超时会中止这次尝试(日志写「中止,无用量」——被中止那次的 token 接口不返回,服务端却可能照样计费) |
| `llm-timeout-ms-plan` / `-draft` / `-revise` | `LLM_TIMEOUT_MS_PLAN` / `_DRAFT` / `_REVISE` | 空 | 只覆盖某个阶段的单次超时,优先级高于 `llm-timeout-ms` |
| `llm-timeout-total-ms` | `LLM_TIMEOUT_TOTAL_MS` | `900000` | 超时后的**总时长上限**。超时**不做同参数重试**(必然再次超时),只允许换翻倍的超时再试一次,且「已耗时 + 下次超时」不得超过本项;到顶就按「模型调用超时」如实失败,信息里写明实际超时值、尝试次数与建议动作。revise 逐条退化处理也用它当总预算 |
| `translate-chunk-chars` | `TRANSLATE_CHUNK_CHARS` | `4000` | 整篇翻译的分块大小(源文档字符数)。按 Markdown 标题切块逐块翻译再拼接,代码围栏内的 `#` 不当标题;任一块被截断就带块号明确失败,半篇译文不落盘 |

### 路径、语言与预算

下表输入项的默认值都等于历史行为(代码 `src/`、中文 `docs/zh/`、英文 `docs/en/`、`*.md`),老仓库的 workflow 不改也照跑。GitHub App 后端形态读同名环境变量。

| 输入项 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `code-paths` | `CODE_PATHS` | `src` | 代码路径 glob,换行或逗号分隔。`**` 跨目录,`*` 不跨目录;任何模式都按目录前缀匹配;`!` 或 `:!` 开头为排除。只有命中的文件改动才触发评估 |
| `docs-source-dir` | `DOCS_SOURCE_DIR` | `docs/zh` | 源语言(canonical)文档目录;仓库根目录写 `.`。计划里的新建文档也只能落在这里 |
| `docs-target-dir` | `DOCS_TARGET_DIR` | `docs/en` | 译文镜像目录,与源文档同相对路径。位于源目录之内时(如根目录 → `en/`)自动从源文档中排除 |
| `docs-glob` | `DOCS_GLOB` | `*.md` | 文档文件名通配,顺带滤掉图片;拼写与坏链检查也按它取文件 |
| `docs-exclude` | `DOCS_EXCLUDE` | 空 | 从源文档中排除的路径 glob(相对仓库根),如 `README.md, .github/**` |
| `source-lang` | `SOURCE_LANG` | `zh` | 源语言,`zh` 或 `en`。译文同步目前只支持中文 → 英文,设为 `en` 时同步步骤会明确报错 |
| `plan-token-budget` | `PLAN_TOKEN_BUDGET` | `60000` | plan 输入(提示词 + diff + 文档索引 + 文档全文)的估算 token 上限 |
| `diff-token-budget` | `DIFF_TOKEN_BUDGET` | `20000` | 代码 diff 的估算 token 上限,plan 与 draft 共用;超出时按文件截断,并在截断处标注「已截断」 |

token 按「ASCII 4 字符/token、中文 1 字/token」估算,偏保守,误差约 ±30%。默认的 60000 给 128K 上下文的模型留足了余量。

### 取 diff 的口径

「这个 PR 的净改动」对应哪段提交区间,由 GitHub 上该 PR 的数据决定(`scripts/diff.mjs` 的 `resolveDiffRange`),plan 与 draft 共用:

| 合并方式 | 区间 | 判定依据 |
|---|---|---|
| merge | `M^1..M` | 合并提交有两个父 |
| squash,或 PR 只有一个提交 | `M^1..M` | 目标分支上只多了 `M` 这一个提交 |
| rebase | `M~k..M` | 沿 `M` 的第一父往回数 k 个提交,与 PR 的 k 个提交逐个比对「提交说明 + 作者时间」(rebase 重放保留这两项,squash 不保留) |

定下区间后会拿 GitHub 的 PR 文件列表核对本地区间的改动文件,不一致就打警告日志。拿不到 GitHub 数据(plan job 没配 `pull-requests` 权限、接口报错、离线干跑)时退回 `M^1..M`,并在日志里写明「rebase 合并下只含 PR 的最后一个提交」。

### plan 阶段怎么挑文档

1. 取配置的代码路径下的改动,逐文件拿 diff。超出 `diff-token-budget` 时按文件截断:小文件保全,大文件在截断处标注。
2. 从 diff 抽标识符:配置键、类名 / 文件名、方法名、环境变量、字符串常量,以及从中拆出的单词。
3. 给每篇源文档打分:权重 × IDF × 命中次数,并做 BM25 式长度归一化。frontmatter `covers:` 覆盖了改动文件的文档直接排到最前。
4. 全部文档的「路径 + 标题」索引固定放进 prompt,余下预算按得分从高到低放全文;**得分为 0(与 diff 毫无交集)的文档只进索引**,除此之外不设相对阈值。连固定部分都放不下时失败,并在 PR 下回帖「超预算」。

在本地预演这一步(不调模型;默认也不访问 GitHub):

```bash
cd <目标仓库>
CODE_PATHS='apollo-*/src/**' node <doc-agent 路径>/scripts/plan-dryrun.mjs <merge_sha> <PR 号> "<PR 标题>"
# 想按正式运行的口径判定合并方式(rebase 合并取 M~k..M),再加 DRY_RUN_REPO=<owner/repo>(只读 GitHub)
```

### 示例一:Apollo(代码 PR → 文档)

[apolloconfig/apollo](https://github.com/apolloconfig/apollo) 是多模块 Java 项目,代码在 `apollo-*/src/main/**`,中文文档在 `docs/zh/**`,英文在 `docs/en/**` 同路径。文档目录恰好是默认值,只需配置代码路径;plan 与 draft 都要用它取 diff。

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
    concurrency:
      group: doc-agent-${{ github.event.pull_request.number || github.event.issue.number }}
      cancel-in-progress: false
    permissions: { contents: read, issues: write, pull-requests: write }
    steps:
      - uses: OWNER/doc-agent@v1.2.3
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
    concurrency:
      group: doc-agent-${{ github.event.pull_request.number || github.event.issue.number }}
      cancel-in-progress: false
    permissions: { contents: write, issues: write, pull-requests: write }
    steps:
      - uses: OWNER/doc-agent@v1.2.3
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
      github.event_name == 'pull_request_review' &&
      contains(github.event.pull_request.labels.*.name, 'docs/draft') &&
      github.event.review.user.type != 'Bot'
    runs-on: ubuntu-latest
    concurrency:
      group: doc-agent-${{ github.event.pull_request.number || github.event.issue.number }}
      cancel-in-progress: false
    permissions: { contents: write, pull-requests: write }
    steps:
      - uses: OWNER/doc-agent@v1.2.3
        with:
          mode: revise
          ref: ${{ github.event.pull_request.head.ref }}
          github-token: ${{ github.token }}
          llm-api-key: ${{ secrets.LLM_API_KEY }}
```

### 示例二:KWDB 文档(中英同步 + 译文质检)

KWDB 用户文档仓库只有文档:中文在仓库根目录的各个子目录里,英文在 `en/` 下同相对路径镜像。仓库里没有代码,所以不挂 plan。中文改动走文档 PR(打 `docs/draft` 标签),在中文行上留 review 意见并提交 review,就会触发返工,随后做英文增量同步和译文质检。

```yaml
name: doc-agent
on:
  pull_request_review: { types: [submitted] }

jobs:
  revise:
    if: >
      contains(github.event.pull_request.labels.*.name, 'docs/draft') &&
      github.event.review.user.type != 'Bot'
    runs-on: ubuntu-latest
    concurrency:
      group: doc-agent-${{ github.event.pull_request.number }}
      cancel-in-progress: false
    permissions: { contents: write, pull-requests: write }
    steps:
      - uses: OWNER/doc-agent@v1.2.3
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
                 #   config(路径配置、新建文档路径校验)· diff(取 diff 区间)· prefilter + budget(预筛与 token 预算)
                 #   planlib(plan 护栏)· review(批量返工:挑待处理意见)· git(显式 add 提交、变基重推)
                 #   contract(阶段契约)· llm(限流退避、截断检测、schema 校验)· errors(失败归类)· gh(只读查询)
                 #   edits · translate · checklib · plan-dryrun(本地干跑)
config/          # cspell(拼写)/ mlc(坏链)配置
server/          # GitHub App 后端形态(webhook 驱动,复用同一套 scripts);queue.mjs = 按 PR 串行的任务队列
test/            # node --test 离线测试
```

## 测试

```bash
node --test test/*.test.mjs   # 101 个用例,离线可跑(不调用 LLM、不访问 GitHub)
```

覆盖范围:
- 阶段契约的嵌入与回读、`runStage()` 的 schema 快速失败;
- 路径配置:默认值、Apollo 布局、KWDB 文档布局;新建文档的路径校验(穿越、绝对路径、译文目录、符号链接逃逸);
- diff 截断与 token 预算、文档预筛打分与 prompt 组装、得分为 0 只进索引;
- 取 diff 区间:临时仓库里真造 merge / squash / rebase 三种合并,外加拿不到 GitHub 数据时的退回与文件列表核对;
- 限流退避(429 / 智谱 1302、Retry-After、等待上限)、输出截断检测;超时只换更宽的超时重试一次、总时长上限、分阶段超时取值;
- 整篇翻译按标题分块(用 Apollo 真实的 17K / 25K 字符文档做夹具,mock 模型强制输出上限):切块后完整译出、不切块被识别为截断且不落盘;增量同步失败写明原因再兜底;
- 文档审核只查本次改动的文档、占位 URL 跳过并注明、工具崩溃不被过滤成空条目;
- 显式 add 提交、推送被拒后的变基重试与冲突回滚;批量返工挑待处理意见的纯函数;后端队列的串行与合并;
- search/replace 唯一性:用 Apollo 真实文档(6 行相同的 `export`、4 个同名小标题)验证只给重复行被拒、带区分上下文才成功;
- plan / draft / revise 端到端(临时 git 仓库 + 裸仓库当远端 + 假 `gh` + 本机 mock 接口):不静默失败(含回帖被 403 拒绝)、幂等跳过、
  新建文档与译文一起进提交、一次 review 多条意见一个提交、推送冲突如实回帖、整批被截断后退化为逐条处理仍只提交一次。

## 约定 / 现有局限

- 代码路径、文档目录、中英路径规则、源语言和 token 预算都是输入项(见「配置」),默认值即历史行为。支持「`docs/zh` ↔ `docs/en`」式与「根目录 ↔ `en/`」式两种布局;同目录后缀成对的布局(`foo.zh-CN.md` / `foo.en-US.md`)暂不支持。
- 译文同步只支持中文 → 英文(内置翻译提示词只有这个方向)。`source-lang: en` 时,评估与写初稿可用,同步步骤会明确报错。
- 文档预筛是基于标识符的词法打分,不理解语义:改动只体现在行为上、文档里又没有对应标识符时,相关文档可能只进索引、不附全文。全部文档都在索引里,模型仍可以把它列进计划。token 数是估算值。
- 计划可以新建文档,但新建路径必须落在 `docs-source-dir` 内(禁止 `..`、绝对路径、符号链接逃逸);侧边栏 / 目录类文件要模型自己列进计划才会改。
- 返工只处理**行内** review 意见;review 的顶层正文不作为指令。失败回帖**不算**「已答复」:再提交一次 review(或在该线程下补一条回复)就会重新处理这条意见——代价是一条始终失败的意见每次 review 都会再试一遍。
- 大文档仍整篇放进 draft 的 prompt;整篇翻译已按标题分块(`translate-chunk-chars`),但单个小节本身超过输出上限时仍会截断——那时明确失败,不会写半截译文。
- 文档审核(拼写 / 坏链)只查本次文档 PR 改动的文件;仓库里的存量问题不在扫描范围内。占位 URL(`https://host:port/…`、`<your-domain>`、`example.com`)跳过并在评论里注明。
- 还没有「文档 PR 合并即触发中英同步」的入口;KWDB 这类纯文档仓库目前经 review 返工触发同步。
- GitHub App 后端形态的配置对它服务的所有仓库生效(队列与临时目录已按 PR 隔离,但配置仍是进程级)。
- 目前只有 `/approve` 一个人工指令,评审计划即批准;更细的指令集(改范围/驳回)在路线图上。
