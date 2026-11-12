# dsh-hduhelp-ai

[![npm version](https://img.shields.io/npm/v/dsh-hduhelp-ai.svg)](https://www.npmjs.com/package/dsh-hduhelp-ai)
[![license](https://img.shields.io/npm/l/dsh-hduhelp-ai.svg)](./LICENSE)
[![gh](https://img.shields.io/badge/github-AlaIchhe%2Fdsh--hduhelp--ai-181717?logo=github)](https://github.com/AlaIchhe/dsh-hduhelp-ai)

把 **杭电助手（HDUHelp）的 AI 网关**接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，在 DSH 里直接当模型用。

已发布到 npm：[`dsh-hduhelp-ai`](https://www.npmjs.com/package/dsh-hduhelp-ai)

- **面板登录**：设置 → 杭电助手 AI，填学号 + 统一身份认证密码；纯 HTTP 走杭电 CAS（crypto 加密表单，不需要浏览器，<1s）
- **模型注册**：登录后 `杭电助手` 作为 provider 出现；上游目录 77 个模型，**只注册你勾选的那几个**，选择器不臃肿
- **原生多轮工具**：走 Responses 协议的 `function_call` / `function_call_output`，ReAct 多轮不降级
- **额度显示**：输入框工具行、权限按钮右边显示 5h / 7d 两个窗口的用量，429 时显示恢复倒计时
- **OpenAI 兼容反代**：额外提供 `http://<host>:8787/v1`，给 Cherry Studio / LobeChat / SDK 用

![设置面板](docs/screenshot.png)

输入框工具行、「完全权限」右侧的额度胶囊：

![额度胶囊](docs/screenshot-quota.png)

> 接口从 **杭电助手 Beta 0.5.8** 的 Flutter/Dart AOT 包里逆向得到，仅用于个人接入自己账号的模型额度。

## 安装

```bash
# 在 DSH profile 里装（推荐）
dsh plugin --profile web add dsh-hduhelp-ai
```

装完在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 末尾加一条 loader 入口：

```yaml
- insert:
    - id: hduhelp-ai
      name: 'dsh-hduhelp-ai'
      config:
        port: 8787
        apiKey: sk-hduhelp
```

然后刷新 DSH 页面（或等 HMR 重载），设置里会出现「杭电助手 AI」。

本地开发可以 `file:` 安装：

```bash
dsh plugin --profile web add file:/path/to/dsh-hduhelp-ai
```

## 使用

### 1. 登录

设置 → 杭电助手 AI → 填学号 / 密码 → 登录。

token 存在 `~/.dsh/hduhelp-ai/token.json`（0600），过期自动用 refresh_token 续；
不想让插件碰密码，也可以手动把 `access_token` 写进这个文件。

### 2. 勾选模型

面板里「模型注册」列出上游全部 77 个模型（带上下文窗口），搜索 / 勾选 / 保存。
没勾任何模型时，模型选择器里不会出现「杭电助手」。

### 3. 用起来

聊天输入框上方的模型选择器里选 **杭电助手 → 任意已勾选模型**，agent 直接跑。

> 注意：文本用途的入口协议是 **Responses**（`/openai/v1/responses`），插件内部已处理；
> 走 `chat/completions` 会被上游拒绝。

## OpenAI 兼容反代

```
http://<host>:8787/v1
```

| 路由 | 说明 |
|---|---|
| `GET  /v1/models` | 上游模型目录 |
| `POST /v1/chat/completions` | 翻译成 Responses，流式/非流式都支持 |
| `POST /v1/responses` | 原样透传 |
| `POST /v1/embeddings`、`/v1/images/*`、`/v1/rerank` | 透传 |

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer sk-hduhelp' \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-flash","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

API Key 默认 `sk-hduhelp`，也可以直接把 `access_token` 当 key 传。

## 配置

`cordis.patch.yml` 的 `config`：

| 键 | 默认 | 说明 |
|---|---|---|
| `port` | `8787` | 反代端口，`0` 表示不自动启动 |
| `host` | `0.0.0.0` | 反代监听地址（内网用；想锁死改 `127.0.0.1`） |
| `purpose` | `app.mate.chat` | 固定用途，插件只暴露 chat 这一条入口 |
| `apiKey` | `sk-hduhelp` | 客户端用的 key |
| `defaultModel` | 空 | 请求没带 model 时补的值 |
| `dataDir` | `~/.dsh/hduhelp-ai` | token / 勾选集 / 模型缓存目录 |

## 工作原理（简述）

```
学号+密码
  → GET /identity/login/url?grant-key=cas&client_id=poplar
  → CAS 登录页解析 login-croypto(AES key) + flowkey
  → POST /login 表单（AES-128-ECB + PKCS#7 加密密码，captcha_payload=AES("{}")）
  → 302 → /identity/login/sso?state&ticket → /auth/callback?code=
  → POST /identity/login/exchange {code} → access_token / refresh_token
```

模型调用：

```
{api}/purposes/app.mate.chat/openai/v1/responses
Authorization: Bearer <access_token>
```

额度是响应头带回来的：

```
x-hduhelp-quota-5h-utilization / x-hduhelp-quota-5h-reset
x-hduhelp-quota-7d-utilization / x-hduhelp-quota-7d-reset
retry-after   (仅 429)
```

## 安全

- 面板接口要求 `X-DSH-HDUHelp: 1` 头 + Host 白名单，且不发 CORS 头，跨站页面无法静默调用；
- 密码只在登录子进程的环境变量里出现一次，不落盘；token/勾选文件 0600；
- 反代默认监听 `0.0.0.0`，只在内网使用；公网部署请改 `127.0.0.1` 或加前置鉴权。

## 卸载

```bash
dsh plugin --profile web remove dsh-hduhelp-ai
rm -rf ~/.dsh/hduhelp-ai
# 再删掉 cordis.patch.yml 里的 hduhelp-ai 条目
```

## License

MIT
