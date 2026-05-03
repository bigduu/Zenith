# Plan: Use `runner_progress` for SubSessionsPanel live activity feel

## Goal
Use the backend `runner_progress` SSE event to improve **SubSessionsPanel** so child sessions feel visibly alive even before token/tool output appears, and optionally show a small secondary round hint such as `Round 1`, `Round 2`.

## Product Decision
`runner_progress` will be treated as a **lightweight liveness/progress enrichment signal**, not as a new primary execution phase.

It should:
- make child sessions transition from `pending` to `running` earlier
- refresh `lastEventAt` so the UI feels active
- optionally expose a secondary `roundCount` hint in child rows

It should **not**:
- introduce a new global execution phase
- participate in convergence / generation identity decisions
- replace token/tool/sub-session-completed events as the authoritative lifecycle markers

---

## Why this is the best fit

### Current problem
Child sessions often appear as:
- `pending` after `sub_session_started`
- then remain visually quiet until one of these arrives:
  - `token`
  - `tool_*`
  - `sub_session_heartbeat`
  - `sub_session_completed`

That creates a stale-feeling gap for long-thinking or multi-round child runs.

### Why `runner_progress` helps
The backend emits `RunnerProgress { session_id, round_count }` at the **start of each agent turn**. That gives the frontend an early signal that:
- the child is truly executing
- a new round has started
- the child should be presented as active

This is most valuable in **SubSessionsPanel**, where users expect lightweight but continuous visibility into background child work.

---

## Existing architecture touchpoints

### Backend emission
- `bamboo/crates/bamboo-engine/src/runtime/runner/loop_execution/pipeline.rs`
  - emits `AgentEvent::RunnerProgress { session_id, round_count }`

### Frontend event parsing gap
- `lotus/src/services/chat/AgentService.ts`
  - currently does not include `runner_progress` in `AgentEventType`
  - currently logs it as `Unknown event type`

### Frontend child progress model
- `lotus/src/pages/ChatPage/store/slices/executionStateSlice.ts`
  - `ChildProgress` already stores:
    - `status`
    - `lastHeartbeatAt`
    - `lastEventAt`
    - `outputPreview`
- `lotus/src/hooks/useAgentEventSubscription.ts`
  - already updates child progress on:
    - `sub_session_started`
    - `sub_session_event`
    - `sub_session_heartbeat`
    - `sub_session_completed`
- `lotus/src/pages/ChatPage/components/ChatView/SubSessionsPanel.tsx`
  - already renders child status, timestamps, and preview text

This means the feature can be added incrementally without redesigning the state model.

---

## Proposed UX

### Primary visible improvement
When a child session begins a round, the row should:
- show `running` if it was still `pending`
- update its activity timestamp via `lastEventAt`

### Secondary visible improvement
Show a subtle round hint on the child row, e.g.:
- `running • round 1`
- `running • round 2`

The round hint should be:
- secondary / low visual weight
- optional and hidden when unknown
- not treated as a hard progress bar or completion percentage

### Non-goal for v1
Do **not** add round hint to the main chat rail in this change. Keep this scoped to `SubSessionsPanel` only.

---

## Minimal data model change

Extend `ChildProgress` in:
- `lotus/src/pages/ChatPage/store/slices/executionStateSlice.ts`

Add optional field:

```ts
roundCount?: number;
```

Reasoning:
- this is child-row-specific UI data
- it does not belong in the main root execution phase model
- it composes naturally with `status` and `lastEventAt`

---

## Event plumbing plan

### 1. Teach AgentService to recognize `runner_progress`
File:
- `lotus/src/services/chat/AgentService.ts`

Changes:
- add `"runner_progress"` to `AgentEventType`
- add `round_count?: number` to `AgentEvent`
- add an optional callback to handlers, e.g.:

```ts
onRunnerProgress?: (sessionId: string, roundCount: number) => void;
```

- in `handleEvent()`, add:

```ts
case "runner_progress":
  if (event.session_id && typeof event.round_count === "number") {
    handlers.onRunnerProgress?.(event.session_id, event.round_count);
  }
  break;
```

### 2. Route nested child `runner_progress` via existing `sub_session_event`
File:
- `lotus/src/hooks/useAgentEventSubscription.ts`

Within `onSubSessionEvent(parentSessionId, childSessionId, evt)`:
- detect `evt.type === "runner_progress"`
- update child progress:
  - `status: "running"`
  - `roundCount: evt.round_count`
  - `lastEventAt: now`

Recommended behavior:
- if `round_count` is present, overwrite with latest value
- do not clear `outputPreview`
- do not alter completion/error state from terminal events

Pseudo:

```ts
if (evt.type === "runner_progress") {
  applyChildProgress(parentSessionId, childSessionId, {
    status: "running",
    roundCount: evt.round_count,
    lastEventAt: new Date().toISOString(),
  });
  return;
}
```

### 3. Optional direct root-session handling
For this scoped feature, root-session `runner_progress` can be recognized but ignored.

That means:
- the warning disappears
- no new root UI behavior is introduced yet

This keeps the change focused and low-risk.

---

## Store / slice changes

### Extend ChildProgress
File:
- `lotus/src/pages/ChatPage/store/slices/executionStateSlice.ts`

Add:

```ts
roundCount?: number;
```

No reducer redesign is needed because:
- `applyChildProgress()` already accepts `Partial<ChildProgress>`
- merging behavior is already correct for additive fields

### No changes to primary execution phase machine
Do not add:
- new `ExecutionPhase`
- new selector just for root round progress
- generation or convergence logic tied to round count

---

## SubSessionsPanel rendering plan

File:
- `lotus/src/pages/ChatPage/components/ChatView/SubSessionsPanel.tsx`

### Display approach
Render round hint as a secondary, inline hint near the status area.

Recommended placement order:
1. child title
2. status tag (`running`, `completed`, etc.)
3. pinned/subagent type tags
4. secondary metadata line with timestamp + optional round

Example metadata line:
- `1cc83489 • 2026-05-03T12:00:00Z • round 2 • heartbeat: ...`

Alternative (cleaner) option:
- keep metadata line as-is
- add a small neutral tag next to status:
  - `Round 2`

### Recommendation
Prefer **secondary metadata text** for v1 because:
- lower visual noise
- avoids too many tags in narrow rows
- keeps `roundCount` explicitly secondary

Pseudo rendering:

```tsx
{typeof it.roundCount === "number" ? ` • round ${it.roundCount + 1}` : ""}
```

Note:
- backend currently emits zero-based `round_count`
- UI should likely display human-friendly one-based numbering (`+ 1`)

---

## Numbering decision

Backend sends:
- first round as `0`

UI should display:
- `Round 1`

Rule:
- store raw backend number in state (`roundCount`)
- format as `roundCount + 1` in UI

This preserves protocol fidelity while keeping UI human-friendly.

---

## Edge cases

### 1. Child is still `pending` and receives `runner_progress`
Expected:
- transition to `running`
- show round hint

### 2. Child already has `outputPreview`
Expected:
- keep preview
- only refresh `status`, `roundCount`, `lastEventAt`

### 3. Child has terminal status (`completed`, `error`, `cancelled`)
Expected:
- later stale `runner_progress` should not revive it

Implementation note:
- stale nested child events are unlikely but the handler should avoid regressing terminal child state if known terminal status is already applied.
- simplest safe rule: if current child status is terminal, ignore `runner_progress`.

### 4. Root session receives `runner_progress`
Expected for this change:
- recognized by parser
- no visible root UI change required

### 5. Missing `round_count`
Expected:
- ignore gracefully
- no warning

---

## Test plan

### AgentService tests
File:
- `lotus/src/services/chat/__tests__/AgentService.test.ts`

Add tests:
1. parses `runner_progress` and calls `onRunnerProgress`
2. does not warn for known `runner_progress` event
3. ignores malformed `runner_progress` lacking `session_id` or numeric `round_count`

### useAgentEventSubscription tests
File:
- `lotus/src/hooks/__tests__/useAgentEventSubscription.test.tsx`

Add tests:
1. nested `sub_session_event` with `runner_progress` marks child `running`
2. nested `runner_progress` updates child `roundCount`
3. nested `runner_progress` refreshes `lastEventAt`
4. terminal child state is not regressed by stale `runner_progress` (if that guard is implemented)

### SubSessionsPanel tests
File:
- `lotus/src/pages/ChatPage/components/ChatView/...` test file if present; otherwise add one near panel tests

Add tests:
1. renders `Round 1` for `roundCount: 0`
2. renders `Round 2` for `roundCount: 1`
3. hides round hint when absent

### Type validation
Run:
- `cd lotus && npx tsc --noEmit`

### Targeted frontend tests
Run minimal affected suite first, e.g.:
- `cd lotus && npx vitest run src/services/chat/__tests__/AgentService.test.ts`
- `cd lotus && npx vitest run src/hooks/__tests__/useAgentEventSubscription.test.tsx`
- targeted SubSessionsPanel test file

---

## Implementation order

1. **Protocol acceptance**
   - update `AgentService.ts` types + event switch
   - remove warning by making event known

2. **Child progress enrichment**
   - add `roundCount` to `ChildProgress`
   - handle nested `runner_progress` inside `onSubSessionEvent`

3. **UI rendering**
   - render subtle round hint in `SubSessionsPanel`

4. **Tests**
   - AgentService parser test
   - hook/store behavior tests
   - panel rendering tests

5. **Validation**
   - typecheck + targeted vitest

---

## Risk assessment

### Low-risk parts
- parser/type addition in `AgentService`
- additive `ChildProgress.roundCount`
- metadata-only UI text in `SubSessionsPanel`

### Moderate-risk parts
- avoiding accidental regression of terminal child state
- making sure nested child `runner_progress` is handled only where intended

### Explicitly avoided risks
This plan avoids:
- main execution rail redesign
- root execution phase changes
- generation/convergence changes
- backend protocol changes

---

## Recommended acceptance criteria

The feature is done when:
1. `runner_progress` no longer logs as unknown in the frontend
2. child rows move to visible `running` state when child progress starts even before token output
3. child rows show a subtle round hint (`Round N`) when available
4. terminal child states are not regressed by later progress noise
5. TypeScript and targeted tests pass

---

## Future follow-up (not in this change)
If this proves useful, a later enhancement could reuse the same signal for:
- root `ExecutionStatusRail` subtitle like `Thinking · Round 2`
- richer child diagnostics like `running tool: Bash`
- liveness timeout heuristics based on `lastEventAt`

But those should remain separate follow-up work, not part of the initial scoped change.
