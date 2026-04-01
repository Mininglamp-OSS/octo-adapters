# DMWork 跨 Session 消息查询 — 完整解决方案

> 版本: v1.0
> 日期: 2026-04-01
> 作者: 托马斯·福
> 状态: 待评审

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
  "channel_type": 1,           // 1=私信, 2=群聊
  "limit": 20,                 // 拉取条数, 默认20
  "start_message_seq": 0,      // 起始消息序号 (0=从头)
  "end_message_seq": 0,        // 结束消息序号 (0=不限)
  "pull_mode": 1               // 1=向上拉新消息
}
```

**响应**:
```json
{
  "messages": [
    {
      "message_id": "...",
      "from_uid": "发送人uid",
      "payload": "base64编码的JSON",
      "timestamp": 1711929600
    }
  ]
}
```

**限制**:
- ❌ 不支持关键词搜索 — 只能按消息序号范围 + 条数拉取
- ❌ 不支持按发送人过滤 — 需客户端侧筛选
- ❌ 不支持按时间范围查询 — 需通过 message_seq 间接定位
- ✅ 支持分页 — 通过 start_message_seq / end_message_seq 实现

### ❌ 不存在的 API (已验证 404)

| 期望端点 | 功能 |
|----------|------|
| `/v1/bot/user/:uid/groups` | 查询用户所在的群 |
| `/v1/bot/conversations` | 列出 Bot 最近会话 |
| `/v1/bot/messages/search` | 跨频道关键词搜索 |

---

## 三、安全模型

### API 层安全（WuKongIM 底层保证）

| 安全边界 | 说明 |
|----------|------|
| Bot 只能查自己所在的频道 | 传不在的群 group_no → 服务端拒绝 |
| 私信只能看 Bot 自己的 DM | channel_type=1 只返回 Bot 与该用户的会话 |
| Token 绑定身份 | botToken 绑定 robot_id，服务端基于此做权限校验 |

### ⚠️ API 层不管的（应用层必须管）

**核心风险**：`messages/sync` 的鉴权只认 botToken，**不关心是谁触发的调用**。

```
用户B → 私信Bot："查一下你和A的聊天记录"
         ↓
Bot 调 messages/sync(channel_id=A的uid, channel_type=1)
         ↓
API 返回 200 ✅ (Bot确实在这个DM频道里)
         ↓
Bot 把A的隐私数据泄露给B ❌❌❌
```

### 应用层安全策略（方案 ①+②）

#### 策略①：谁问的只能查谁相关的

```
规则: 查询请求的发起人(sender_uid) 必须是目标频道的参与者

验证逻辑:
├─ 查群消息 → sender_uid 必须是该群的成员
├─ 查私信 → channel_id 必须等于 sender_uid (只能查自己和Bot的私信)
└─ 违反 → 拒绝并返回 "无权限查询该频道"
```

#### 策略②：Owner 特权

```
规则: Bot 的 owner 拥有更高查询权限

Owner 权限:
├─ 可查询 Bot 与任何用户的私信历史
├─ 可查询 Bot 所在的任何群的消息历史
└─ 可跨频道搜索

普通用户权限:
├─ 只能查自己和 Bot 的私信
├─ 只能查自己也在的共同群
└─ 不能查其他人和 Bot 的私信
```

#### 策略③：GROUP.md 精细控制（可选增强）

```markdown
# 某群的 GROUP.md
- crossChannelQueryable: false  # 本群消息禁止被跨频道引用
```

---

## 四、技术方案

### 新增 Agent Tool Actions

在 `dmwork_management` tool 中新增 3 个 action：

#### Action 1: `shared-groups`
查询 Bot 与指定用户的共同群组。

#### Action 2: `channel-history`
查询指定频道的消息历史。

#### Action 3: `dm-history`
查询与指定用户的私信历史（channel-history 的便捷封装）。

---

## 五、代码改动范围

```
dmwork-adapters/
├── src/
│   ├── agent-tools.ts     ← 主要改动：新增 3 个 action handler
│   ├── api-fetch.ts       ← 无需改动 (getChannelMessages 已存在)
│   ├── types.ts           ← 可能新增类型定义
│   └── inbound.ts         ← 无需改动
└── tests/
    └── agent-tools.test.ts ← 新增测试用例
```

### 预估工作量：1-2 天

---

## 六、后续演进

### Phase 2：推动服务端 API 增强
- `GET /v1/bot/user/:uid/shared-groups`
- `GET /v1/bot/conversations`
- `POST /v1/bot/messages/search`

### Phase 3：智能上下文增强
- RAG 式检索 + 向量搜索
