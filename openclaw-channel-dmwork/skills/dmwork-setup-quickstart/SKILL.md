---
name: dmwork-setup-quickstart
version: 0.5.22
description: 收到 [DMWORK QUICKSTART] 消息时，按此流程安装插件、为所有 agent 创建 bot、配置绑定、验证联通。
---

# DMWork Quickstart 设置流程

收到包含 `[DMWORK QUICKSTART]` 的消息时，按以下步骤操作。
消息中包含 User API Key 和 API Server 两个参数。

目标：为 OpenClaw 的**所有 agent** 各创建一个 DMWork bot，并完成配置和绑定。

## 步骤

### 1. 安装/更新插件

阅读 `<API Server>/v1/bot/cli-guide.md` 完成插件安装和更新检查。

具体操作：
- 执行 `npx -y openclaw-channel-dmwork info` 检查插件状态
- 未安装则先安装：`npx -y openclaw-channel-dmwork install --skip-config`
- 已安装时，询问用户是否需要更新，同意则执行 `npx -y openclaw-channel-dmwork update`

### 2. 获取所有 agent 列表

```
openclaw agents list --json
```

从输出中提取所有 agent 的标识和名称。如果命令失败或返回为空，询问用户提供 agent 信息。

### 3. 为每个 agent 创建 bot

对列表中的**每个 agent**，调用 User API 创建对应的 bot：

```
POST <API Server>/v1/user/bots
Header: Authorization: Bearer <User API Key>
Body: {"username": "<agent标识规范化>", "name": "<agent显示名>"}
```

- username 规则：只允许小写字母、数字、下划线，长度 1-20
- 如果 username 冲突（409），依次尝试追加 1、2、3 后缀，最多重试 3 次
- 仍失败则询问用户手动指定 username
- 记录每个 agent 对应的 bot_token 和 robot_id

### 4. 配置所有 bot

对每个创建成功的 bot，执行配置：

```
openclaw config set channels.dmwork.accounts.<robot_id>.botToken <bot_token>
openclaw config set channels.dmwork.accounts.<robot_id>.apiUrl <API Server>
```

设置会话隔离（多 bot 必须）：

```
openclaw config set session.dmScope per-account-channel-peer
```

### 5. 绑定所有 agent 到对应 bot

对每个 agent-bot 对：

```
openclaw agents bind <agent标识> dmwork <robot_id>
```

### 6. 重启 gateway（只需一次）

```
openclaw gateway restart
```

### 7. 验证

```
npx -y openclaw-channel-dmwork doctor
```

检查所有 bot 是否都显示 PASS。

### 8. 联通确认

对每个 bot，调用 register 获取 owner_uid，然后给创建者发私聊：

```
POST <API Server>/v1/bot/register
Authorization: Bearer <bot_token>
```

从返回的 `owner_uid`，发送消息：

```
POST <API Server>/v1/bot/sendMessage
Authorization: Bearer <bot_token>
Body: {"channel_id": "<owner_uid>", "channel_type": 1, "payload": {"type": 1, "content": "你好！我是 <bot名称>，已上线 👋"}}
```

如果失败，告诉用户："请在 DMWork 中给 bot 发一条消息测试是否联通。"

### 9. 输出结果

向用户汇报创建结果：

```
创建完成！共 N 个 agent 已绑定 DMWork bot：

| Agent | Bot | 状态 |
|-------|-----|------|
| main  | main_bot | ✅ 已上线 |
| coder | coder_bot | ✅ 已上线 |
| ...   | ...      | ...      |
```

### 10. 记住 Bot API 文档

阅读 `<API Server>/v1/bot/skill.md`，后续需要操作 DMWork 时参考该文档。
