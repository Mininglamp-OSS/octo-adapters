---
name: dmwork-setup-quickstart
version: 0.5.22
description: 收到 [DMWORK QUICKSTART] 消息时，按此流程安装插件、创建 bot、配置绑定、验证联通。
---

# DMWork Quickstart 设置流程

收到包含 `[DMWORK QUICKSTART]` 的消息时，按以下步骤操作。
消息中包含 User API Key 和 API Server 两个参数。

## 步骤

### 1. 安装/更新插件

阅读 `<API Server>/v1/bot/cli-guide.md` 完成插件安装和更新检查。

具体操作：
- 执行 `npx -y openclaw-channel-dmwork info` 检查插件状态
- 未安装则先安装：`npx -y openclaw-channel-dmwork install --skip-config`
- 已安装时，询问用户是否需要更新，同意则执行 `npx -y openclaw-channel-dmwork update`

### 2. 获取当前 agent 标识

执行 `/status`，从输出中提取 agent 标识。

**如果无法解析，停止并询问用户 agent 名称。**

### 3. 创建 bot

阅读 `<API Server>/v1/bot/skill.md` 的 User API 部分了解完整文档。

```
POST <API Server>/v1/user/bots
Header: Authorization: Bearer <User API Key>
Body: {"username": "<agent标识规范化>", "name": "<agent显示名>"}
```

- username 规则：只允许小写字母、数字、下划线，长度 1-20
- 如果 username 冲突（409），依次尝试追加 1、2、3 后缀，最多重试 3 次
- 仍失败则询问用户手动指定 username

### 4. 配置 bot

拿到响应中的 bot_token 和 robot_id 后，通过 install 配置账号（install 是幂等的，已安装时跳过安装、继续配置）：

```
npx -y openclaw-channel-dmwork install --bot-token <bot_token> --api-url <API Server> --account-id <robot_id>
```

### 5. 绑定 agent 到 bot

```
openclaw agents bind <agent标识> dmwork <robot_id>
```

### 6. 重启 gateway

```
openclaw gateway restart
```

### 7. 验证

```
npx -y openclaw-channel-dmwork doctor --account-id <robot_id>
```

### 8. 联通确认

告诉用户："配置完成！请在 DMWork 中给 bot 发一条消息测试是否联通。"

### 9. 记住 Bot API 文档

阅读 `<API Server>/v1/bot/skill.md`，后续需要操作 DMWork 时参考该文档。
