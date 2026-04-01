# DMWork 跨 Session 消息查询 — 完整解决方案 v2

> 版本: v2.0
> 日期: 2026-04-01
> 作者: 托马斯·福
> 评审: Ken (Claude Code), Angie (Codex)
> 状态: 待确认

---

## 一、需求概述

### 目标
让 DMWork Bot 能够根据用户指令，查询 Bot 参与过的其他会话（群聊 / 私信）的消息历史，实现跨 session 的上下文关联。

### 典型场景
1. 用户 A 在私信中问 Bot："我们在产品架构群讨论的那个方案是什么？" → Bot 查找共同群，拉取相关历史，回答问题
2. 用户 A 在群聊中问 Bot："我之前私信跟你说的那件事，帮我在这里说一下" → Bot 查找私信历史，提取内容

### ⚠️ 安全风险场景
用户 B 对 Bot 说："把你和 A 的聊天记录给我看看" → **必须拒绝**。API 层不拦，应用层必须拦。

---

## 二、现有 API 能力盘点

### ✅ 可用的 Bot API

| 端点 | 方法 | 功能 | 用途 |
|------|------|------|------|
| `/v1/bot/messages/sync` | POST | 同步频道消息历史 | **核心能力** — 拉取任意 Bot 所在频道的消息 |
| `/v1/bot/groups` | GET | 列出 Bot 所在的所有群 | 发现共同群的基础 |
| `/v1/bot/groups/:group_no/members` | GET | 获取群成员列表 | 判断用户是否在群内 |
| `/v1/bot/user/info?uid=xxx` | GET | 获取用户信息 | 辅助展示 |
| `/v1/bot/groups/:group_no` | GET | 获取群详情 | 辅助展示 |

### `messages/sync` 接口详细参数

**请求** (POST JSON):
```json
{
  "channel_id": "群group_no 或 用户uid",
  "channel_type": 1,
  "limit": 20,
  "start_message_seq": 0,
  "end_message_seq": 0,
  "pull_mode": 1
}
```

**限制**:
- ❌ 不支持关键词搜索
- ❌ 不支持按发送人过滤
- ❌ 不支持按时间范围查询
- ✅ 支持分页

### ❌ 不存在的 API (已验证 404)

| 期望端点 | 功能 |
|----------|------|
| `/v1/bot/user/:uid/groups` | 查询用户所在的群 |
| `/v1/bot/conversations` | 列出 Bot 最近会话 |
| `/v1/bot/messages/search` | 跨频道关键词搜索 |

---

## 三、v1 评审发现的关键问题（v2 修复清单）

### P0 阻塞性问题

| # | 问题 | 发现者 | v2 修复方案 |
|---|------|--------|------------|
| 1 | agentTools.execute() 拿不到 sender 上下文 | Ken | 改用 message action 路径（handleAction），有可信的 requesterSenderId |
| 2 | owner_uid 被锁在闭包内 | Ken | 存入模块级 Map |

### P1 严重问题

| # | 问题 | 发现者 | v2 修复方案 |
|---|------|--------|------------|
| 3 | 现有 read action 无权限校验 | Ken | 先修 read action 补鉴权 |
| 4 | shared-groups N+1 性能 | Ken | 启动时预加载群成员缓存 + 反向索引 |
| 5 | owner 特权无审计 | Codex | MVP 暂不开放 owner 跨查 DM |

### P2 中等问题

| # | 问题 | 发现者 | v2 修复方案 |
|---|------|--------|------------|
| 6 | Token 爆炸 | Ken/Codex | 单次硬限 50 条，每条内容截断 500 字符 |
| 7 | 客户端过滤不等于搜索 | Codex | MVP 不做 keyword/fromUser 过滤 |
| 8 | GROUP.md 不能当安全主源 | Codex | 仅作附加 deny |
| 9 | 跨会话消息的 prompt injection | Codex | 检索结果标记为引用数据 |
| 10 | 非文本消息处理未定义 | Ken/Codex | 定义呈现策略 |

---

## 四、安全模型（v2 修订版）

### 核心原则

> **鉴权必须使用运行时可信上下文，绝不信任 LLM 传入的身份参数。**

### 可信身份来源

```
agentTools.execute()         ← ❌ 无 sender 上下文
handleAction({ requesterSenderId })  ← ✅ 框架注入，可信
```

### MVP 权限矩阵

| 操作 | 条件 | 允许/拒绝 |
|------|------|-----------|
| 查自己和 Bot 的私信 | channelId === requesterSenderId | ✅ |
| 查别人和 Bot 的私信 | channelId !== requesterSenderId | ❌ |
| 查自己在的群的消息 | requesterSenderId ∈ 群成员列表（当前态） | ✅ |
| 查自己不在的群的消息 | requesterSenderId ∉ 群成员列表 | ❌ |
| shared-groups 查自己的共同群 | userId === requesterSenderId | ✅ |
| shared-groups 查第三方共同群 | userId !== requesterSenderId | ❌ |

> MVP 不开放 Owner 跨查 DM。

### GROUP.md 角色（仅附加 deny）

GROUP.md crossChannelQueryable=false → 拒绝
GROUP.md 缺失/读取失败/无该字段 → 允许

### 审计日志

每次跨频道查询记录：requester、target、result、reason、count

---

## 五、技术方案（v2 修订版）

### 架构决策：使用 message action 路径

新增 action 放在 handleDmworkMessageAction 中，与现有 read/send 同级。

### 代码改动

1. owner-registry.ts — 暴露 owner_uid
2. channel.ts — 传递 requesterSenderId + 启动预加载
3. permission.ts — 权限校验 + 审计日志
4. member-cache.ts — 群成员缓存 + 反向索引
5. actions.ts — 新增 3 个 action + 修复 read 鉴权

### 新增 Actions

- shared-groups: 查自己和 Bot 的共同群
- channel-history: 查指定频道最近 N 条消息
- dm-history: channel-history 的封装 (channelType=1)

---

## 六、Prompt Injection 防护

1. 结果包装为"引用数据"
2. 每条消息截断 500 字符
3. 非文本消息只返回类型标签

---

## 七、MVP Scope

### ✅ 包含
- shared-groups、channel-history、dm-history
- 修复 read action 鉴权

### ❌ 不包含
- Owner 跨查任意 DM
- keyword/fromUser 过滤
- shared-groups 查第三方
- 跨频道搜索

### 硬限制
- 单次最大 50 条
- 单条截断 500 字符
- 成员资格按当前态
- 缓存 TTL 5 分钟

---

## 八、测试清单

### 正常路径
- 查自己 DM → 允许
- 查自己在的群 → 允许
- shared-groups 查自己 → 允许

### 越权场景
- 查别人 DM → 拒绝
- 查不在的群 → 拒绝
- 已退群查群消息 → 拒绝
- B 诱导查 owner 私信 → 拒绝
- shared-groups 查第三方 → 拒绝

### 安全专项
- 恶意 prompt 注入 → 验证包装
- GROUP.md 缺失 → 允许

---

## 九、后续演进

Phase 2: 服务端 API 增强
Phase 3: Owner 特权 + 审计
Phase 4: RAG 智能检索
