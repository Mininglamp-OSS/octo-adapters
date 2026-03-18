# DMWork Adapters

DMWork 即时通讯平台的 AI 适配器集合，让 AI Agent 和聊天机器人能够通过 DMWork Bot API 进行通信。

## 适配器列表

### claude-code-dmwork-ws

基于 WebSocket 的网关，连接 [Claude Agent SDK](https://github.com/anthropics/claude-code) 到 DMWork 即时通讯。

- WuKongIM 二进制协议（DH 密钥交换 + AES-CBC 加密）
- 实时消息收发（延迟 < 100ms）
- 流式回复（DMWork stream API，自动降级为普通消息）
- DM + 群聊支持（上下文感知的 @mention 触发）
- 会话持久化（滑动窗口历史）
- 自动重连 + Token 刷新

详见 [claude-code-dmwork-ws/README.md](claude-code-dmwork-ws/README.md)。

### openclaw-channel-dmwork

面向 [OpenClaw](https://github.com/nicepkg/openclaw) AI 框架的 channel 插件，通过悟空IM WebSocket 实现实时通信。

- 基于 WebSocket 的实时消息接收
- 断线自动重连
- 支持流式响应、输入状态提示和已读回执
- 完整的 OpenClaw 插件生命周期集成

详见 [openclaw-channel-dmwork/README.md](openclaw-channel-dmwork/README.md)。

## 前置条件

- 运行中的 DMWork 服务端，且已启用 BotFather 模块
- 通过 BotFather 创建的机器人（在 DMWork 中向 BotFather 发送 `/newbot` 或 `/quickstart`）

## 许可证

MIT
