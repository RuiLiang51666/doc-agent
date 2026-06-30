# doc-agent server(GitHub App 后端)

Webhook 驱动的零文件形态:目标仓库**不放任何文件**,装上 GitHub App 即用。
后端收到事件后,用 App 的 installation token 克隆目标仓库,在克隆里跑 `../scripts`
里的 `plan/draft/revise`——和 Actions 版完全同一套逻辑。

主机需装:**node ≥ 20、git、gh(GitHub CLI)**。脚本用 `gh` + `GH_TOKEN` 鉴权。

## 1. 注册 GitHub App

GitHub → Settings → Developer settings → **GitHub Apps → New GitHub App**:

- **Webhook URL**:`https://<你的公网地址>/api/github/webhooks`
- **Webhook secret**:随机字符串(记下,等下配 `WEBHOOK_SECRET`)
- **Repository permissions**:
  - Contents → **Read and write**(推文档分支)
  - Issues → **Read and write**(开/评计划 Issue)
  - Pull requests → **Read and write**(开文档 PR、评论、resolve 线程)
- **Subscribe to events**:Pull request、Issue comment、Pull request review comment

建好后:记下 **App ID**;**Generate a private key** 下载 `.pem`;把 App **Install** 到目标仓库。

## 2. 配置 + 运行

```bash
cd server && npm install
export APP_ID=123456
export PRIVATE_KEY_PATH=./app.private-key.pem      # 或 export PRIVATE_KEY="-----BEGIN...\n..."
export WEBHOOK_SECRET=你设的密钥
export LLM_API_KEY=你的GLM_key                      # LLM_MODEL/LLM_FAST_MODEL 可选,默认 glm-4.6 / glm-4-flash
npm start
```

目标仓库仍需有 `docs/plan`、`docs/draft` 两个 label,以及中文 canonical 文档在 `docs/zh/`。

## 3. 本地开发(没有公网地址时)

用 [smee.io](https://smee.io) 把公网 webhook 转发到本地:

```bash
npx smee-client -u https://smee.io/你的频道 -t http://localhost:3000/api/github/webhooks
```

把 `https://smee.io/你的频道` 填进 App 的 Webhook URL 即可。

## 与 Actions 版的关系

逻辑(`scripts/`、`prompts/`)完全共用。Actions 版 = 目标仓库放瘦 workflow,GitHub 跑;
App 版 = 目标仓库零文件,你的服务器跑。二选一,或并存。
