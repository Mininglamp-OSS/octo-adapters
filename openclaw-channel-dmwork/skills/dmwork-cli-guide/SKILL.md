---
name: dmwork-cli-guide
version: 0.5.22
description: DMWork 插件安装、更新、诊断修复的命令指南。被 dmwork-setup-newbot 和 dmwork-setup-quickstart 引用。
---

# DMWork CLI 操作指南

本文档面向 OpenClaw 模型，提供 DMWork 插件的安装、更新、诊断和管理命令。

## 安装插件

```
npx -y openclaw-channel-dmwork install --bot-token <token> --api-url <api_url> --account-id <account_id>
```

install 是幂等的：已安装时跳过插件安装，继续配置账号。可安全重复执行。

也可以不带参数运行（交互模式，按提示输入）：

```
npx -y openclaw-channel-dmwork install
```

## 更新插件

```
npx -y openclaw-channel-dmwork update
```

已是最新版本会自动跳过。**更新前必须先询问用户是否同意。**

## 检查插件状态

```
npx -y openclaw-channel-dmwork info
```

显示 CLI 版本、OpenClaw 版本、插件安装版本。

## 诊断健康状态

```
npx -y openclaw-channel-dmwork doctor
```

检查指定账号：

```
npx -y openclaw-channel-dmwork doctor --account-id <account_id>
```

## 自动修复

```
npx -y openclaw-channel-dmwork doctor --fix
```

能自动修复的问题标记为 `[FIXED]`，无法修复的标记为 `[FAIL]`。

## 删除单个 bot 配置

```
npx -y openclaw-channel-dmwork remove-account --account-id <account_id>
```

只删除指定 bot，不影响其他 bot 和插件。**删除前必须先询问用户。**

## 卸载插件

```
npx -y openclaw-channel-dmwork uninstall
```

卸载插件并删除全部 bot 配置。

## 命令速查

| 命令 | 用途 |
|------|------|
| `npx -y openclaw-channel-dmwork install` | 安装插件并配置 bot（幂等） |
| `npx -y openclaw-channel-dmwork update` | 更新到最新版本 |
| `npx -y openclaw-channel-dmwork doctor` | 诊断健康状态 |
| `npx -y openclaw-channel-dmwork doctor --fix` | 自动修复问题 |
| `npx -y openclaw-channel-dmwork info` | 显示版本信息 |
| `npx -y openclaw-channel-dmwork uninstall` | 卸载插件 |
| `npx -y openclaw-channel-dmwork remove-account --account-id <id>` | 删除单个 bot |

## 注意事项

- **更新插件前必须先询问用户**，不要自动更新
- **删除 bot 前必须先询问用户**
- 不要手动编辑 `~/.openclaw/openclaw.json`
- 不要手动删除 `~/.openclaw/extensions/` 下的目录
- 遇到安装/配置问题，先执行 `doctor --fix` 尝试自动修复
