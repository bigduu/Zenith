# Bamboo ↔ Lotus `message_count_mismatch` 根因分析报告

## 结论摘要

这次 `useMessageStreaming` 中的：

- `need_sync: true`
- `reason: "message_count_mismatch"`
- `server_message_count: 52`

**核心根因并不是 root session 与 child session 的消息被直接混算**，而是：

> **bamboo 的 execute 同步校验使用“完整 session.messages”计数，而 history 接口返回给 lotus 时会过滤 `hidden_from_ui` 消息。**
>
> 当 root session 中包含由 child completion 注入的隐藏 runtime-resume 消息时，服务端 execute 看到的是 52 条，而 lotus 从 history 恢复后只能看到 50 条，于是每次 recovery 后发出的 `client_sync.client_message_count` 仍然偏小，导致连续 2 次 recovery 之后依然 out-of-sync。

这是一种**协议口径不一致**问题：

- `execute` sync snapshot 口径：**全量消息**
- `history` / `loadChatHistory` / `syncCursor` 口径：**UI可见消息**

因此 recovery 永远无法收敛。

---

## 1. 现象与错误信息

用户看到的错误：

- `message_count_mismatch`
- `server_message_count: 52`
- `has_pending_user_message: true`

lotus 在 `useMessageStreaming` 里遇到 `need_sync` 时，会最多做 2 次恢复，然后仍失败：

- `lotus/src/pages/ChatPage/hooks/useChatManager/useMessageStreaming.ts:242-265`

关键逻辑：
- `while (resolvedExecuteResult.sync?.need_sync && syncRecoveries < maxSyncRecoveries)`
- 恢复后再次 `execute`
- 若仍 `need_sync`，打印：
  - `Execute remains out-of-sync after 2 recovery attempt(s)`

---

## 2. lotus 侧同步游标的来源

### 2.1 execute 时 lotus 发什么

lotus 构造 `client_sync` 的代码在：

- `lotus/src/pages/ChatPage/hooks/useChatManager/useMessageStreaming.ts:97-121`

```ts
return {
  client_message_count: syncCursor?.messageCount ?? chat?.messageCount ?? 0,
  client_last_message_id: syncCursor?.lastMessageId ?? null,
  client_has_pending_question: hasPendingQuestion,
  client_pending_question_tool_call_id: pendingQuestionToolCallId,
};
```

也就是说，lotus execute 的同步状态完全依赖：

- `chat.messageCount`
- `chat.config.syncCursor`

### 2.2 recovery 时 lotus 如何刷新

恢复逻辑在：

- `lotus/src/pages/ChatPage/hooks/useChatManager/useMessageStreaming.ts:163-229`

关键步骤：
1. `loadChatHistory(sessionId, { mode: "replace" })`
2. 根据 history 结果重建 chat.messages / messageCount / syncCursor
3. 再次调用 `execute(... buildClientSync(sessionId) ...)`

也就是说：

> **recovery 的收敛前提，是 history 接口返回出来的 messageCount / lastMessageId 与 execute 的服务端 snapshot 口径一致。**

如果两边口径不同，恢复永远不会成功。

---

## 3. lotus `loadChatHistory()` 的计数口径

`loadChatHistory()` 位于：

- `lotus/src/pages/ChatPage/store/slices/chatSessionSlice.ts:1030-1110`

它会把 history 返回值写入本地：

- `messages: nextMessages`
- `messageCount: history.messages.length`
- `syncCursor.messageCount: history.messages.length`
- `syncCursor.lastMessageId: history.messages[history.messages.length - 1]?.id`

关键代码：

- `lotus/src/pages/ChatPage/store/slices/chatSessionSlice.ts:1088-1107`

```ts
get().updateSession(sessionId, {
  messages: nextMessages,
  messageCount: history.messages.length,
  config: {
    ...(chat.config || {}),
    syncCursor: {
      messageCount: history.messages.length,
      lastMessageId: history.messages[history.messages.length - 1]?.id ?? null,
      ...
    },
  },
});
```

因此：

> **lotus 的 syncCursor/messageCount 完全等于 history API 返回的消息条数。**

---

## 4. bamboo execute 的同步校验口径

### 4.1 execute 先做 sync check

`prepare_execute()` 在：

- `bamboo/crates/bamboo-server/src/session_app/execute.rs:22-42`

```rs
let server_snapshot = ServerExecuteSnapshot::from_session(&session);

if let Some(reason) = evaluate_client_sync(input.client_sync.as_ref(), &server_snapshot) {
    return Ok(ExecutePreparationOutcome::SyncMismatch {
        reason,
        server_snapshot,
    });
}
```

### 4.2 `message_count_mismatch` 的判定

`evaluate_client_sync()` 在：

- `bamboo/crates/bamboo-server/src/session_app/execute.rs:217-265`

关键判断：

- `bamboo/crates/bamboo-server/src/session_app/execute.rs:245-247`

```rs
if client_sync.client_message_count != server_snapshot.message_count {
    return Some(ExecuteSyncReason::MessageCountMismatch);
}
```

### 4.3 server snapshot 的 message_count 取值

`ServerExecuteSnapshot::from_session()` 在：

- `bamboo/crates/bamboo-server/src/session_app/execute.rs:397-409`

```rs
impl ServerExecuteSnapshot {
    pub fn from_session(session: &Session) -> Self {
        Self {
            message_count: session.messages.len(),
            last_message_id: session.messages.last().map(|message| message.id.clone()),
            has_pending_question: session.pending_question.is_some(),
            ...
        }
    }
}
```

这说明 execute 的同步判定口径是：

> **完整 `session.messages.len()`**

不做 UI 可见性过滤。

---

## 5. bamboo history 的返回口径

history handler 在：

- `bamboo/crates/bamboo-server/src/handlers/agent/history.rs:42-126`

真正关键的过滤逻辑在：

- `bamboo/crates/bamboo-server/src/handlers/agent/history.rs:108-119`

```rs
let messages: Vec<_> = session
    .messages
    .into_iter()
    .filter(|message| {
        !message
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("hidden_from_ui"))
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
    })
    .collect();
```

所以 history 返回的是：

> **过滤掉 `metadata.hidden_from_ui == true` 的消息后的可见消息集合**

这与 execute 的 sync snapshot 口径已经不一致。

---

## 6. 这次目标 session 的真实数据

排查对象：

- root session: `1cc83489-4ba4-4621-a0b7-73d4efb1ffa4`
- child session 1: `0c7227e1-987a-474b-9666-cc44d982f4e1`
- child session 2: `13f1a9af-975a-484a-9128-ac8058e6f040`

本地 `~/.bamboo` 实测：

### 6.1 root / child 各自消息数

- root session：**52**
- child1：**80**
- child2：**105**

说明：

> **后端报的 `server_message_count: 52` 对 root session 自身是自洽的。**

它不是把 80/105 的 child transcript 直接并入 root 来算的总数。

### 6.2 root session 中隐藏消息数量

对 root `session.json` 直接检查发现：

- **总消息数：52**
- **可见消息数：50**
- **隐藏消息数：2**

这 2 条隐藏消息分别是：

- `cbd9949f-a5fa-4ad0-ba19-d6573a56885b`
- `a1511257-7f68-4dee-812f-7c229fa719ae`

它们都具有：

- `metadata.hidden_from_ui = true`
- `metadata.runtime_kind = "child_completion_resume"`

即：

> **它们不是用户真实输入，而是 child session 完成后，bamboo 自动注入到 root session 用于恢复 parent runtime 的隐藏 user 消息。**

---

## 7. 这些隐藏消息来自哪里

child completion resume 消息是在：

- `bamboo/crates/bamboo-server/src/app_state/child_completion_coordinator.rs:150-160`

创建的：

```rs
let mut message = Message::user(body);
message.metadata = Some(serde_json::json!({
    "hidden_from_ui": true,
    "runtime_kind": "child_completion_resume",
    "child_session_id": completion.child_session_id,
    "child_status": completion.status,
    ...
}));
message.never_compress = true;
```

也就是说：

- 它们确实属于 **root session.messages**
- 但设计上 **不希望前端 history/UI 直接展示**

所以 history 会过滤它们，这是合理的。

**问题不在于“隐藏”这个设计本身，而在于 execute sync 仍然把这些隐藏消息算进了 message_count。**

---

## 8. 为什么 recovery 会永远失败

现在把整个因果链串起来：

### Step 1
root session 因 child completion 被注入 2 条 runtime resume 隐藏消息：

- root 总数 = 52
- UI 可见数 = 50

### Step 2
lotus 调 `loadChatHistory(sessionId, { mode: "replace" })`

history API 会过滤 `hidden_from_ui=true`，所以 lotus 得到：

- `history.messages.length = 50`
- `syncCursor.messageCount = 50`

### Step 3
lotus 再次发 execute，请求里 `client_sync.client_message_count = 50`

### Step 4
bamboo `prepare_execute()` 用 `ServerExecuteSnapshot::from_session()` 计算：

- `server_snapshot.message_count = session.messages.len() = 52`

### Step 5
`evaluate_client_sync()` 比较：

- client = 50
- server = 52

于是必然得到：

- `ExecuteSyncReason::MessageCountMismatch`

### Step 6
lotus 进入 recovery，再次 `loadChatHistory(... replace)`

但 history 还是只会返回 50 条可见消息，`syncCursor` 还是 50。

### Step 7
再次 execute 仍然 50 vs 52，不可能收敛。

所以最终表现为：

- `Execute remains out-of-sync after 2 recovery attempt(s)`

**这就是为什么你手动删消息之后问题仍然可能持续：因为问题的根不是某一条普通消息删了没同步，而是同步协议的两端“压根不是在数同一套消息”。**

---

## 9. 这和 sub session / root session 的关系

你的直觉“感觉是 sub session 和 root session 之间有 gap”，**方向是对的，但精确定义要改一下**：

不是：
- root 直接把 child transcript 全部混进来了

而是：
- child 完成后，**bamboo 会往 root 注入 runtime resume 消息**，用于恢复 parent session
- 这些消息被标记为 `hidden_from_ui`
- execute sync 仍把它们算进 root 的 message_count
- history/UI 却把它们过滤掉

所以真正的 gap 是：

> **sub session completion → root runtime resume message → hidden_from_ui → execute/history 计数口径分叉**

这就是 bamboo 与 lotus 交互层面的协议缺口。

---

## 10. `server_last_message_id` 为什么看起来异常

你报错里给的：

- `server_last_message_id: "d11508d6-1a71-41c0-bbc7-ca1f41e2b4da"`

在当前 root session 的最新磁盘快照里，这个 ID 已经不存在；当前 root 最后一条消息是：

- `97344b31-3dae-4d5e-b5d1-2bef76760794`

这说明两件事之一：

1. 该报错是**更早时刻**的 execute 响应快照，不是当前磁盘最终状态；或
2. 你手动删除/后续恢复后，session 已经再次变化。

但这不影响主结论，因为：

- `server_message_count: 52` 与当前 root 磁盘数据一致
- 根因在 message_count 口径分裂，而不是某个特定 last_message_id 必须固定重现

---

## 11. 修复建议

### 方案 A：让 execute sync 与 history 使用同一“可见消息”口径

**推荐程度：最高**

把 `ServerExecuteSnapshot::from_session()` 改成使用“UI 可见消息”计数，而不是 `session.messages.len()`。

例如：
- 过滤 `hidden_from_ui=true`
- `message_count` / `last_message_id` 都基于过滤后的可见消息集合

优点：
- 与 history 返回结果完全一致
- lotus recovery 能真正收敛
- 不需要前端理解 runtime resume 隐藏消息的内部实现

建议修改位置：

- `bamboo/crates/bamboo-server/src/session_app/execute.rs:397-409`

可以抽一个共享 helper，例如：
- `visible_messages_for_ui(session)`

然后 history handler 和 ServerExecuteSnapshot 都用同一 helper。

---

### 方案 B：history 不再过滤隐藏消息，而是返回给 lotus 并由前端自行忽略展示

**推荐程度：中等，不如方案 A**

让 history 直接返回全量消息，包含 `hidden_from_ui`；lotus 在 render 层跳过这些消息，但 syncCursor / messageCount 仍按全量计。

缺点：
- lotus store 里会混入系统 runtime resume 消息
- 前端要理解更多 Bamboo 内部 runtime 语义
- 更容易污染业务逻辑

---

### 方案 C：前端 syncCursor 单独以“服务端同步游标”更新，而不是从 history.length 推导

**推荐程度：中等偏低，适合作为补充，不适合作为根修复**

因为 lotus 现在在 `loadChatHistory()` 中：

- `messageCount = history.messages.length`
- `syncCursor.messageCount = history.messages.length`

这天然假设 history 计数就是 execute 同步计数。

如果后端暂时不改，可以让 history API 额外返回：

- `sync_message_count`
- `sync_last_message_id`

前端用这个字段更新 `syncCursor`，而不是从 `history.messages.length` 推导。

但这本质还是在修补“协议口径分裂”，不如直接统一服务端口径干净。

---

## 12. 建议的最小修复路径

我建议按下面顺序修：

### 后端最小修复
1. 在 bamboo 抽一个共享 helper：`visible_message_snapshot(session)`
2. `history.rs` 与 `ServerExecuteSnapshot::from_session()` 统一使用该 helper
3. `message_count` / `last_message_id` 均基于可见消息集

### 前端防御性修复
1. 在 `useMessageStreaming.ts` 的 `recoverAfterNeedSync()` 里打印更明确的诊断日志：
   - client message count
   - server message count
   - visible history length
2. 在 `loadChatHistory()` 中，若后端未来返回 `sync_*` 显式字段，则优先使用它们更新 `syncCursor`

---

## 13. 验证方法

修复后，应验证以下场景：

### 场景 1：普通 root session，无 sub session
- send message
- execute 正常
- 不再触发 message_count_mismatch

### 场景 2：root session 创建 child session，child 完成后恢复 parent
- child 完成 -> bamboo 注入 hidden resume message
- history 返回可见消息数 N
- execute sync snapshot 也返回 N
- lotus recovery 后重新 execute 成功
- 不再出现 “after 2 recovery attempt(s)”

### 场景 3：含多个 child completion resume 的 root session
- 连续多个 child 完成
- root 中存在多个 `hidden_from_ui=true` 消息
- history / execute 同步仍一致

### 场景 4：手动删除消息后再恢复
- delete 某条普通消息
- `loadChatHistory()` 与 execute sync 仍能收敛
- 不应再被 hidden runtime resume 消息拖死

---

## 14. 最终结论

最终根因可以一句话概括为：

> **Bamboo 在 root session 中插入了用于恢复 parent runtime 的隐藏 user 消息（child completion resume），这些消息会被 history 接口过滤掉，但 execute 的 sync snapshot 仍把它们计入 message_count。Lotus recovery 基于 history.length 重建 syncCursor，于是永远得到比 execute 更小的 client_message_count，导致 `message_count_mismatch` 持续存在。**

所以这不是单纯的：
- 用户手动删除消息导致不同步
- 或 child/root 消息直接混算

而是更精确的：

> **sub session completion 触发的 hidden runtime resume message，暴露了 bamboo history 与 execute sync 的协议口径不一致。**
