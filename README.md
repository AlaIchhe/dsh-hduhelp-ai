<p align="center">
  <img src="docs/icon.png" width="96" alt="dsh-hduhelp-ai">
</p>

<h1 align="center">dsh-hduhelp-ai</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-hduhelp-ai">
    <img src="https://img.shields.io/badge/npm-dsh--hduhelp--ai-CB3837?style=for-the-badge&logo=npm&logoColor=white" alt="npm">
  </a>
</p>

<p align="center">
  <a href="https://github.com/AlaIchhe/dsh-hduhelp-ai/releases/latest"><img src="https://img.shields.io/github/v/release/AlaIchhe/dsh-hduhelp-ai?label=release&style=flat-square" alt="Release"></a>
  <a href="https://www.npmjs.com/package/dsh-hduhelp-ai"><img src="https://img.shields.io/npm/v/dsh-hduhelp-ai?style=flat-square" alt="npm"></a>
  <a href="https://github.com/AlaIchhe/dsh-hduhelp-ai/actions"><img src="https://img.shields.io/github/actions/workflow/status/AlaIchhe/dsh-hduhelp-ai/publish.yml?branch=master&label=CI&style=flat-square" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/AlaIchhe/dsh-hduhelp-ai?style=flat-square" alt="License"></a>
</p>

<p align="center">
  <sub><code>dsh plugin --profile web add dsh-hduhelp-ai</code></sub>
</p>

---

## 能做什么

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>面板登录</strong><br>
      设置里填学号和统一身份认证密码，走杭电 CAS 换 token，纯 HTTP 不需要浏览器；token 过期自动用 refresh_token 续期。
    </td>
    <td width="50%" valign="top">
      <strong>只注册你选的模型</strong><br>
      上游目录有 77 个模型，插件只把勾选的那几个注册进 DSH 模型列表；调用未勾选的模型直接报错，不静默放行。
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>多轮工具调用，失败就报错</strong><br>
      走 Responses 协议的 <code>function_call</code> / <code>function_call_output</code>。没有文本协议降级：配对失败、上游拒绝、流被截断都如实报错，不把半截回答当成功。
    </td>
    <td width="50%" valign="top">
      <strong>可调思考等级</strong><br>
      按上游 <code>supported_reasoning_levels</code> 暴露档位（低 / 中 / 高 / 更高 / 最大），在模型名旁边用滑杆切换，随请求以 <code>reasoning.effort</code> 下发。
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>额度如实呈现</strong><br>
      输入框工具行（宿主原生槽位）显示 5 小时 / 7 天窗口用量，标注「仅统计本插件请求」；窗口重置只标「待刷新」，不假装归零。
    </td>
    <td width="50%" valign="top">
      <strong>本机直连，不额外开口子</strong><br>
      定位账号所有者单人使用：不监听任何额外端口、不提供对外接口，模型请求由宿主直连杭电助手网关。
    </td>
  </tr>
</table>

<p align="center">
  <img src="docs/screenshot-effort.png" width="300" alt="推理等级">
</p>

<p align="center">
  <img src="docs/screenshot-quota.png" width="420" alt="额度胶囊">
</p>

## 开始使用

1. 装插件：

   ```bash
   dsh plugin --profile web add dsh-hduhelp-ai
   ```

2. 插件自带 cordis patch（`cordis.patch.yml`），安装时自动注入；需要自定义时编辑 profile 的 `cordis.patch.yml` 里 `hduhelp-ai` 条目：

   ```yaml
   - insert:
       - id: hduhelp-ai
         name: 'dsh-hduhelp-ai'
         config:
           purpose: app.mate.chat
           dataDir: ''
   ```

3. 打开 DSH 设置 →「杭电助手 AI」，用学号 + 数字杭电密码登录。

4. 在「模型注册」里勾选要用的模型并保存；回到聊天，在输入框上方的模型选择器里选「杭电助手」。

> [!NOTE]
> 插件的文本用途走 **Responses** 协议（`/openai/v1/responses`），走 chat/completions 会被上游拒绝；
> adapter 直接以 Responses 协议对接上游，不做 chat/completions 转换。

> [!IMPORTANT]
> 账号密码只用于换取 token，不落盘：`~/.dsh/hduhelp-ai/token.json` 里只有 access/refresh token（0600）。
> 面板接口要求 `X-DSH-HDUHelp: 1` 头并校验 Host，跨站页面无法静默调用。
> 插件不监听任何额外端口、不提供对外接口；模型请求由宿主直连上游，仅供账号所有者本人使用。
> 本项目只做协议适配与本地模型注册，请在你的账号额度内使用，并遵守学校与杭电助手的使用规则。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `purpose` | `app.mate.chat` | 固定用途，插件只暴露 chat 这一条入口 |
| `dataDir` | `~/.dsh/hduhelp-ai` | token / 勾选集 / 模型缓存目录 |
| `providerId` | `hduhelp` | 注册进 DSH 的 provider 路由名 |
| `displayName` | `杭电助手` | 模型选择器里显示的名字 |

旧版本配置里的 `port` / `host` / `apiKey` / `defaultModel` / `allowPassthrough` 已随反代一起移除，`contextWindow` 也已删除（上下文长度只认上游声明，不再兜底猜测）；升级后这些键会被忽略，可从 profile 配置里删掉。

## 行为约定

- **能力只认上游声明**：模态取 `input_modalities`、图像/工具取 `capabilities.image_input` / `capabilities.function_call`、上下文取 `context_window`、思考档位取 `supported_reasoning_levels`。不按模型名猜；上游没声明就显示「未声明」，两处声明冲突时按不支持处理并在日志里点名。带图片却选了未声明支持图片的模型，直接报错而不是悄悄丢图。
- **不降级**：工具调用只用结构化 `function_call` / `function_call_output`。历史被压缩导致工具结果配不上对、上游返回 400、SSE 缺终止事件，都如实报错，不退回文本观察协议，也不把截断的响应当成功。
- **凭证**：有 `expires_at` 时提前 2 分钟主动续期；续期单飞，并发 401 共用同一次请求；上游明确拒绝 refresh_token 即置未登录并清掉该账号的额度/目录缓存，网络抖动则保留凭证等下次重试。登出清 token、额度观测、模型目录与勾选集。
- **额度**：只统计本插件发出的请求（官方 App 的消耗看不到），面板与胶囊都标注这一点。窗口过了重置时刻只标「待刷新」，不当成 0%；5 小时窗口重置不代表 7 天解限；额度用尽的 429 归类为 `QUOTA`，不进重试。
- **额度实时更新**：上游没有查询额度的接口，数字只在真有请求时产生。因此额度胶囊改成长轮询（`/__hduhelp/quota/wait`）：一次请求结束后，宿主立刻把新观测推给正在看的页面，实测 30ms 内刷新，不再等 30 秒轮询；20 秒没有新观测就返回 `unchanged` 重新挂起，页面关闭立即回收连接。

## 工作原理

```text
学号 + 密码
  → GET  /identity/login/url?grant-key=cas&client_id=poplar
  → 解析 CAS 登录页的 login-croypto(AES key) 与 flowkey
  → POST /login 表单（AES-128-ECB + PKCS#7 加密，captcha_payload=AES("{}")）
  → 302 → /identity/login/sso?state&ticket → /auth/callback?code=
  → POST /identity/login/exchange {code} → access_token / refresh_token
```

额度来自响应头：`x-hduhelp-quota-5h-utilization` / `-5h-reset`、`x-hduhelp-quota-7d-*`，429 时附 `retry-after`。这些头只在推理响应里出现，所以「实时」的边界是「最近一次请求」，不是「此刻账户真实余量」。

## 测试

```bash
node --test test/
```

## 卸载

```bash
dsh plugin --profile web remove dsh-hduhelp-ai
rm -rf ~/.dsh/hduhelp-ai
```

再删掉 `cordis.patch.yml` 里的 `hduhelp-ai` 条目。

---

<p align="center">
  <a href="https://github.com/AlaIchhe/dsh-hduhelp-ai/issues">反馈</a> ·
  <a href="LICENSE">License</a> ·
  <a href="https://www.npmjs.com/package/dsh-hduhelp-ai">npm</a>
</p>
