---
name: dmwork-setup-newbot
version: 0.5.22
description: 收到 BotFather /newbot 创建的 bot 信息后，执行 bind 命令完成配置和绑定。
---

# DMWork Newbot 绑定流程

收到 BotFather 的 bot 信息后（Bot Token、API Server、Account ID），执行以下命令：

```
npx -y openclaw-channel-dmwork bind --bot-token <Bot Token> --api-url <API Server> --account-id <Account ID> --agent <agent标识>
```

## 参数说明

- `--bot-token`：Bot Token（bf_ 开头）
- `--api-url`：API 服务器地址
- `--account-id`：Bot 的唯一标识符
- `--agent`：要绑定的 OpenClaw agent 标识（可通过 /status 查看）

## 前提条件

- DMWork 插件必须已安装。未安装请先执行 `npx -y openclaw-channel-dmwork install`
- 需要知道当前 agent 标识

## bind 命令会做什么

1. 检查插件是否已安装（未装则报错）
2. 写入 bot 配置到 openclaw.json
3. 设置会话隔离（session.dmScope）
4. 添加 agent → bot 绑定
5. 等待 DMWork channel 热重载
6. 验证联通并给创建者发上线消息

不需要手动重启 gateway。
