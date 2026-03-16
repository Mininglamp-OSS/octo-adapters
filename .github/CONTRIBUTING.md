# 贡献指南

感谢你对本项目的关注！请在提交代码前阅读以下规范。

## 分支命名

从 `main` 创建分支，使用以下前缀：

| 前缀 | 用途 | 示例 |
|------|------|------|
| `feat/` | 新功能 | `feat/wechat-image-support` |
| `fix/` | 缺陷修复 | `fix/message-parse-error` |
| `chore/` | 构建、CI、文档等杂项 | `chore/update-deps` |
| `refactor/` | 重构（不改变行为） | `refactor/extract-parser` |
| `docs/` | 仅文档变更 | `docs/contributing` |

## Commit 规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：

```
<type>(<scope>): <description>

[可选正文]

[可选脚注]
```

**type** 与分支前缀一致：`feat` / `fix` / `chore` / `refactor` / `docs` / `test` / `ci`

示例：

```
feat(wechat): 支持发送图片消息
fix(dingtalk): 修复群聊消息丢失问题
chore: 升级 TypeScript 至 5.x
```

注意事项：
- 使用中文或英文描述均可，项目内保持一致
- 每个 commit 只做一件事
- 描述写「做了什么」，而非「改了什么文件」

## PR 流程

1. **创建分支** — 从最新的 `main` 拉取并创建功能分支
2. **本地开发** — 编写代码，确保测试通过
3. **推送并创建 PR** — 推送到远程，通过 GitHub 创建 Pull Request
4. **Code Review** — 至少需要一位维护者审批
5. **合并** — 审批通过后由维护者合并到 `main`

### PR 要求

- 标题遵循 Commit 规范（如 `feat(wechat): 支持图片消息`）
- 描述中说明改动目的和测试方式
- 保持 PR 尽量小，便于 Review
- 确保 CI 检查全部通过

## 开发环境

```bash
# 安装依赖
npm install

# 运行测试
npm test

# 代码检查
npm run lint
```

## 问题反馈

- 使用 [Issue](../../issues) 报告 Bug 或提出建议
- Bug 报告请使用 Issue 模板，提供复现步骤
