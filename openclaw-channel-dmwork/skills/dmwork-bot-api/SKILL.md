---
name: dmwork-bot-api
version: 0.5.22
description: DMWork Bot API 文档。消息发送、群管理、Thread、文件上传、User API（创建/管理 bot）等接口。API 基础地址从 OpenClaw 配置 channels.dmwork.accounts.<id>.apiUrl 获取。
---

# DMWork Bot API

所有 API 请求需要 `Authorization: Bearer <bot_token>` 头。
API 基础地址从 OpenClaw 配置 `channels.dmwork.accounts.<accountId>.apiUrl` 获取。

## Channel Types

| channel_type | Target | channel_id 格式 |
|---|---|---|
| 1 | DM（私聊） | user UID |
| 2 | Group（群聊） | group_no |
| 5 | Thread（子区/子话题） | {group_no}____{short_id}（4 个下划线） |

**重要：** 回复消息时，直接使用收到事件中的 `channel_id` 和 `channel_type`，不要修改或拆分。

## 发送消息

```
POST <apiUrl>/v1/bot/sendMessage
Body: {
  "channel_id": "<target_id>",
  "channel_type": <1|2|5>,
  "payload": {"type": 1, "content": "Hello!"}
}
```

## Typing 指示

处理消息前调用，让用户看到"正在输入..."：

```
POST <apiUrl>/v1/bot/typing
Body: {"channel_id": "<id>", "channel_type": <type>}
```

## Streaming 响应

长回复使用流式输出，每次发送**完整累积文本**（非增量）：

```
// 1. 开始 stream
POST <apiUrl>/v1/bot/stream/start
Body: {"channel_id": "<id>", "channel_type": <type>, "payload": "<base64>"}
Response: {"stream_no": "xxx"}

// 2. 发送累积文本（重复调用）
POST <apiUrl>/v1/bot/sendMessage
Body: {"channel_id": "<id>", "channel_type": <type>, "stream_no": "xxx",
       "payload": {"type": 1, "content": "完整累积文本..."}}

// 3. 结束 stream
POST <apiUrl>/v1/bot/stream/end
Body: {"stream_no": "xxx", "channel_id": "<id>", "channel_type": <type>}
```

## Heartbeat

每 30 秒发送一次，保持 bot 在线状态：

```
POST <apiUrl>/v1/bot/heartbeat
```

## 已读回执

```
POST <apiUrl>/v1/bot/readReceipt
Body: {"channel_id": "<id>", "channel_type": <type>}
```

## Event 格式

### DM Event（channel_id 和 channel_type 缺失）

```json
{
  "event_id": 101,
  "message": {
    "message_id": 1001,
    "from_uid": "user_abc",
    "payload": {"type": 1, "content": "Hi bot!"},
    "timestamp": 1700000000
  }
}
```

回复目标：`from_uid` 作为 `channel_id`，`channel_type = 1`

### Group Event（channel_type = 2）

```json
{
  "event_id": 102,
  "message": {
    "message_id": 1002,
    "from_uid": "user_xyz",
    "channel_id": "group_123",
    "channel_type": 2,
    "payload": {"type": 1, "content": "@bot hello"},
    "timestamp": 1700000000
  }
}
```

回复目标：直接使用 `channel_id` 和 `channel_type`

### Thread Event（channel_type = 5）

```json
{
  "event_id": 103,
  "message": {
    "message_id": 1003,
    "from_uid": "user_xyz",
    "channel_id": "group_123____2044043250838278144",
    "channel_type": 5,
    "payload": {"type": 1, "content": "@bot check this"},
    "timestamp": 1700000000
  }
}
```

回复目标：直接使用 `channel_id` 和 `channel_type`，不要拆分 channel_id

### 检测规则

```
if channel_id 缺失或为空         → DM     → 回复 (from_uid, channel_type=1)
if channel_type == 5 (含 ____)  → Thread → 回复 (channel_id, channel_type=5)
if channel_id 存在              → Group  → 回复 (channel_id, channel_type=2)
```

## 文件上传

```
POST <apiUrl>/v1/file/upload
Header: Authorization: Bearer <bot_token>
Content-Type: multipart/form-data
Form: file=@<filepath>
Response: {"path": "/file/preview/chat/.../filename.ext"}
```

完整 URL = `<apiUrl>` + response.path

### 发送文件消息（type=8）

```json
{
  "channel_id": "<id>",
  "channel_type": <type>,
  "payload": {
    "type": 8,
    "url": "<完整文件URL>",
    "name": "report.pdf",
    "size": 102400
  }
}
```

### 发送图片消息（type=2）

```json
{
  "channel_id": "<id>",
  "channel_type": <type>,
  "payload": {
    "type": 2,
    "url": "<完整图片URL>",
    "width": 800,
    "height": 600
  }
}
```

## 群管理 API

| 端点 | 用途 |
|------|------|
| `POST /v1/bot/groups` | 创建群 |
| `GET /v1/bot/groups/:group_no` | 获取群信息 |
| `PUT /v1/bot/groups/:group_no` | 更新群设置 |
| `GET /v1/bot/groups/:group_no/members` | 列出群成员 |
| `POST /v1/bot/groups/:group_no/members/add` | 添加成员 |
| `POST /v1/bot/groups/:group_no/members/remove` | 移除成员 |

### 创建群

```
POST <apiUrl>/v1/bot/groups
Body: {"name": "群名称", "members": ["uid1", "uid2"]}
Response: {"group_no": "xxx"}
```

## Thread API

Bot 必须是群成员才能使用 Thread API。

| 端点 | 用途 |
|------|------|
| `POST /v1/bot/groups/:group_no/threads` | 创建子区 |
| `GET /v1/bot/groups/:group_no/threads` | 列出子区 |
| `GET /v1/bot/groups/:group_no/threads/:short_id` | 子区详情 |
| `DELETE /v1/bot/groups/:group_no/threads/:short_id` | 删除子区 |
| `GET /v1/bot/groups/:group_no/threads/:short_id/members` | 子区成员 |
| `POST /v1/bot/groups/:group_no/threads/:short_id/join` | 加入子区 |
| `POST /v1/bot/groups/:group_no/threads/:short_id/leave` | 离开子区 |

## User API（Bot 管理）

使用 User API Key（`uk_` 前缀）认证，不是 Bot Token。

### 创建 Bot

```
POST <apiUrl>/v1/user/bots
Header: Authorization: Bearer <user_api_key>
Body: {"username": "mybot", "name": "My Bot"}
Response: {"robot_id": "mybot_bot", "username": "mybot_bot", "name": "My Bot", "bot_token": "bf_xxx"}
```

### 列出 Bot

```
GET <apiUrl>/v1/user/bots
Header: Authorization: Bearer <user_api_key>
Response: [{"robot_id": "mybot_bot", "username": "mybot_bot", "name": "My Bot", "status": 1}]
```

### 删除 Bot

```
DELETE <apiUrl>/v1/user/bots/<robot_id>
Header: Authorization: Bearer <user_api_key>
```

## 消息历史同步

```
POST <apiUrl>/v1/bot/messages/sync
Body: {
  "channel_id": "<id>",
  "channel_type": <type>,
  "start_message_seq": 0,
  "end_message_seq": 0,
  "limit": 50,
  "pull_mode": 1
}
```

## 错误处理

- 401: Token 无效或过期
- 403: 权限不足（如非群管理员）
- 404: 资源不存在
- 409: 资源冲突（如 username 重复）
- 429: 请求过于频繁
