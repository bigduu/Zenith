# Execution-State Zero-Debt Review — Latest Follow-up

Date: 2026-05-03

## Verdict

The latest follow-up fixes **substantially improved** the execution-state refactor and resolved most of the previously identified residual debt.

However, under a strict **"absolute zero technical debt"** standard, the current state is **still not fully zero-debt**.

The codebase is now extremely close. Two meaningful residual items remain:

1. **Observation semantics are only partially enforced in `useAgentEventSubscription`**
   - `selectShouldObserve` now exists and is used in reconnect/error paths.
   - But the primary subscription reconciliation effect still derives observed sessions by directly reading `executionBySession` + `isBusyPhase(...)` instead of routing through the selector abstraction.
2. **Backend `current_run_id` in session summaries remains a dead transitional field**
   - Frontend convergence is now explicitly finalized around `generation` (primary) + `backendRunId` (observational).
   - Frontend boot recovery now correctly uses `/api/v1/runs/active`.
   - But backend `SessionSummary.current_run_id` is still defined and documented as future-facing, while production code still leaves it `None`.

---

## What Was Successfully Fixed

### 1. `pendingQuestion` / `respondMode` ownership is substantially centralized

The old multi-path split between `setPendingQuestionFromSse(...)` and `enterRespondMode(...)` is gone.

Current model:
- `executionStateSlice` exposes a single `setPendingQuestion(sessionId, payload)` action
- That action atomically sets:
  - `interaction.pendingQuestion`
  - `interaction.respondMode`
- `clearPendingQuestion(sessionId)` atomically clears both

Evidence:
- `lotus/src/pages/ChatPage/store/slices/executionStateSlice.ts`
- `lotus/src/hooks/useAgentEventSubscription.ts`
- `lotus/src/components/QuestionDialog/QuestionDialog.tsx`
- `lotus/src/pages/ChatPage/hooks/useChatManager/useMessageStreaming.ts`

This removes the earlier structural debt where different components competed to manage question-mode and respond-mode separately.

### 2. `InteractiveQuestionToolCard` is now presentation-only

It no longer writes to global question/respond state.

Evidence:
- `lotus/src/pages/ChatPage/components/MessageCard/InteractiveQuestionToolCard.tsx`

This is a real cleanup and significantly reduces competing ownership risk.

### 3. `selectShouldObserve` is now actually used

Previously it was defined but unused.

Now it is used in `useAgentEventSubscription` reconnect/error liveness checks.

Evidence:
- `lotus/src/hooks/useAgentEventSubscription.ts:287-288`
- `lotus/src/hooks/useAgentEventSubscription.ts:1161-1163`
- `lotus/src/hooks/useAgentEventSubscription.ts:1182-1183`
- `lotus/src/hooks/useAgentEventSubscription.ts:1198-1199`

This is a real improvement, though not yet fully applied everywhere.

### 4. `waiting_approval` / approval-shell residue is effectively removed from lotus production code

Evidence:
- No production hits remain for:
  - `ApprovalCard`
  - `pendingApproval`
  - `tool_approval_requested`
  - `waiting_approval`
  - `enterRespondMode`
  - `setPendingQuestionFromSse`
  - legacy chat state-machine shells
- `RailLabelKey` no longer includes `waiting_approval`

This closes the frontend half-wired approval-state debt.

### 5. Frontend run identity semantics are now explicitly finalized

`generation` is now clearly documented as the primary client-side convergence key.
`backendRunId` is explicitly documented as observational only.

Evidence:
- `lotus/src/pages/ChatPage/store/slices/executionStateSlice.ts`
- `lotus/src/hooks/useAgentEventSubscription.ts`

This resolves the previous ambiguity in the frontend model.

### 6. Frontend boot recovery now relies on `/runs/active`

The frontend now replays active running sessions via the running snapshot endpoint, rather than depending on summary-only `current_run_id`.

Evidence:
- `lotus/src/services/chat/AgentService.ts#getRunningSessions`
- `lotus/src/pages/ChatPage/store/slices/chatSessionSlice.ts`
- `bamboo/crates/bamboo-server/src/handlers/agent/sessions/handlers/crud/running_snapshot.rs`

This is a strong architectural improvement.

### 7. Previous bamboo warning debt was fixed

The earlier `unused_must_use` warning in `session_loader.rs` is gone.

Evidence:
- `bamboo/crates/bamboo-server/src/app_state/session_loader.rs`
- Targeted `cargo test` run completed with no warnings in the observed output

---

## Remaining Residual Debt

## R1 — `selectShouldObserve` is still not the single enforced observation semantic

### Current state
`selectShouldObserve` is used in reconnect logic, but the primary effect that decides which sessions should have active subscriptions still uses raw map access and `isBusyPhase(...)` directly.

Evidence:
- `lotus/src/hooks/useAgentEventSubscription.ts:1282-1307`
- `lotus/src/hooks/useAgentEventSubscription.ts:1316-1318`

### Why this still counts as debt
The codebase still has two ways to express observation truth inside the subscription system:
- explicit selector-based observation semantics
- raw phase inspection

Today they are equivalent. But for a strict zero-debt standard, there should be only one canonical observation gate.

### Required finish
Replace the raw `isBusyPhase(entry.phase)` checks in Effect A / pending-session retry handling with `selectShouldObserve(...)`-based derivation, or centralize that derivation in a shared helper built on the selector semantics.

---

## R2 — Backend `current_run_id` remains a dead transitional field in `SessionSummary`

### Current state
`SessionSummary.current_run_id` still exists in the backend schema and frontend client types.
But backend production code still initializes it to `None` in `from_entry(...)`, and the session list/detail handlers do not populate it.

Evidence:
- `bamboo/crates/bamboo-server/src/handlers/agent/sessions/types.rs:54-58`
- `bamboo/crates/bamboo-server/src/handlers/agent/sessions/types.rs:89`
- `bamboo/crates/bamboo-server/src/handlers/agent/sessions/handlers/crud/query.rs`
- `lotus/src/services/chat/AgentService.ts:288-289`
- `lotus/src/pages/ChatPage/store/slices/executionStateSlice.ts:713`

### Why this still counts as debt
This field is now superseded in practice by `/runs/active`, but it still exists as a live schema field with transitional commentary implying future population.

That means the API contract is still carrying an unfinished run-identity placeholder.

### Required finish
Choose one:
1. **Populate `current_run_id`** in session summary production paths, or
2. **Remove it** from backend and frontend summary contracts entirely and rely exclusively on `/runs/active` + SSE `execution_started`.

Under strict zero-debt rules, leaving a documented-but-never-populated schema field is still debt.

---

## Validation Performed

### Lotus frontend
- `npx vitest run src/hooks/__tests__/useAgentEventSubscription.test.tsx src/pages/ChatPage/store/__tests__/executionStateSlice.test.ts src/components/QuestionDialog/__tests__/QuestionDialog.test.tsx src/pages/ChatPage/hooks/useChatManager/useMessageStreaming.test.tsx`
  - ✅ 4/4 files passed
  - ✅ 75/75 tests passed
- `npx tsc --noEmit`
  - ✅ passed

### Bamboo backend
- `cargo test -p bamboo-server handlers::agent::sessions --quiet`
  - ✅ 27 passed
- `cargo test -p bamboo-server handlers::agent::execute --quiet`
  - ✅ 48 passed

---

## Final Assessment

This follow-up resolved most of the remaining execution-state refactor debt.

### Resolved in this round
- atomic question/respond state transitions
- removal of component-level respond-mode ownership shells
- selector-backed observation semantics introduced into reconnect logic
- approval/waiting-approval residue removed from lotus production code
- frontend run-identity architecture documented and finalized
- running snapshot boot recovery wired in
- backend warning debt fixed

### Still remaining before a strict “0 debt” claim
- unify **all** subscription observation checks behind `selectShouldObserve`
- eliminate or populate backend `current_run_id`

## Final verdict

**Not yet absolute zero technical debt, but extremely close.**
