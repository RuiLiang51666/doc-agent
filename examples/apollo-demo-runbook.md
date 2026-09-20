# Apollo 回放演示操作手册

在 `apolloconfig/apollo` 的个人 fork 上回放**上游已合并的真实 PR**:只把 PR 的代码改动推上去、剔掉里面人工写的文档改动,让 doc-agent 跑完「评估 → 计划 → 初稿 → 中英同步 → 按 review 返工」,再拿它的产出与上游那份人工文档对比。

配套文件:同目录的 [`apollo-fork-doc-agent.yml`](apollo-fork-doc-agent.yml)(放进 fork 的 `.github/workflows/doc-agent.yml`)。

> 本手册里标 **[写]** 的步骤都会改 GitHub 上的东西(推送、改设置、开 PR),请本人执行;其余是只读核对。

## 0. 开始前的现状快照

下面是 2026-09-16 只读核实的状态(`gh api` GET),每一条都对应后面必须做的一步。你自己核对时把命令重跑一遍即可。

| 核实项 | 当时的值 | 命令 | 影响 |
|---|---|---|---|
| doc-agent 远端 | public,默认分支 `main`,最近推送 2026-07-16,tag 只有 `v1` / `v1.1` | `gh api repos/<你>/doc-agent --jq '.visibility,.default_branch,.pushed_at'`;`gh api repos/<你>/doc-agent/tags --jq '.[].name'` | P0 / P1 两个提交还没推,现有 tag 都在它们之前 → 第 1 步 |
| fork | `RuiLiang51666/apollo`,public,fork of `apolloconfig/apollo`,默认分支 `master`,head 与上游 master 同为 `39b8d491b` | `gh api repos/<你>/apollo --jq '{fork,private,default_branch}'` | 四个候选 PR 的合并提交都已在本地历史里,回放分支可以直接从它们的父提交拉 |
| Issues 功能 | `has_issues: false`(**关着**) | `gh api repos/<你>/apollo --jq .has_issues` | fork 默认关闭 Issues;plan 阶段要 `gh issue create`,不开必失败 → 第 5 步 |
| 标签 | 共 10 个,**没有** `docs/plan` / `docs/draft` | `gh api repos/<你>/apollo/labels --paginate --jq '.[].name'` | `gh issue create --label docs/plan` 遇到不存在的标签会报错 → 第 7 步 |
| Actions 仓库级开关 | `enabled: true`,`allowed_actions: all` | `gh api repos/<你>/apollo/actions/permissions` | 这是「仓库级 Actions 权限」,不等于 fork 的 workflow 已启用 |
| 已注册 workflow | `total_count: 0` | `gh api repos/<你>/apollo/actions/workflows --jq .total_count` | 与「fork 的 workflow 还没启用过」一致:fork 里要在 Actions 页点一次才注册 → 第 4 步 |
| GITHUB_TOKEN 默认权限 | `default_workflow_permissions: read`,`can_approve_pull_request_reviews: **false**` | `gh api repos/<你>/apollo/actions/permissions/workflow` | `read` 没问题(workflow 里每个 job 都显式声明了 `permissions`);但 `can_approve_pull_request_reviews: false` 会让 draft 阶段的 `gh pr create` 直接被 GitHub 拒绝 → 第 5 步 |

## 1. [写] 推送 doc-agent 并打 tag

fork 里的 workflow 用 `uses: <你>/doc-agent@<tag>` 引用,所以内核必须先推上去。现有的 `v1` / `v1.1` 是 P0 之前的版本,代码路径写死 `src/`,在 Apollo 上会静默零产出,**不能用**。

```bash
cd /Users/rui/claude/doc-agent
git log --oneline -3          # 确认 P0(1c5e664)、P1(e3d0d36)都在
node --test test/*.test.mjs   # 全部用例应全过
git push origin main
git tag v1.2.3 && git push origin v1.2.3
```

打完后把 `apollo-fork-doc-agent.yml` 里三处 `RuiLiang51666/doc-agent@v1.2.3` 改成你的 `<owner>/<repo>@v1.2.3`。想边调边试可以先用 `@main`,稳定了再钉 tag。

> **已按 v1.2 搭好 fork 的**:v1.2.1 修了 plan job 的权限(`pull-requests` 从 `read` 改为 `write`;只读时,plan 失败在代码 PR 下回帖会被 403 拒绝,原因只留在 Actions 日志里)。推送 `v1.2.3` 后,用新版 `apollo-fork-doc-agent.yml` 覆盖回放基线分支上的 `.github/workflows/doc-agent.yml` 并推送(快进,别覆盖已合并的回放提交)。注意:Re-run 旧运行沿用原提交上的 workflow,用不上新权限。
>
> **v1.2.3 修的是 #5655 返工(revise)暴露的五件事**:① 超时不再原样重试——同参数重试必然再超时,现在只允许换翻倍的超时再试一次,且有总时长上限 `llm-timeout-total-ms`(默认 900s),失败信息写明实际超时值、尝试次数与建议动作;② 超时可以分阶段配(`llm-timeout-ms-plan/-draft/-revise`),revise 默认从 300s 提到 600s;③ **返工失败的回帖不再把线程算成「已答复」**(带 `<!-- doc-agent:revise-failed -->` 标记),再提交一次 review 就会重新处理那些意见——v1.2.2 在这里会让失败过的意见永远不再被重跑;④ revise 显式设输出上限 8192,并把本阶段用量写进日志与 Step Summary;⑤ 整批调用超时或被截断时,自动退化为**按线程逐条处理**,仍只产生一个提交、逐条回帖。
>
> **v1.2.2 修的是 #5655 首轮 draft 暴露的五件事**:① 英文增量同步失败会写明原因类别再兜底(以前静默);② 整篇翻译按标题切块、每次显式设输出上限,25KB 的文档不再必然被截断,任一块截断就明确失败且不落半篇译文;③ 译文质检失败不再被吞,PR 下回帖「译文质检未完成(原因类别)」;④ 客户端超时默认从 120s 提到 300s(可用 `llm-timeout-ms` 配),超时中止计进重试并写「中止,无用量」;⑤ 文档审核只查本次文档 PR 改动的文件,占位 URL 跳过并注明。

## 2. [写] 建回放基线分支 `replay-base`,同时处理掉上游 CI

**这一步必须在启用 Actions 之前做**,顺序见第 4 步的说明。

基线取「首轮要回放的那个 PR 的父提交」。本手册以 **#5649** 首跑(理由见第 8 步),它的合并提交是 `0025674311a1c3de4c3571a549f7b7732fb2ada7`。

```bash
# 任一份 apolloconfig/apollo 的克隆里
git remote add fork https://github.com/<你>/apollo.git   # 已有就跳过
git fetch origin && git fetch fork

MERGE=0025674311a1c3de4c3571a549f7b7732fb2ada7            # PR #5649 的合并提交
git switch -c replay-base ${MERGE}^1                      # 基线 = 该 PR 合并前的状态

# ① 删掉上游自带的全部 workflow(14 个 yml + 1 个 gh-aw 的 .md 源文件)
git rm -r -q .github/workflows

# ② 只放 doc-agent 这一个
mkdir -p .github/workflows
cp /Users/rui/claude/doc-agent/examples/apollo-fork-doc-agent.yml .github/workflows/doc-agent.yml
# 记得先把里面的 RuiLiang51666/doc-agent@v1.2.3 换成你自己的
git add .github/workflows/doc-agent.yml
git commit -m "replay: 只保留 doc-agent workflow,移除上游 CI"

git push fork replay-base
```

为什么是「删文件」而不是别的做法、有哪些坑,见[附录 A](#附录-a上游-ci-噪声怎么处理)。

## 3. [写] 把 `replay-base` 设为默认分支

```bash
gh api -X PATCH repos/<你>/apollo -f default_branch=replay-base
# 或 UI:Settings → General → Default branch → 切换
```

两个理由,缺一不可:

- **doc-agent 需要**:draft 阶段用 `gh repo view --json defaultBranchRef` 决定文档 PR 提给哪个分支(`scripts/draft.mjs:84`)。默认分支若还是 `master`,文档 PR 会提给 `master`——而 `master` 里**已经有上游人工写好的文档**,对比就没有意义了。
- **屏蔽噪声需要**:`issues`、`issue_comment`、`pull_request_target`、`schedule` 这几类事件,GitHub 一律读**默认分支**上的 workflow 文件。默认分支指向 `replay-base`(那里只有 doc-agent 一个 workflow),这几类事件就再也触发不到上游的 CLA、Issue 自动分类等 workflow。

## 4. [写] 启用 Actions

fork 的 workflow 默认是停用的,要手动启用一次:打开 `https://github.com/<你>/apollo/actions`,点 **"I understand my workflows, go ahead and enable them"**。

**顺序很重要**:先做完第 2、3 步再启用。这样在整个准备期里 GitHub 不会执行任何 workflow,等启用时默认分支上只剩 doc-agent 一个文件,上游 CI 从头到尾一次都不会跑。

启用后自检:

```bash
gh workflow list --repo <你>/apollo
# 期望只有一行:doc-agent    active    <id>
```

## 5. [写] 三项仓库设置

| 设置 | 位置 | 为什么 |
|---|---|---|
| 打开 **Issues** | Settings → General → Features → 勾上 Issues | plan 阶段要开「文档更新计划」Issue;fork 默认关闭。命令:`gh api -X PATCH repos/<你>/apollo -f has_issues=true` |
| 勾上 **Allow GitHub Actions to create and approve pull requests** | Settings → Actions → General → Workflow permissions | draft 阶段用 `github.token` 执行 `gh pr create` 开文档 PR。不勾会报 `GitHub Actions is not permitted to create or approve pull requests`,整条链断在这里 |
| Workflow permissions 保持 **Read repository contents and packages permissions** 即可 | 同上 | workflow 里三个 job 都显式写了 `permissions:`,会在默认权限之上按需申请;不必改成 permissive |

## 6. [写] 配 secret `LLM_API_KEY`

```bash
gh secret set LLM_API_KEY --repo <你>/apollo
# 回车后在提示里粘贴 key:不要写进命令行,免得进 shell 历史
```

建议**新建一把专用 key 并设额度上限**:回放会真实调用大模型,doc-agent-demo 上已经踩过智谱 `1302`(速率限制)。v1.2 起限流会指数退避重试(累计等待上限默认 180 秒),但账号档位太低仍会失败回帖。

## 7. [写] 建两个标签

```bash
gh label create docs/plan  --repo <你>/apollo --color 1D76DB --description "doc-agent 文档更新计划"
gh label create docs/draft --repo <你>/apollo --color 0E8A16 --description "doc-agent 文档初稿 PR"
```

标签不存在时 `gh issue create --label docs/plan` 会直接报错,而且 workflow 的 `if:` 也靠这两个标签筛事件。

## 8. [写] 回放第一个 PR

**首轮推荐 #5649**(`fix: restrict quick start H2 console access`),理由:

| 维度 | #5649 | 说明 |
|---|---|---|
| 代码改动 | 1 个文件 1 行(`apollo-assembly/src/main/resources/application-github.properties`:`web-allow-others` true → false) | 四个候选里最小,diff 远在 `diff-token-budget`(20000)之内 |
| 文档改动 | `docs/zh` + `docs/en` 的 `quick-start.md` 各 +7 行 | 中英都改,能同时验「文档初稿」与「中英同步」 |
| 目标文档大小 | 13.6 KB | 四个候选里最小(另三个是 25 KB / 40 KB / 84 KB),初稿 prompt 与译文同步都不会撞输出上限 |
| 预算 | 干跑实测 59848 / 60000 token,目标文档 `docs/zh/deployment/quick-start.md` 放了全文 | 见 P1 回执的预筛回归 |
| 难度 | 不是白送 | 代码只改了一个开关,人工文档却加了「注意事项」一条 + 6 处 `export SPRING_H2_CONSOLE_ENABLED=false`。相关线索(`spring.h2.console.enabled=true`)在 diff 的上下文行里,模型要自己接上。首轮就能量出真实的召回/准确差距 |

后续顺序建议:**#5655**(4 个 Java + 新配置项,专验「draft 带 diff」)→ **#5580**(84 KB 大页上的 search/replace 唯一性)→ **#5665**(新增约 85 行 API 文档,验输出长度)。

回放用脚本(**默认只做本地操作,推送和开 PR 只打印命令、不执行**):

```bash
node /path/to/scratchpad/apollo-replay.mjs 5649 \
  --clone /path/to/apollo-clone \
  --base replay-base \
  --fork <你>/apollo
```

它会:从 `--base`(或该 PR 的父提交)拉出 `replay/pr-5649` → 应用该 PR 的改动但剔除 `docs/**` → 提交 → 把上游那份人工文档改动导出成标准答案 → 打印推送与开 PR 的命令。确认无误后照着执行(或给脚本加 `--push`):

```bash
git push fork replay/pr-5649
gh pr create --repo <你>/apollo --base replay-base --head replay/pr-5649 \
  --title "fix: restrict quick start H2 console access" --body "replay of upstream apolloconfig/apollo#5649"
```

## 9. 跑完整链路

1. **合并回放 PR**(用 **Squash and merge**;doc-agent 三种合并方式都支持,squash 最省事)。
   → 触发 `plan`:几分钟后应出现一个带 `docs/plan` 标签的 Issue「📝 docs: …(#N)」,正文里有「必须更新 / 评估为无需改动」和一行 `<sub>` 统计(放全文篇数、token、diff 口径)。
2. **在计划 Issue 下评论 `/approve`**。
   → 触发 `draft`:写初稿 → 同步英文 → 提一个带 `docs/draft` 标签的文档 PR,并附拼写/坏链检查与译文质检评论。
3. **在文档 PR 上提交 review**:点 "Start a review",一次留 **2–3 条**行内意见再 "Submit review"。
   → 触发 `revise`:一次运行处理全部待处理意见,一个提交,每条线程回一句 `Done in <sha> ✅` 并 resolve。这一条专门验并发互斥(P1 能力 1),值得刻意跑一次。

每一步都去 Actions 页看 job 日志与 Step Summary;失败时 doc-agent 会在对应位置回帖写明原因类别(超预算 / 模型接口报错 / 模型输出被截断 / 模型输出校验失败 / 推送失败 / 其他异常);回帖本身被拒时(如 403),Step Summary 里会写明原因类别和该检查的权限。

## 10. 与标准答案对比

回放脚本已经把上游 PR 里**人工写的**文档改动导出到 `<scratchpad>/golden/pr-<N>/`:

- `docs.diff` —— 人工文档改动的完整 diff(标准答案);
- `after/` —— 该 PR 合并后每篇文档的完整内容,便于与 doc-agent 的产出逐篇 diff;
- `summary.md` —— 改了哪几篇、各多少行。

四个对比维度(建议直接写进案例页):

| 维度 | 怎么量 |
|---|---|
| 召回 | 该改的文件是否都进了计划 Issue?有没有多列无关文档? |
| 准确 | 配置项名、默认值、行为边界是否与代码一致?有没有臆造? |
| 中英一致 | `docs/en` 的同步是否覆盖了 `docs/zh` 的全部改动,术语是否稳定? |
| 返工 | review 意见是否被逐条落实,一次 review 是否只产生一个提交? |

```bash
# 例:把 doc-agent 写的中文文档与人工版逐行比
git fetch fork && git show fork/docs/plan-<Issue号>:docs/zh/deployment/quick-start.md > /tmp/agent.md
diff -u <scratchpad>/golden/pr-5649/after/docs/zh/deployment/quick-start.md /tmp/agent.md
```

---

## 附录 A:上游 CI 噪声怎么处理

**问题**:fork 里要跑 doc-agent 就得启用 Actions,可一启用,上游 Apollo 自带的 CI 也会在回放 PR 上触发——Maven 构建整个 Java 项目、CodeQL、两套 e2e,又慢又吵,还会把真正要看的 doc-agent 日志淹掉。

**先看清楚到底哪些会触发。** `apolloconfig/apollo` 的 `.github/workflows/` 下有 14 个 yml(外加 1 个 `issue-triage.md`,GitHub 不执行非 yml 文件),按触发方式分三类:

| 类别 | 文件 | 回放 PR 会触发吗 |
|---|---|---|
| `push` / `pull_request` 且限定 `branches: [master]` | `build.yml`、`code-style-check.yml`、`codeql.yml`、`license.yml`、`docker-validation.yml`、`external-discovery-smoke.yml`、`javascript-test.yml`、`openapi-compatibility.yml`、`portal-login-e2e.yml`、`portal-ui-e2e.yml` | **不会**——回放 PR 的目标分支是 `replay-base`,不匹配 `master` |
| `pull_request` 限定 `branches: [main]` | `commit_lint.yml` | 不会(Apollo 根本没有 `main` 分支) |
| 只有 `workflow_dispatch` | `docker-publish.yml`、`release-packages.yml` | 不会(要人手点) |
| **不受分支过滤约束** | `cla.yml`(`pull_request_target` 无分支过滤 + `issue_comment`)、`issue-triage.lock.yml`(`issues: [opened]`)、`codeql.yml` 的 `schedule` | **会**——而且 `issue_comment` 正是 doc-agent 的 `/approve` 用的事件,`issues: [opened]` 正是 plan 开计划 Issue 时触发的 |

**做法(本手册采用)**:在 `replay-base` 上删掉 `.github/workflows/` 里的全部上游 workflow,只留 `doc-agent.yml`,并把 `replay-base` 设为默认分支(第 2、3 步)。

依据:

- `pull_request` / `push` 事件用的是**事件发生的那个 ref 上的 workflow 文件**。回放分支从 `replay-base` 拉出,PR 也提给 `replay-base`,两边都没有上游 workflow。
- `issues`、`issue_comment`、`schedule` 这几类事件,GitHub 只认**默认分支**上的 workflow 文件(官方文档在每个此类事件下都有一句「只有当 workflow 文件在默认分支上时才会触发」)。默认分支 = `replay-base` → 上游的 `cla.yml`、`issue-triage.lock.yml` 不在那里,永不触发。
- `pull_request_target` 用的是 **PR base 分支**上的 workflow 文件。base = `replay-base` → 同样没有。
- 参考:[Events that trigger workflows](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows)、[Disabling and enabling a workflow](https://docs.github.com/en/actions/using-workflows/disabling-and-enabling-a-workflow)。

**注意事项**:

1. **顺序**:先推 `replay-base` + 切默认分支,**再**在 Actions 页启用。反过来做,启用后到你推完分支之间的任何事件都可能点着上游 CI。
2. `master` 分支可以原样留着(里面还有全部上游 workflow)。只要不往它 push、不向它提 PR、它也不是默认分支,就不会有任何运行。想更保险可以直接删掉 fork 的 `master`——但删了就没法再用 GitHub 的 "Sync fork" 了。
3. 删 workflow 的那个提交会让**后续回放冲突**:如果某个要回放的上游 PR 恰好改到 `.github/workflows/`,应用它的 diff 会冲突。四个候选 PR(#5649 / #5580 / #5655 / #5665)都没碰这个目录,不受影响;回放脚本遇到这种情况会报错并列出冲突文件。
4. **备选做法:逐个停用 workflow**(`gh workflow disable <文件名>`,或 Actions 页每个 workflow 的 ⋯ → Disable workflow)。这是 GitHub 官方支持的机制,好处是不改任何文件、fork 与上游的 diff 更干净。两个前提要知道:
   - `gh workflow list` 只列**默认分支**上的 workflow。所以这条路只有在「默认分支仍是 `master`」时才用得上,而默认分支必须是 `replay-base`(第 3 步)——两者冲突,这也是本手册不把它当主方案的原因。
   - fork 的 workflow 在 Actions 页点启用之前是**没有注册**的(实测 `actions/workflows` 返回 `total_count: 0`),所以只能「先启用再停用」,中间有一小段窗口,期间发生的事件仍会触发 CI。
   把它当作兜底:启用后如果 `gh workflow list` 里意外多出别的 workflow,用它立刻停掉。
5. fork 是 public 仓库,Actions 分钟数免费,所以这里的成本考量只是**噪声与排队时间**,不是账单。

## 附录 B:已知坑与预期现象

- **文档审核(拼写 + 坏链)的范围**:v1.2.2 起只查本次文档 PR 改动的文件(v1.2.1 扫全仓 102 个 `.md`,在 #5655 首轮占掉整次运行 63% 的时间,评论里 319 条坏链几乎都是仓库存量问题)。文档里的占位 URL(如 `https://host:port/...`)会跳过并在评论里注明——它以前会让 `markdown-link-check` 抛 `TypeError: Invalid URL`,把整份文件的检查弄成空条目。审核仍是**提示性**的,不阻断流程,但失败不再被吞:日志与 Step Summary 会写明原因类别。
- **`CHANGES.md` 会被一起回放**:#5580 / #5655 / #5665 的改动里都有仓库根的 `CHANGES.md`。它不在 `docs/**` 里(所以脚本不剔),也不在 `code-paths` 里(所以模型看不到),对结果中性。脚本会把这类「既不是文档、也不在代码路径里」的文件单独列出来提醒。
- **`github.token` 创建的 PR 不会再触发 workflow**(GitHub 的防循环机制)。这条链路不受影响:合并回放 PR、评论 `/approve`、提交 review 都是你本人操作。
- **计划 Issue 是幂等的**:同一个源 PR 已有计划 Issue 时 plan 会跳过。想重跑就先关掉(`--state all` 都算)那个 Issue 再说,或换一个回放 PR。
- **文档 PR 也是幂等的**:重复 `/approve` 时,若 `docs/plan-<Issue号>` 分支的 PR 已存在就跳过。
- **重复行上的 search/replace**:#5649 的 `quick-start.md` 有 6 行相同的 `export SPRING_PROFILES_ACTIVE=...` 和 4 个 `#### 注意事项`。draft 的编辑只给其中一行会被拒(报「出现 N 次,必须唯一」,归类「模型输出校验失败」,在计划 Issue 下回帖);提示词已要求带上区分上下文。真遇到了,重新评论 `/approve` 重试即可。
- **连续回放多个 PR 时的基线**:本手册的 `replay-base` 停在 #5649 的父提交。要接着回放 #5580 / #5655 / #5665,两种走法——(a) 沿用同一条 `replay-base`,每轮先把上一轮的文档 PR 合并回去,再用 `--base replay-base` 应用下一个 PR 的代码(跨过中间的上游提交,可能冲突,脚本会报);(b) 每个 PR 单独建 `replay-base-<N>`(= 该 PR 的父提交 + 那个 workflow 提交)并把默认分支切过去,永不冲突,代价是每轮改一次默认分支。稳妥起见首轮之后建议走 (b)。
- **模型选择**:默认 `glm-4.6`(上下文 200K),plan 预算 60000 token 有充足余量。换 128K 的模型也够,但别换回 `glm-4-plus`(最大输出只有 4K,大页翻译会被截断——v1.2 起会明确报「模型输出被截断」而不是写半截译文;v1.2.2 起整篇翻译已按标题切块,单块译文远小于 4K)。
- **单次调用可能很久**:#5655 首轮实测 `glm-4.6` 单次调用到过 208.6s / 179.6s(带思考),v1.2.1 的 120s 客户端超时会把还在生成的连接掐掉、白跑一轮,被中止那次的 token 也拿不到。v1.2.2 把默认超时提到 300s(`llm-timeout-ms` 可配),并把中止计进重试统计、日志里写明「中止,无用量」。

## 附录 C:清理与重跑

```bash
# 关掉本轮产物,重新来一遍
gh issue close <计划 Issue 号> --repo <你>/apollo
gh pr close <文档 PR 号> --repo <你>/apollo
git push fork --delete docs/plan-<Issue号> replay/pr-<N>

# 彻底收工:默认分支切回 master,并在 Settings → Actions 里停用 Actions
gh api -X PATCH repos/<你>/apollo -f default_branch=master
```
