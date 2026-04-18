---
name: dmwork-setup-quickstart
version: 0.5.22
description: 收到 BotFather /quickstart 的 API Key 后，执行 quickstart 命令为所有 agent 批量创建并绑定 bot。
---

# DMWork Quickstart 流程

收到 BotFather 的 User API Key 和 API Server 后，执行以下命令：

```
npx -y openclaw-channel-dmwork quickstart --api-key <User API Key> --api-url <API Server>
```

## 前提条件

- DMWork 插件必须已安装。未安装请先执行 `npx -y openclaw-channel-dmwork install`

## quickstart 命令会做什么

1. 检查插件是否已安装（未装则报错）
2. 获取 OpenClaw 的所有 agent 列表
3. 为每个 agent 创建一个 DMWork bot
   - 命名规则：`<agent标识>_bot`
   - 冲突时尝试 `<agent>_2_bot`、`<agent>_3_bot`
4. 一次性写入所有 bot 配置和绑定
5. 设置会话隔离（session.dmScope）
6. 等待 DMWork channel 热重载
7. 验证联通并给创建者发上线消息
8. 输出结果清单

不需要手动重启 gateway。

## 注意

- quickstart 是一次性初始化工具，面向首次接入 DMWork 的用户
- 不做已有 bot 判定，不保证重复执行幂等
