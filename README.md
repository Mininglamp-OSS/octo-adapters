# DMWork Adapters

[DMWork](https://github.com/TangSengDaoDao/TangSengDaoDaoServer) 即时通讯平台的 AI 适配器集合，让 AI Agent 和聊天机器人能够通过 DMWork Bot API 进行通信。

## 适配器列表

### claude-code-dmwork

面向 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 等 AI Agent 的轻量级 REST 适配器。

- **SKILL.md** — Bot API 参考文档，Claude Code 可作为 skill 加载后直接与 DMWork 交互
- **dmwork-poll.sh** — Bash 轮询脚本，注册机器人、轮询消息并输出到 stdout

使用方式：
```bash
./claude-code-dmwork/dmwork-poll.sh http://your-server:8090 bf_your_bot_token
```

### openclaw-channel-dmwork

面向 [OpenClaw](https://github.com/nicepkg/openclaw) AI 框架的 channel 插件，通过悟空IM WebSocket 实现实时通信。

- 基于 WebSocket 的实时消息接收
- 断线自动重连
- 支持流式响应、输入状态提示和已读回执
- 完整的 OpenClaw 插件生命周期集成

详见 [openclaw-channel-dmwork/README.md](openclaw-channel-dmwork/README.md)。

## 前置条件

- 运行中的 DMWork 服务端，且已启用 BotFather 模块
- 通过 BotFather 创建的机器人（在 DMWork 中向 BotFather 发送 `/newbot`）

## 许可证

MIT
