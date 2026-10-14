# dsh-auto-review-session-fix

auto-review 评审请求补 `sessionId` 的补丁插件，不动 harness 本体。

## 修什么

- 现象：`auto` 权限下连 `read` 都报 `Auto review of tool "read" failed ... MissingSessionID`（opencode 网关 400）。
- 根因：评审调用故意不带 `sessionId`，而主链路每次都带；opencode 网关要求每个请求都带会话路由信息——pi-ai catalog 路由（`opencode`/`opencode-go`）把它映射成 `x-opencode-session` 头，手工声明的 `opencode-go-responses` 之类的路由映射成请求体里的 `prompt_cache_key`；缺了就 400。
- 本插件：只认评审请求（`system` 含固定标记），克隆一份补上归属会话 id 再重发；原冻结对象不动；拿不到会话时放行，原始报错透出。
- 上游现状（2026-10 核对到 0.2.1-alpha.2）：评审请求仍不带 `sessionId`，且该行为被上游单测锁定，所以本插件仍需保留。

## 安装

```bash
dsh plugin --profile web add "link:<本目录>"
```

重启 dsh 生效（服务端插件）。卸载：

```bash
dsh plugin --profile web remove dsh-auto-review-session-fix
```

## 验证

```bash
node test/smoke.mjs
```

覆盖：跟踪补全、单会话兜底、非评审放行、已有 id 不动、无会话 fail-open。

在真实 dsh 上：切 `auto` 权限触发一次 `read`，不再出现 `MissingSessionID` 即生效。

## 局限

- 靠 `system` 里的 `final authorization reviewer` 标记识别评审，harness 改文案后需同步。
- 多会话并发评审时极端情况下可能补成隔壁会话 id：头合法、只是路由次优，评审是无状态单轮分类，不影响结论。
