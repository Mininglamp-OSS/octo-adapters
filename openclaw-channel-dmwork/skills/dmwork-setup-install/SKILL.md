---
name: dmwork-setup-install
version: 0.5.22
description: DMWork 插件安装和更新。执行 npx -y openclaw-channel-dmwork install 即可完成安装或更新。
---

# DMWork 插件安装/更新

## 安装插件

```
npx -y openclaw-channel-dmwork install
```

- 未安装 → 自动安装最新版并重启 gateway
- 已安装且有新版本 → 自动更新并重启 gateway
- 已安装且是最新 → 提示已是最新

## 更新插件（别名）

```
npx -y openclaw-channel-dmwork update
```

与 install 逻辑完全相同。

## 强制重装

```
npx -y openclaw-channel-dmwork install --force
```

## 诊断

```
npx -y openclaw-channel-dmwork doctor
npx -y openclaw-channel-dmwork doctor --fix
```

## 查看版本

```
npx -y openclaw-channel-dmwork info
```

## 注意事项

- install/update 只管插件环境，不会创建或配置 bot
- 安装完成后使用 `bind` 或 `quickstart` 命令配置 bot
- 不要手动编辑 `~/.openclaw/openclaw.json`
- 不要手动删除 `~/.openclaw/extensions/` 下的目录
