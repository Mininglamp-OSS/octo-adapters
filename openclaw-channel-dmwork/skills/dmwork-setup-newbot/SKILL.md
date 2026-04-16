---
name: dmwork-setup-newbot
version: 0.5.22
description: 收到 [DMWORK NEWBOT SETUP] 消息时，按此流程安装插件、配置 bot、绑定 agent、验证联通。
---

# DMWork Newbot 设置流程

收到包含 `[DMWORK NEWBOT SETUP]` 的消息时，按以下步骤操作。
消息中包含 Bot Name、Bot Token、API Server、Account ID 四个参数。

## 步骤

### 1. 安装/更新插件

阅读 `<API Server>/v1/bot/cli-guide.md` 完成插件安装和更新检查。

（用消息中的 API Server 值拼接 URL，例如 `https://api.example.com/api/v1/bot/cli-guide.md`）

具体操作：
- 执行 `npx -y openclaw-channel-dmwork info` 检查插件状态
- 未安装时，步骤 2 的 install 命令会自动安装
- 已安装时，询问用户是否需要更新，同意则执行 `npx -y openclaw-channel-dmwork update`

### 2. 配置 bot

install 是幂等的，已安装时跳过安装、继续配置账号：

```
npx -y openclaw-channel-dmwork install --bot-token <Bot Token> --api-url <API Server> --account-id <Account ID>
```

### 3. 获取当前 agent 标识

执行 `/status`，从输出中提取 agent 标识（用于 `openclaw agents bind` 的第一个参数）。

**如果无法从 /status 解析出 agent 标识，停止并询问用户：** "无法自动检测当前 agent，请告诉我你的 agent 名称"

### 4. 绑定 agent 到 bot

```
openclaw agents bind <agent标识> dmwork <Account ID>
```

### 5. 重启 gateway

```
openclaw gateway restart
```

### 6. 验证

```
npx -y openclaw-channel-dmwork doctor --account-id <Account ID>
```

### 7. 联通确认

调用 `POST <API Server>/v1/bot/register`（Authorization: Bearer <Bot Token>），从返回的 `owner_uid` 获取创建者 UID。
然后给创建者发一条私聊消息：

```
POST <API Server>/v1/bot/sendMessage
Authorization: Bearer <Bot Token>
Body: {"channel_id": "<owner_uid>", "channel_type": 1, "payload": {"type": 1, "content": "你好！我是 <Bot Name>，已成功上线 👋"}}
```

如果 register 或 sendMessage 失败，告诉用户："请在 DMWork 中给 bot 发一条消息测试是否联通。"

### 8. 记住 Bot API 文档

阅读 `<API Server>/v1/bot/skill.md`，后续需要操作 DMWork 时参考该文档。
