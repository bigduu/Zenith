# Auto-title 失效链路排查报告

## 结论摘要

这次“自动生成 title 又不工作”的**最可能根因**不是前端完全没监听，也不是后端完全没生成，而是一个**时序竞态（race condition）**：

- 后端在 `execute` 开始时**异步**启动 title generation；
- SSE 事件流在收到 `complete/cancelled/error` 后会立刻发送 `[DONE]` 并关闭；
- 如果 `session_title_updated` 发生在 `complete` 之后，前端这条 SSE 连接已经结束，**标题更新事件无法送达当前订阅者**；
- 前端虽然会在完成后触发一次 `refreshChatsNow()` 兜底，但它只有 **一次**，且 settle delay 只有 **250ms**；如果 title generation 这时仍未完成（例如 LLM 慢、30s timeout、fallback 还没写回），这次刷新就只能拉到旧标题，之后没有第二次自动刷新，所以 UI 看起来就像“自动标题没工作”。

换句话说：

> 自动标题功能的核心问题不是“没生成”，而是**生成晚于 SSE 结束 + 前端只做了一次过早的兜底 refresh**，最终导致标题更新丢在链路里。

---

## 并行排查范围

- 前端：`lotus`
- 后端：`bamboo/crates/bamboo-server`
- 桌面桥接：`bodhi`（结论：这里不是主问题）

---

## 端到端链路

```mermaid
graph TD
    A[用户发送消息] --> B[POST /api/v1/execute/:session_id]
    B --> C[execute handler 进入 Ready 分支]
    C --> D[异步 spawn_title_generation]
    C --> E[agent runtime 正常执行]
    E --> F[发送 complete/cancelled/error]
    F --> G[SSE stream 发 [DONE] 并关闭]
    D --> H[title_gen: LLM/heuristic 生成标题]
    H --> I[SessionMetadataService.apply_generated_title]
    I --> J[publish_replayable_session_event]
    J --> K[广播 session_title_updated]
    K --> L{前端 SSE 还活着?}
    L -->|是| M[applyServerTitle 更新 UI]
    L -->|否| N[事件丢给当前订阅]
    G --> O[前端 settleParentCompletion -> refreshChatsNow 一次]
    O --> P{title 已经写回?}
    P -->|是| Q[listSessions 带回新 title]
    P -->|否| R[仍显示旧 title / New Session]
```

---

## 关键证据

### 1) execute 路径会异步触发 title generation

文件：`bamboo/crates/bamboo-server/src/handlers/agent/execute/handler/mod.rs:153`

```rust
// Kick off async auto-title generation for fresh, untitled sessions.
if crate::title_gen::is_untitled(&session.title)
    && session
        .messages
        .iter()
        .any(|m| matches!(m.role, bamboo_agent_core::Role::User))
{
    crate::title_gen::spawn_title_generation(
        state.clone().into_inner(),
        session_id.clone(),
    );
}
```

说明：
- 它不是同步生成标题；
- 是 fire-and-forget 异步任务；
- 所以后续 runtime 的 `complete` 完全可能早于 title 更新事件。

---

### 2) title generation 明确是后台任务

文件：`bamboo/crates/bamboo-server/src/title_gen/mod.rs:58`

```rust
tokio::spawn(async move {
    let _guard = TitleGenGuard { ... };
    if let Err(e) = run_title_generation(&state_for_task, &sid, force).await {
        warn!(session_id = %sid, "title-gen failed: {e}");
    }
});
```

并且 LLM 标题生成最多可跑到 30 秒：

文件：`bamboo/crates/bamboo-server/src/title_gen/mod.rs:35`

```rust
const TITLE_GEN_TIMEOUT_SECS: u64 = 30;
```

说明：
- title 生成天然可能落后于主执行流；
- 这为 race condition 提供了足够大的窗口。

---

### 3) SSE 在 terminal event 后立即关闭

文件：`bamboo/crates/bamboo-server/src/handlers/agent/events/stream.rs:72-80`

```rust
let is_terminal = is_terminal_event(&event);
...
yield Ok::<_, actix_web::Error>(web::Bytes::from(sse_data));
if is_terminal {
    yield Ok::<_, actix_web::Error>(web::Bytes::from(done_sse_data()));
    break;
}
```

文件：`bamboo/crates/bamboo-server/src/handlers/agent/events/stream.rs:113-117`

```rust
fn is_terminal_event(event: &AgentEvent) -> bool {
    matches!(
        event,
        AgentEvent::Complete { .. } | AgentEvent::Cancelled { .. } | AgentEvent::Error { .. }
    )
}
```

说明：
- 一旦 runtime 发了 `complete`，SSE 就结束了；
- 后续再来的 `session_title_updated` 无法通过这条流送到前端。

---

### 4) 前端收到 `[DONE]` 就立刻关闭 EventSource

文件：`lotus/src/services/chat/AgentService.ts:936-939`

```ts
if (data === "[DONE]") {
  terminalSeen = true;
  settleResolve();
  return;
}
```

`settleResolve()` 会关闭 `EventSource`：

文件：`lotus/src/services/chat/AgentService.ts:898-910`

```ts
const cleanup = () => {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  ...
};
```

说明：
- 这和后端关闭流是配套的；
- 当前订阅确实在 terminal 后就不再接收任何 metadata event。

---

### 5) 前端对 `session_title_updated` 的处理其实是正确的

文件：`lotus/src/hooks/useAgentEventSubscription.ts:1106-1108`

```ts
onSessionTitleUpdated: (event) => {
  applyReplayableSessionEvent(event, useAppStore.getState());
},
```

文件：`lotus/src/pages/ChatPage/store/slices/chatSessionSlice.ts:993-1006`

```ts
applyServerTitle: (sessionId, title, titleVersion) =>
  set((state) => {
    const existing = state.chats.find((c) => c.id === sessionId);
    if (!existing) return state;
    if (titleVersion <= (existing.titleVersion ?? 0)) return state;
    return {
      ...state,
      chats: state.chats.map((chat) =>
        chat.id === sessionId
          ? { ...chat, title, titleVersion, updatedAt: new Date().toISOString() }
          : chat,
      ),
    };
  }),
```

说明：
- 前端 reducer 并没有明显写坏；
- `titleVersion` 优先级逻辑也是合理的；
- 所以问题重点不在“收到事件后没更新”，而在“很多时候根本收不到这个事件”。

---

### 6) 前端只有一次 completion 后兜底 refresh，而且很早

文件：`lotus/src/hooks/useAgentEventSubscription.ts:379`

```ts
const PARENT_SETTLE_DELAY_MS = 250;
```

文件：`lotus/src/hooks/useAgentEventSubscription.ts:414-418`

```ts
const settleParentCompletion = async () => {
  clearParentSettleTimer(sessionId);

  try {
    await refreshChatsNow();
```

说明：
- terminal 后大约 250ms 才做一次 `refreshChatsNow()`；
- 如果 title generation 还没完成，这次 refresh 只能拿到旧 title；
- 代码里没有看到同一 session completion 后的第二次自动 refresh。

---

### 7) `refreshChatsNow()` 合并逻辑也没问题，但它依赖“服务器已经写回”

文件：`lotus/src/pages/ChatPage/store/slices/chatSessionSlice.ts:670-678`

```ts
const remoteTitleVersion = c.titleVersion ?? 0;
const localTitleVersion = prev.titleVersion ?? 0;
const titleFields =
  remoteTitleVersion > localTitleVersion
    ? { title: c.title, titleVersion: remoteTitleVersion }
    : { title: prev.title, titleVersion: localTitleVersion };
```

说明：
- 只要 listSessions 里已经有新 title + 新 titleVersion，这里是能正确把它显示出来的；
- 但如果 refresh 发得太早，拿到的仍是旧 session summary，那就恢复不了。

---

### 8) Replayable event 机制不是万能补救，因为它依赖 runner 仍可重放

文件：`bamboo/crates/bamboo-server/src/events/replayable.rs:45-58`

```rust
{
    let mut runners = state.agent_runners.write().await;
    if let Some(runner) = runners.get_mut(session_id) {
        runner.push_critical_event(event.clone());
    }
}

let sender = state.get_session_event_sender(session_id).await;
let _ = sender.send(event);
```

说明：
- 如果 runner 还在，确实会 cache；
- 但当前前端在 `[DONE]` 后不会立刻重新订阅这个 session；
- 所以即便 event 已缓存，也没有新订阅者来消费这次重放；
- 用户通常只看到“标题没变”。

---

## 为什么我认为这是“最可能根因”而不是配置问题

### 配置问题不是零概率，但不是这次最像的主因

后端 team agent 也找到了这些次级风险：

1. `resolve_fast_model()` 可能解析不到 fast model；
2. LLM title 可能 timeout；
3. provider 配置可能不完整；
4. `AlreadyRunning / NoPendingMessage` 分支不会触发 title generation。

但是：

- 即便 fast model 不可用，`title_gen/mod.rs:125-127` 也会回退到 heuristic title；
- 真正完全“不出标题”的更高概率场景，是**标题写回发生得比 SSE 终止更晚**，同时前端仅一次 refresh 没赶上；
- 这也更符合你说的“又不工作了”——表现会是**间歇性、回归式**，而不是稳定 100% 失败。

---

## 次级问题 / 脆弱点

### A. 前端 optimistic title update 不 bump `titleVersion`

文件：`lotus/src/pages/ChatPage/store/slices/chatSessionSlice.ts:909-920`

`updateSession()` 本地更新 title 时没有同步 bump `titleVersion`。这不是本次主因，但会让本地/远端覆盖关系更脆弱，尤其在 manual rename 或 child session title 持久化时。

### B. `persistSessionTitle()` 同样 optimistic update 但不带 version

文件：`lotus/src/pages/ChatPage/store/slices/chatSessionSlice.ts:960-990`

这会让 sub-agent title 依赖后续 SSE 才把 `titleVersion` 补上。如果事件丢了，也会留下局部不一致。

### C. execute 只有 `Ready` 分支才触发 title generation

文件：`bamboo/crates/bamboo-server/src/handlers/agent/execute/handler/mod.rs:121-263`

如果某些场景走到：
- `AlreadyRunning`
- `NoPendingMessage`
- `SyncMismatch`

则不会触发 title generation。它不是本次“又不工作了”的最核心现象，但属于路径覆盖缺口。

---

## 测试现状说明

### 已有前端测试通过，但没有覆盖“title 事件晚到”

我跑了：
- `lotus`: `npm test -- --run src/hooks/__tests__/useAgentEventSubscription.test.tsx`
- 结果：30 个测试全过

现有测试覆盖了：
- terminal 后 settle refresh；
- stale processing 清理；
- one-shot terminal complete 不重连；

但**没有**覆盖这个关键场景：

> `complete` → `[DONE]` → SSE 关闭 → 稍后才收到/生成 `session_title_updated`（当前订阅无法再收到）

### 后端 title_gen 测试也只覆盖 helper，不覆盖真实异步链路

我跑了：
- `bamboo`: `cargo test title_gen --package bamboo-server`
- 结果：8 个测试全过

但测试内容主要是：
- `is_untitled`
- `heuristic_title`
- `sanitize`
- `build_title_messages`

没有覆盖：
- execute 后异步 spawn；
- `complete` 后 title 事件晚到；
- SSE stream 提前结束导致 title event 当前订阅收不到。

这进一步说明：

> 当前这个问题非常像一个**未被测试覆盖的异步时序回归**。

---

## 修复建议（按优先级）

### 方案 1：前端在 terminal 后为 title 做二次延迟 refresh

**推荐度：高，改动小，见效快**

思路：
- 保留当前 250ms settle refresh；
- 再为 terminal session 增加一次延迟 refresh（比如 1.5s / 3s，或指数退避 2-3 次）；
- 仅在 session title 仍是 untitled / `titleVersion` 未变化时触发；
- 一旦拉到 titleVersion 增长就停止。

优点：
- 不需要改后端 SSE 语义；
- 对现有架构入侵最小；
- 直接补上当前最明显的 race。

### 方案 2：后端把 auto-title 提前到 terminal event 之前完成

**推荐度：中，根治更强，但侵入性更大**

思路：
- 不要 fire-and-forget；
- 或至少在 emit terminal event 前等待 title generation 完成/超时；
- 确保 `session_title_updated` 在 `[DONE]` 之前发出。

风险：
- 会拉长 execute completion 路径；
- 对用户体感可能带来 terminal 延迟；
- 需要小心与 runtime/runner 生命周期配合。

### 方案 3：terminal 后允许 metadata replay 的短暂观察窗口

**推荐度：中**

思路：
- 后端不要在 terminal event 后立即 break；
- 增加一个很短的 grace period，允许 replayable metadata event（特别是 `session_title_updated`）继续下发；
- 或前端在 `[DONE]` 后对同 session 再发起一次短生命周期订阅，专门等 replayable metadata。

优点：
- 更贴近问题本质；
- 不用多次 listSessions 轮询。

风险：
- 会改变 SSE 协议语义；
- 比方案 1 更复杂。

### 方案 4：补测试，防止再次回归

**必须做**

建议至少补 3 类测试：

1. **前端 hook 测试**
   - 模拟 `onComplete` 先到；
   - `refreshChatsNow()` 第一次拿到旧 title；
   - 稍后 server title 才变；
   - 验证二次 refresh / 观察窗口能把 title 拉回来。

2. **后端集成测试**
   - 模拟 `execute` 先完成；
   - `title_gen` 延迟后写入 title；
   - 验证后续订阅/重放策略是否能看到 `SessionTitleUpdated`。

3. **端到端测试**
   - 创建新会话；
   - 发送首条消息；
   - 模拟慢 title generation；
   - 断言 sidebar title 最终从 `New Session` 更新为自动标题。

---

## 我建议的落地顺序

1. **先做前端补丁**：terminal 后对 untitled session 做 1~2 次延迟 refresh。
2. **补 hook 测试**：覆盖 `complete` 后 title 晚到。
3. **再评估后端增强**：是否要把 `session_title_updated` 纳入 terminal 前保证送达的范围。

这是性价比最高、风险最小的一条路。

---

## 最终判断

### 最可能根因

**自动标题生成功能失效的主要原因是：**

- `title_gen` 是异步后台任务；
- SSE 在 `complete` 后立即结束；
- `session_title_updated` 经常晚于 `complete` 到达；
- 前端只做一次 250ms 后的 refresh；
- 当这次 refresh 早于 title 写回，UI 就永久停留在旧标题，直到用户手动刷新或重新进入页面。

### 非主因但值得一起修

- `updateSession/persistSessionTitle` optimistic update 不 bump `titleVersion`；
- `execute` 非 `Ready` 分支不触发 title generation；
- fast model 解析/超时类问题缺少更强诊断日志。

---

## 建议的下一步

如果要我直接动手，我建议下一步做：

1. 在 `lotus/src/hooks/useAgentEventSubscription.ts` 加一层 **title-aware delayed refresh retry**；
2. 给 `useAgentEventSubscription.test.tsx` 增加 **complete 后 title 晚到** 的回归测试；
3. 如有需要，再补后端集成测试验证 replay / late metadata delivery。
