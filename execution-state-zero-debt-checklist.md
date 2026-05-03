# Execution-State Refactor — Zero Technical Debt Cleanup Checklist

This document enumerates the remaining work required to bring the Lotus execution-state refactor to a true zero-debt state.

Scope reviewed:
- lotus frontend execution-state refactor
- root/sub-session lifecycle convergence
- SSE observation / reconnect / running snapshot flow
- question/respond and approval interaction surfaces

---

## Executive Summary

The refactor is directionally correct and already significantly improved, but it is **not yet zero-debt**.

There are three remaining structural debt classes:

1. **Half-wired protocol events**
   - `execution_started` and `tool_approval_requested` are real backend SSE events, but the frontend event transport layer does not dispatch them.
2. **Incomplete approval lifecycle**
   - `waiting_approval` is modeled and partially surfaced in UI, but the user cannot actually approve/reject and continue execution.
3. **Multi-owner interaction state**
   - `pendingQuestion` / `respondMode` are written and cleared by multiple UI components and recovery paths instead of having a single state owner.

There are also several migration leftovers and stale compatibility shells that should be removed.

---

## Zero-Debt Target State

The system reaches zero debt only when all of the following are true:

- Each backend SSE event type that the frontend models is either:
  - fully transported and consumed, or
  - removed from frontend modeling entirely.
- Every execution phase visible in UI has a complete and testable user path.
- Execution observation semantics are explicit (`observe` vs `busy`) and not implicit aliases.
- One canonical owner exists for each interaction state family (`pendingQuestion`, `respondMode`, `pendingApproval`).
- No migration scaffolding, dead selectors, dead components, or stale type shells remain.
- No UI surface directly re-derives execution semantics from raw map internals when selectors already exist.

---

## P0 — Must Fix Before Claiming Zero Debt

### P0.1 Wire `execution_started` end-to-end

**Problem**
- Backend emits `ExecutionStarted` as a real first SSE event.
- Frontend reducer supports it.
- `AgentService.handleEvent()` does **not** dispatch it.
- `AgentEventHandlers` does not expose a handler for it.

**Files**
- `lotus/src/services/chat/AgentService.ts`
- `lotus/src/hooks/useAgentEventSubscription.ts`
- `lotus/src/services/chat/__tests__/AgentService.test.ts`
- `lotus/src/hooks/__tests__/useAgentEventSubscription.test.tsx`

**Required changes**
1. Add `onExecutionStarted?: (event: AgentEvent) => void` or a strongly typed equivalent to `AgentEventHandlers`.
2. Add `case "execution_started"` to `AgentService.handleEvent()`.
3. In `useAgentEventSubscription`, forward the event into execution state via either:
   - `applyAgentEvent(sessionId, event, generation)`, or
   - `applyExecutionStarted(sessionId, runId, generation)`.
4. Add tests verifying:
   - handler dispatch occurs,
   - reducer transitions `starting -> running`,
   - late reconnect / running snapshot flow stays consistent.

**Done when**
- `execution_started` is no longer a declared-but-undelivered event.

---

### P0.2 Resolve `tool_approval_requested` completely — either full support or full removal

**Problem**
- Backend emits `ToolApprovalRequested` as a real event.
- Frontend models `waiting_approval` and `pendingApproval`.
- UI only shows warning text/status.
- No real approve/reject interaction path exists.
- `ApprovalCard` exists but is dead.

**Files**
- `lotus/src/services/chat/AgentService.ts`
- `lotus/src/hooks/useAgentEventSubscription.ts`
- `lotus/src/pages/ChatPage/store/slices/executionStateSlice.ts`
- `lotus/src/pages/ChatPage/store/selectors/executionSelectors.ts`
- `lotus/src/pages/ChatPage/components/InputContainer/index.tsx`
- `lotus/src/pages/ChatPage/components/ExecutionStatusRail/index.tsx`
- `lotus/src/pages/ChatPage/components/MessageCard/ApprovalCard.tsx`
- backend approval route(s), if they exist or will be added

**Required decision**
Choose exactly one final architecture:

#### Option A — Fully support approval
1. Transport `tool_approval_requested` through `AgentService.handleEvent()`.
2. Add real approval UI (possibly using `ApprovalCard`, but only if actually mounted).
3. Add real approve/reject actions and backend API integration.
4. Ensure approval completion clears `pendingApproval` and transitions execution correctly.
5. Add integration tests for:
   - approval requested,
   - approve path,
   - reject path,
   - recovery after reconnect.

#### Option B — Remove approval modeling for now
1. Remove `tool_approval_requested` from frontend event modeling.
2. Remove `waiting_approval` phase usage from UI.
3. Remove `pendingApproval`, `clearPendingApproval`, approval selectors, and dead approval UI.
4. Keep the backend event unsupported until the full feature is intentionally introduced.

**Done when**
- There is no partial approval lifecycle left in the frontend.

---

### P0.3 Give `pendingQuestion` / `respondMode` a single owner

**Problem**
These states are currently written/cleared by multiple places:
- SSE path
- polling QuestionDialog path
- InteractiveQuestionToolCard
- need_sync recovery path
- submit success/failure cleanup paths
- component unmount handlers

This is a classic future-race and future-multi-pane debt source.

**Files**
- `lotus/src/hooks/useAgentEventSubscription.ts`
- `lotus/src/components/QuestionDialog/QuestionDialog.tsx`
- `lotus/src/pages/ChatPage/components/MessageCard/InteractiveQuestionToolCard.tsx`
- `lotus/src/pages/ChatPage/hooks/useChatManager/useMessageStreaming.ts`
- `lotus/src/pages/ChatPage/store/slices/executionStateSlice.ts`

**Required changes**
1. Define a single owner model for interaction state in `executionStateSlice`.
2. Replace ad-hoc component writes with explicit source-specific actions, e.g.:
   - `setPendingQuestionFromSse(...)`
   - `setPendingQuestionFromPolling(...)`
   - `resolvePendingQuestion(...)`
3. Remove component-unmount cleanup of global pending-question state unless ownership guarantees make it safe.
4. Ensure only central execution actions can clear the global state.
5. Add tests for:
   - multi-pane same-session rendering,
   - polling + SSE interleaving,
   - respond success in one pane hiding the prompt in another,
   - unmount/remount without incorrectly clearing state.

**Done when**
- UI components are readers/presenters, not competing owners of global interaction state.

---

### P0.4 Remove dead migration shim

**Problem**
- `src/test/legacyShim.ts` is an empty migration artifact.

**Files**
- `lotus/src/test/legacyShim.ts`

**Required changes**
- Delete the file.
- Remove any references/imports.

**Done when**
- No Phase 0–4 compatibility shim remains.

---

### P0.5 Remove or activate dead `ApprovalCard`

**Problem**
- `ApprovalCard` is defined but unused in production.

**Files**
- `lotus/src/pages/ChatPage/components/MessageCard/ApprovalCard.tsx`

**Required changes**
- If approval support is not implemented now: delete it.
- If approval support is implemented now: mount it as the real UI and test it.

**Done when**
- No dead approval UI component remains.

---

## P1 — Required to Eliminate Structural Debt

### P1.1 Make observation semantics explicit and actually used

**Problem**
- `selectShouldObserve` exists but production subscription/reconnect logic still keys off `selectIsBusy` / `isBusyPhase`.
- Today the semantics are equal; future divergence will create subtle bugs.

**Files**
- `lotus/src/pages/ChatPage/store/selectors/executionSelectors.ts`
- `lotus/src/hooks/useAgentEventSubscription.ts`

**Required changes**
1. Decide whether `observe` and `busy` are conceptually distinct.
2. If distinct, move subscription/reconnect gating to `selectShouldObserve`.
3. If not distinct yet, remove `selectShouldObserve` until it is truly needed.
4. Align comments and tests to the final semantics.

**Done when**
- Observation semantics are either explicit and used, or not modeled at all.

---

### P1.2 Stop direct phase reads in sidebar and dashboard

**Problem**
- Sidebar and dashboard still read `executionBySession[chat.id]?.phase` directly and apply `isBusyPhase` themselves.
- Selector layer is not yet the single semantic authority.

**Files**
- `lotus/src/pages/ChatPage/components/ChatSidebar/useChatSidebarState.ts`
- `lotus/src/pages/ChatPage/components/HomeDashboard/index.tsx`
- `lotus/src/pages/ChatPage/store/selectors/executionSelectors.ts`

**Required changes**
1. Replace direct raw-phase reads with dedicated selectors.
2. Either use the existing aliases:
   - `selectIsBusyForSidebar`
   - `selectIsBusyForDashboard`
3. Or delete those aliases and use a clearer final selector shape.

**Done when**
- No consumer outside selector layer re-derives busy/running semantics from raw phase.

---

### P1.3 Remove dead selector aliases or make them the real surface API

**Problem**
The following selectors currently exist as compatibility aliases but are not actually used:
- `selectIsBusyForSidebar`
- `selectIsBusyForDashboard`
- `selectShouldShowTaskPanel`

**Files**
- `lotus/src/pages/ChatPage/store/selectors/executionSelectors.ts`
- all consuming surfaces

**Required changes**
- Either adopt them everywhere those surface semantics exist, or delete them.

**Done when**
- No selector exists purely as a dead alias.

---

### P1.4 Remove the legacy `interactionState` shell from ChatView

**Problem**
`ChatView` still constructs a pseudo state-machine shell:
- `IDLE`
- `THINKING`
- `AWAITING_APPROVAL`

But in reality it only ever emits:
- `IDLE`
- `THINKING`

So `AWAITING_APPROVAL` is a dead type branch.

**Files**
- `lotus/src/pages/ChatPage/components/ChatView/index.tsx`
- `lotus/src/pages/ChatPage/components/ChatView/ChatMessagesList.tsx`
- `lotus/src/pages/ChatPage/components/ChatView/useChatViewScroll.ts`
- `lotus/src/pages/ChatPage/hooks/useChatManager/types.ts`

**Required changes**
1. Replace `interactionState` wrapper with direct props, e.g.:
   - `isThinking`
   - `isAwaitingApproval`
   - or `executionPhase`
2. Remove dead `matches("AWAITING_APPROVAL")` branches.
3. Keep scroll behavior but drive it from actual execution selector output.

**Done when**
- ChatView no longer carries a fake legacy state machine wrapper.

---

### P1.5 Delete stale chat-manager state-machine types

**Problem**
The following types are legacy shells or no longer materially used:
- `InteractionState`
- `PendingAgentApproval`
- `UseChatStateMachine`

**Files**
- `lotus/src/pages/ChatPage/hooks/useChatManager/types.ts`

**Required changes**
- Remove dead types.
- If any concept remains necessary, reintroduce it using execution-state-native terminology and actual usage.

**Done when**
- No unused legacy state-machine type layer remains.

---

### P1.6 Replace hand-written partial execution state shapes with real shared types/selectors

**Problem**
`useMessageStreaming` currently inlines a hand-written subset of `executionBySession` just to read `respondMode`.

**Files**
- `lotus/src/pages/ChatPage/hooks/useChatManager/useMessageStreaming.ts`

**Required changes**
- Replace the inline partial store shape with:
  - a selector such as `selectRespondMode`, or
  - shared execution-state type imports.

**Done when**
- No local ad-hoc structural copies of execution state remain.

---

### P1.7 Remove migration-phase comments and convert them to current-state documentation

**Problem**
There are still many comments like:
- `Phase 1`
- `Phase 5A`
- `Phase 5B`
- `double-write`
- `legacy projection helpers`

These were useful during migration but are now debt if the migration is supposed to be finished.

**Files**
- `lotus/src/pages/ChatPage/store/selectors/executionSelectors.ts`
- `lotus/src/pages/ChatPage/store/slices/executionStateSlice.ts`
- `lotus/src/pages/ChatPage/store/slices/chatSessionSlice.ts`
- `lotus/src/hooks/useAgentEventSubscription.ts`
- other touched execution-state files

**Required changes**
- Rewrite comments to describe the present invariant, not the migration phase.
- Remove comments that imply temporary layering once the layering is no longer temporary.

**Done when**
- Comments describe the current architecture only.

---

### P1.8 Clean up misleading variable names that preserve old semantics

**Problem**
There are still local names that imply old meanings, e.g.:
- `isProcessing = isInputLocked`
- `isStreaming = isProcessing`
- `isSessionProcessing`

These now obscure the actual split between busy / lock / cancel / streaming UI.

**Files**
- `lotus/src/pages/ChatPage/components/InputContainer/index.tsx`
- `lotus/src/components/QuestionDialog/QuestionDialog.tsx`
- other consumers

**Required changes**
- Rename variables to match real semantics.
- Suggested names:
  - `isInputLocked`
  - `showCancelButton`
  - `showStreamingUi`
  - `isSessionBusy`
  - `shouldPollAggressively`

**Done when**
- Local names reflect actual semantics and no longer preserve legacy mental models.

---

## P2 — Final Architecture Convergence Cleanup

### P2.1 Decide whether `run_id` becomes the primary convergence key

**Problem**
- `backendRunId` now exists.
- `execute` returns `run_id`.
- running snapshot returns `run_id`.
- summary may return `current_run_id`.
- But active stale-event protection still fundamentally keys off local `generation`.

This is acceptable today, but it is still a dual-model architecture.

**Files**
- `lotus/src/hooks/useAgentEventSubscription.ts`
- `lotus/src/pages/ChatPage/store/slices/executionStateSlice.ts`
- `lotus/src/pages/ChatPage/hooks/useChatManager/useMessageStreaming.ts`
- `lotus/src/services/chat/AgentService.ts`

**Required changes**
Choose and document one of these final states:

#### Final state A — `generation` is the canonical client convergence key
- Treat `backendRunId` as informational / observability only.
- Remove ambiguous comments suggesting imminent primary use.

#### Final state B — `run_id` becomes canonical
- Use `run_id` to reconcile subscriptions, stale events, reconnects, and running snapshots.
- Keep `generation` only as a local lifecycle helper if still needed.

**Done when**
- There is one clearly documented primary execution identity model.

---

### P2.2 Remove `ExecutionStateViewWithChats` if legacy fallback is no longer real

**Problem**
`ExecutionStateViewWithChats` implies selector fallback to `chats[].isRunning` during migration.
If that migration is over, this is dead compatibility scaffolding.

**Files**
- `lotus/src/pages/ChatPage/store/selectors/executionSelectors.ts`

**Required changes**
- Remove the type and related fallback commentary if unused.

**Done when**
- Selectors reflect only current required input shape.

---

## Suggested File-by-File Execution Plan

### Batch 1 — Protocol truth
- `lotus/src/services/chat/AgentService.ts`
- `lotus/src/hooks/useAgentEventSubscription.ts`
- associated tests

### Batch 2 — Approval truth
- approval event transport
- approval UI or approval removal
- execution reducer cleanup

### Batch 3 — Interaction ownership
- question/respond state ownership centralization
- remove UI-owned global cleanup paths

### Batch 4 — Consumer cleanup
- sidebar/dashboard/chatview selectors
- remove interaction shell
- remove dead aliases/types

### Batch 5 — Final polish
- naming cleanup
- migration comment cleanup
- optional run-id convergence finalization

---

## Verification Gate for Claiming Zero Debt

Do not claim zero debt until all of the following are true:

- [ ] No backend-modeled SSE event is dropped at the frontend transport layer
- [ ] No execution phase is visible in UI without a complete user path
- [ ] `pendingQuestion/respondMode` has one canonical owner
- [ ] No dead approval code remains
- [ ] No migration shim remains
- [ ] No dead compatibility aliases/types remain
- [ ] No raw execution semantics are re-derived outside selectors
- [ ] Observation semantics are explicit and enforced
- [ ] Execution identity model (`generation` vs `run_id`) is explicitly finalized
- [ ] Comments describe present architecture only

---

## Final Assessment

Current state: **good refactor, not zero-debt yet**.

Zero-debt is achievable, but only after removing the remaining half-wired protocol surfaces, centralizing interaction ownership, and deleting the migration shells that still preserve the old model.
