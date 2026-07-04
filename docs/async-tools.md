# RFC: Async-by-default tools with a three-class execution taxonomy

**Status:** Draft · **Target file:** `zenith/docs/async-tools.md` · **Repo:** `bamboo` · **Related:** `zenith/docs/subagent-unification.md`, issue #84 (bash completion-push, Phase 2b)

> **Verification:** the load-bearing claims below were adversarially checked against the source by an independent multi-agent pass — **0 refuted**. The refinements it surfaced are folded in; the most important: the *delivery transport* (`pending_injected_messages` → merge) is reusable verbatim, but a fully-generic async tool additionally needs (1) a **generic** completion sink type (the current one is Bash-typed), (2) a synchronous **handle contract** in the emitting round, and (3) an **idle-loop wake backstop** (generalize `waiting_for_bash`) — because the round-boundary drain only runs while the loop is live, so a completion landing on an idle/ended loop would otherwise strand. These are treated as first-class new work in §4 and Phase 2, not "free reuse."

## Summary / TL;DR

Today the Bamboo agent loop treats every tool call as a synchronous barrier: `handle_tool_calls_path` appends the assistant message and then `await`s `execute_round_tool_calls` inside a biased `tokio::select!` whose only competitor is cancellation (`pipeline.rs:878`), so the loop cannot issue its next LLM request until *every* tool call in the last assistant turn has produced a paired `tool_result`. This RFC generalizes the one existing exception — background Bash, which returns a synthetic `{bash_id, status:"running"}` handle immediately and pushes the real result later — into a first-class **execution-mode taxonomy** with three disjoint classes (`Sync`, `AsyncNotify`, `InteractiveSuspend`) and a **generic async-tool completion substrate** that any long-running tool (Bash, SubAgent, **MCP**, WebFetch/WebSearch, deploy) reuses. The one carve-out is interactive `ask_user`-type tools, which suspend for a *human* and must stay on the separate `pending_question` substrate.

**What already exists (the substrate we generalize):** a proven completion-push pipeline for background Bash. The producer `spawn_completion_poll` (`bash_runtime.rs:330`) invokes a `BashCompletionSink` (`bash_completion.rs:51`, `on_bash_completed` at `:53`) on shell exit; the engine's `ChildCompletionCoordinator::on_bash_completed` (`child_completion_coordinator.rs:1072`) hands off to a detached `deliver_bash_completion` → `enqueue_bash_completion_injection` (`:1029`), which appends onto `pending_injected_messages` via the race-safe `update_runtime_config` (`session_merge.rs:183`). The live loop drains it at each round boundary via `state_bridge::merge_pending_injected_messages` (`pipeline.rs:1118`, impl `state_bridge.rs:92`, appends `Message::user` at `:112`). A durable end-of-turn suspend (`maybe_suspend_for_outstanding_bash`, `pipeline.rs:263` → `suspend_to_wait_for_bash`, `:212`) plus a poll-based self-resume is the backstop. This RFC turns that Bash-specific plumbing into a payload-agnostic, per-tool-family mechanism.

## The protocol constraint

Async can **only** mean "return a synthetic running-handle `tool_result` now, deliver the real result later as a separate appended message." This is forced by the wire protocol, enforced identically across all three providers and *also* re-enforced by the engine itself:

| Layer | Constraint | Evidence (file:line, symbol) |
|---|---|---|
| Anthropic | assistant `tool_use` block must be answered by a `tool_result` block keyed by `tool_use_id` in the *immediately following* user turn; strict user/assistant alternation, 400s on two same-role turns | `anthropic/mod.rs:1007` `tool_call_to_tool_use_block`; `:838-897` `Role::Tool`→user `tool_result` w/ `tool_use_id`; `:697-706` alternation+coalescing comment |
| OpenAI chat | `role:"tool"` message carries `tool_call_id`, must reference a preceding assistant `tool_calls` | `openai_compat.rs:35-53` |
| OpenAI Responses | `function_call` item + `function_call_output` item paired by `call_id` | `openai_responses.rs:69-88` |
| **Engine (provider-agnostic)** | before serialization, assistant tool_calls lacking a matching `Role::Tool` result are **stripped**; orphan `Role::Tool` results whose id matches no call are **pruned**; a turn left with an unresolved call is **rewound** to the user anchor | `truncation.rs:36` `sanitize_malformed_tool_chains`; `:95-105` prune orphan; `:11` `unresolved_tool_call_ids`; `:136` `truncate_for_unresolved_tool_calls` |

Consequences that fix the design space:
- **The synthetic ack is mandatory, not a choice.** The Bash path already does exactly this: `bash.rs:621-627` (force-background) and `:424` (auto-promotion hand-off) return an immediate `ToolResult{ result:{bash_id, status:"running", …} }` that *is* the `tool_result` closing the call, so the `pipeline.rs:878` barrier is satisfied instantly and the loop proceeds.
- **The real result cannot be a second `tool_result` for the same id.** Appended late, it is an orphan → pruned by `truncation.rs:95-105`; the only structurally legal binding is an *in-place edit* of the synthetic result, which is cache-busting (see §8) and races the live loop that already streamed the synthetic bytes upstream.
- **Therefore the real result is delivered as an appended message** (`state_bridge.rs:112`, `Message::user(content)`). Because it extends the tail rather than mutating mid-history, it preserves prompt-cache prefix stability (`cache.rs:6-12`: a hit requires byte-identical prefix; volatile content ordered last).

## Taxonomy (3 classes)

A new **orthogonal** axis. It does not replace `ToolMutability{ReadOnly,Mutating}` (`mod.rs:126`, used for approval + parallel scheduling) or `ToolCategory` (`guide/mod.rs:85`, prompt grouping only) — it sits beside them as an *execution-mode* classifier.

```
                       execute() returns…                completion re-enters loop via…
Sync              real result, in-round (awaited)        n/a — already in the tool_result
AsyncNotify       synthetic {handle,status:running}      pending_injected_messages (machine push)
InteractiveSuspend inert {status:awaiting_*} payload     pending_question → respond API (human answer)
```

### (a) Sync — fast local, unchanged
- **Definition:** sub-ms to low-ms local work; latency is negligible so a handle would add pure round-trip overhead.
- **Execution model:** awaited in-round exactly as today (`per_call.rs:182` `execute_tool_call_with_context`). Read-only members still batch concurrently via `join_all` with per-tool + batch timeouts (`tool_execution.rs:527-578`); mutating members remain sequential barriers and preserve order-of-apply.
- **Examples:** Read, Grep, Glob, GetFileInfo, Write, Edit, NotebookEdit, Workspace, session_note, memory_note, update_goal, BashOutput, KillShell, load_skill, session_history/recall/session_inspector, Sleep, compact_context.

### (b) AsyncNotify — long-running, return a handle, push completion
- **Definition:** wall-clock-unbounded machine work whose result is fully determined by the work itself (no human input). Blocking the round on it starves the loop.
- **Execution model:**
  - **run:** the executor (or a promotion wrapper) returns a synthetic `{handle, status:"running"}` `tool_result` in-round (Bash template: `bash.rs:621-627`); the real work runs on a detached task registered in the in-flight async-tool registry (§4).
  - **notify:** on completion the detached task calls `AsyncToolCompletionSink::on_tool_completed` (§4), which enqueues onto `pending_injected_messages`.
  - **resume:** a *live* loop drains at the next round boundary (`pipeline.rs:1118`); an *idle/suspended* loop is revived by the durable `waiting_for_async_tools` backstop (§4, generalized from `waiting_for_bash`).
- **Examples:** Bash (background/promoted), SubAgent (child sessions — already push-completes via `on_child_completed`, `child_completion_coordinator.rs:400`), **MCP tools** (§5), WebFetch, WebSearch, cluster/broker **deploy** tools.

### (c) InteractiveSuspend — suspend for a human (the exception)
- **Definition:** the tool's result is a *human decision* with unbounded latency whose *content* (chosen option / approve-deny) becomes the tool result and *mutates session state* (plan-mode transition, permission grant). A background handle is meaningless here.
- **Execution model:**
  - **run:** `execute()` is pure and synchronous — it returns an inert `{status:"awaiting_user_input"|"awaiting_permission_approval", display_preference:…}` payload (`conclusion_with_options.rs:198`, `request_permissions.rs:164`, `enter_plan_mode.rs:63`, ExitPlanMode). The tool itself does not pause.
  - **suspend:** the engine's result classifier (`should_handle_user_question_tool`, `clarification/payload.rs:27`) sets `pending_question`, stamps `runtime.suspend_reason="awaiting_clarification"` (`clarification.rs:328/336`), marks `awaiting_clarification` (`success_path.rs:53`), and the loop breaks with `should_break:true, sent_complete:false` (`pipeline.rs:916`) → durable `Suspended` (`pipeline.rs:1453`). **No live task waits.**
  - **resume:** a *separate new run* triggered by a human POST to the respond endpoint — `submit_pending_response` takes the pending question, overwrites the placeholder tool-result with the answer, applies plan/permission transitions, sets `clarification_resume_pending` (`respond.rs:84/117/148`). Gold auto-answer routes through the *same* human path (`gold_auto_answer/mod.rs:218`, `submit_pending_response_with_source(…Gold)`).
- **Examples:** conclusion_with_options, request_permissions, EnterPlanMode, ExitPlanMode; plus any mutating tool for which the permission gate *synthesizes* an `awaiting_permission_approval` result (`executor.rs:378`). BashInput is a practical Sync-immediate member (feeds a live shell's stdin) that must not be promoted.

## The generic substrate

Generalize the Bash-specific plumbing into a payload-agnostic, three-layer wiring that mirrors the existing split (trait in core / producer in tools / impl in engine, `bash_completion.rs:12-16`).

### New types

| Type | Crate / file | Peer of (template) |
|---|---|---|
| `enum ToolExecKind { Sync, AsyncNotify, InteractiveSuspend }` | `bamboo-agent-core/src/tools/mod.rs` | `ToolMutability` (`mod.rs:126`) |
| `Tool::execution_kind()` / `call_execution_kind(args)` → `ToolExecKind` (default `Sync`) | `bamboo-agent-core/src/tools/registry.rs` | `mutability`/`call_mutability` (`registry.rs:109`) |
| `ToolExecutor::tool_execution_kind` / `call_execution_kind`; fuse into the once-per-call resolver | `bamboo-agent-core/src/tools/executor.rs`, `bamboo-tools/src/executor.rs` | `call_parallel_classification` (`executor.rs:448`) |
| `struct AsyncToolCompletionInfo { session_id, tool_call_id, tool_name, result }` | `bamboo-agent-core/src/tools/async_completion.rs` (new) | `BashCompletionInfo` (`bash_completion.rs:20`) |
| `trait AsyncToolCompletionSink { fn on_tool_completed(&self, info) }` (cheap, non-blocking, idempotent) | same file | `BashCompletionSink` (`bash_completion.rs:51`) |
| `async_completion_sink: Option<&'a Arc<dyn AsyncToolCompletionSink>>` + `cloned_async_completion_sink()` | `bamboo-agent-core/src/tools/context.rs` | `bash_completion_sink` (`context.rs:89/184`) |
| `async_completion_sink` + `async_tool_resume_hook` late-bound `Option<Arc<dyn …>>` fields | `bamboo-engine/src/runtime/config.rs` | `bash_completion_sink` (`config.rs:464`) / `bash_resume_hook` (`config.rs:450`) |
| `struct WaitingForAsyncToolsState { pending: HashSet<ToolCallId>, … }` | `bamboo-domain/src/session/runtime_state.rs` | `WaitingForBashState:194` / `WaitingForChildrenState:143` (shares `SuspensionState:221`) |
| `AsyncToolRegistry` (per-session in-flight table keyed by `tool_call_id`, liveness query `outstanding_for_session`) | `bamboo-tools` (or core) | shell `DashMap` + `running_shells_for_session` (`bash_runtime.rs:558`) |

### Delivery half — REUSE VERBATIM (payload-agnostic)
`merge_pending_injected_messages` reads only a `content` string (`state_bridge.rs:110-115`), so it needs **zero change**. The engine's `AsyncToolCompletionSink` impl on `ChildCompletionCoordinator` adds `deliver_async_tool_completion` → `enqueue_async_tool_completion_injection` (copy of `child_completion_coordinator.rs:1029`), formatting `AsyncToolCompletionInfo` into the body and pushing via `update_runtime_config` (never `merge_save_runtime`, which snapshots whole `messages` and would clobber). The executor returns the synthetic handle for `AsyncNotify` calls; a wired sink + `can_async_resume` (already on `ToolExecutionContext`, `context.rs:78`) gates promotion exactly like Bash.

### Durability half — MUST BUILD (per-family, generalize don't copy)
Add a `waiting_for_async_tools` suspend flavor: `maybe_suspend_for_outstanding_async_tools` (peer of `pipeline.rs:263`, called alongside the existing bash/children gates ~`pipeline.rs:1300`), `suspend_to_wait_for_async_tools` writing `WaitingForAsyncToolsState`, a `"waiting_for_async_tools"` `suspend_reason` + a matching **finalization arm** (peer of the `waiting_for_bash` arm at `pipeline.rs:1539`, which defensively reloads to avoid clobbering the resume writer). Resume is **push** where an authoritative completion event exists (MCP future resolves, child terminal notification) — following the children model (`on_child_completed`, no poll) rather than Bash's poll loop.

### Executor early-return contract — MUST BUILD
Today only Bash escapes the `pipeline.rs:878` barrier, and it does so by the *tool itself* returning fast. Generalize: in the per-call dispatch, when `call_execution_kind == AsyncNotify` **and** a sink is wired, spawn the real work + register in `AsyncToolRegistry` + return the synthetic handle — so the barrier is satisfied in-round for *any* AsyncNotify tool without dismantling the barrier. The barrier stays; the tool result it awaits is just the fast synthetic ack.

## MCP async

**Where MCP dispatches today (fully synchronous):** `CompositeToolExecutor::execute_with_context` tries builtin, then delegates to MCP with *context explicitly dropped* — `"Try MCP (context ignored by default)"` (`executor.rs:230-231`). `McpToolExecutor::execute` (`executor.rs:74`) awaits `manager.call_tool` (`lifecycle.rs:126`) inline — a single JSON-RPC `tools/call` round trip (`client.rs:276`) bounded by `request_timeout_ms` default **60000ms** (`mcp_config.rs:358`), serialized past a per-server semaphore of 4 (`manager/mod.rs:25`). Crucially `McpToolExecutor` overrides only `execute`, **not** `execute_with_context`, so the core default falls back to `execute()` (`core executor.rs:82`) — it holds no `session_id` and receives no `ToolExecutionContext`, hence **no channel to push a completion**. MCP tools also classify as `Mutating` (unknown ⇒ `Mutating`, `mod.rs:155-163`) so they run the sequential path, which has **no per-tool timeout** (`tool_execution.rs:679-714`) — a slow MCP call holds the whole round for up to 60s.

**The change (concrete):**
1. **Thread the context through.** Stop dropping `ctx` in `CompositeToolExecutor::execute_with_context` (`executor.rs:230-231`); pass it into the MCP layer.
2. **Add `McpToolExecutor::execute_with_context`.** Read `ctx.session_id`, `call.id` (tool_call_id), and `ctx.async_completion_sink`. Spawn the `manager.call_tool` future on a detached task registered in `AsyncToolRegistry`; on resolution call `sink.on_tool_completed(AsyncToolCompletionInfo{…})`. Return the synthetic `{handle:call.id, status:"running"}` in-round.
3. **Latency-adaptive promotion (recommended).** Since MCP is a single round trip (no stream to foreground-then-promote like a shell), shadow-await the call future against a short timer: if it resolves under the threshold, return the real result inline (fast MCP stays sync-feeling); if it exceeds the threshold, return the synthetic handle and let the in-flight future push. This avoids handle overhead on fast MCP calls.
4. **Preserve QoS.** The spawned task still acquires the semaphore permit (`lifecycle.rs:138`) and passes the circuit breaker, so `max_concurrent_calls`/breaker accounting is intact.
5. **Interactive MCP stays interactive.** The result-level classifier (§6) runs on MCP results too, so an MCP tool emitting an `awaiting_*` / elicitation payload is routed to `InteractiveSuspend`, never swept into `AsyncNotify`.

**Backstop caveat:** MCP has no server-side resumable handle, so its durable liveness token is the in-process `JoinHandle`. Across a process restart, in-flight MCP work is unrecoverable → MCP's backstop is **push-only** (weaker than Bash's poll-the-registry guarantee). Document this explicitly; it is an accepted limitation, not a bug.

## The interactive exception

`ask_user`-type tools must stay on the human `pending_question` substrate and must **not** be folded into `AsyncNotify`, because the two substrates are architecturally opposite:

| | AsyncNotify (machine) | InteractiveSuspend (human) |
|---|---|---|
| Trigger | work completion (content already known) | human decision (unbounded latency) |
| Loop state | **stays alive**, drains at round boundary | **torn down** to `Suspended`, resumed by a *new* run |
| Delivery | `pending_injected_messages` (`pipeline.rs:1118`) | `pending_question` + respond API (`respond.rs:84`) |
| Side effects | none (append result) | mutates state: overwrites placeholder result, plan-mode transition, permission grant + `reexecute_tool_call_id` (`respond.rs:117/148`) |
| suspend_reason | `waiting_for_async_tools` (new, work-gated) | `awaiting_clarification` / `awaiting_parent_approval` (human-gated) |

**What guards the distinction (the two suspend flavors):** the `suspend_reason` match block already cleanly separates human-gated arms (`awaiting_clarification` `pipeline.rs:1453`, `awaiting_parent_approval` `:1462`) from work-gated arms (`waiting_for_children` `:1475`, `waiting_for_bash` `:1539`). The new `waiting_for_async_tools` arm sits **alongside** these — it must never reuse `awaiting_clarification`. Two hard guards:
- `should_handle_user_question_tool` (`clarification/payload.rs:27`) must keep **short-circuiting first**: any result whose shape is `awaiting_*` or `display_preference=="request_permissions"` routes to the human path *before* any async-handle treatment — this catches the *synthesized* permission gate (`executor.rs:378`) and MCP elicitation, which are not known a-priori from the tool name.
- Child sessions cannot answer their own permission prompts; `try_delegate_child_approval` (`clarification.rs:298`) suspends `awaiting_parent_approval` **without** setting a child pending_question (to avoid stranding). This "no human attached ⇒ delegate-or-strand" logic is nonsensical for work-completion tools and confirms the classes must not merge. Gold auto-answer (`gold_auto_answer/mod.rs:44`) sweeping these would break if they were reclassified async.

## Classification table

Every current built-in (+ MCP, + SubAgent/Task) assigned to a class. `Sync` is the default (`execution_kind()` default).

| Tool | Class | Rationale |
|---|---|---|
| Read, GetFileInfo | Sync | local file read, sub-ms; read-only batchable |
| Glob, Grep | Sync | local FS search, low-ms; read-only batchable |
| Write, Edit, NotebookEdit | Sync | local file mutation, low-ms; sequential barrier preserved |
| Workspace | Sync | local metadata; read-only |
| session_note, memory_note, memory | Sync | local store read/write; args-aware read=parallel |
| session_history, recall, session_inspector | Sync | local history read; read-only |
| update_goal | Sync | local metadata write |
| compact_context | Sync | loop-control; keep in-band (also plan-mode-exempt, `tool_execution.rs:50`) |
| Sleep | Sync | bounded deliberate wait; no result to push |
| load_skill, read_skill_resource | Sync | local resource read |
| scheduler | Sync | registers a schedule locally; the *scheduled run* is separate infra |
| BashOutput | Sync | polls existing shell buffer; read-only |
| KillShell | Sync | control op on existing shell |
| BashInput | Sync (immediate) | feeds a live shell's stdin; must be in-band, never promoted |
| js_repl | Sync (promotable) | short evals inline; may adopt Bash-style promotion if long-running |
| **Bash** (background / auto-promoted) | **AsyncNotify** | already async-by-default; `bash.rs:621-627` synthetic handle + `spawn_completion_poll` |
| **SubAgent** | **AsyncNotify** | child runs detached; already push-completes via `on_child_completed` (`:400`) |
| Task | Sync (task-list) / AsyncNotify (if it spawns a child) | list writes are local; a child-delegating Task follows the SubAgent path |
| **WebFetch, WebSearch** | **AsyncNotify** | unbounded network I/O; read-only so also parallel-schedulable |
| **MCP tools** (default) | **AsyncNotify** | remote JSON-RPC up to 60s (`mcp_config.rs:358`); §5 |
| **MCP tools** emitting `awaiting_*` / elicitation | **InteractiveSuspend** | result-level classifier reroutes to human path |
| deploy (cluster/broker) | **AsyncNotify** | long-running remote provisioning |
| conclusion_with_options | InteractiveSuspend | `awaiting_user_input` payload → `pending_question` |
| request_permissions | InteractiveSuspend | `awaiting_permission_approval`; human approve/deny |
| EnterPlanMode, ExitPlanMode | InteractiveSuspend | plan-mode transition needs human confirmation |
| *any mutating tool via permission gate* | InteractiveSuspend (at result-time) | gate synthesizes `awaiting_permission_approval` (`executor.rs:378`) |

## Unification

Today three completion mechanisms coexist on `ChildCompletionCoordinator`: `on_child_completed` (children, push, `:400`), `on_bash_completed` (bash, `:1072`), and — proposed — `on_tool_completed` (generic async tools). Converge them onto **one async-work-completion coordinator**:
- **One sink abstraction:** `AsyncToolCompletionSink` subsumes `BashCompletionSink`; Bash becomes just an `AsyncNotify` tool whose producer calls the generic sink. SubAgent's `WorkerHandle` (from the subagent-unification RFC) is the natural handle an `AsyncNotify` SubAgent returns.
- **One in-flight registry:** `AsyncToolRegistry` keyed by `tool_call_id` replaces the ad-hoc shell `DashMap` liveness query for the suspend gate; children/bash/MCP all register here.
- **One wait state:** `WaitingForAsyncToolsState` (a `HashSet` of outstanding `tool_call_id`s, fixed "all" policy to start — Bash's model — with a policy enum reserved for later parity with `ChildWaitPolicy`) subsumes `waiting_for_bash` and can eventually subsume `waiting_for_children`.
- **One delivery channel:** `pending_injected_messages` is *already* shared — no change.

**True `tool_result` binding vs injected user-message — recommendation.** The protocol map is decisive: a late second `tool_result` for an already-answered id is an orphan (pruned, `truncation.rs:95-105`); the only legal binding is an in-place edit of the synthetic result, which (a) busts the prompt-cache prefix from that mid-history message onward (`cache.rs:6-12`, breakpoints nearest-end at `cache.rs:527-563`), (b) races the live loop that already streamed the synthetic bytes, and (c) is invisible to `sanitize_malformed_tool_chains` reasoning. **Recommendation: keep the append-user-message delivery** (Bash's proven, cache-safe form) **but repair role fidelity structurally**:
- Make the sink payload **typed** (`AsyncToolCompletionInfo{tool_call_id, tool_name, result}`), moving body formatting into the engine consumer so `tool_call_id`/`tool_name` drive UI/threading/compression rather than being scraped from prose (today `bash_completion_injection_body` bakes prose, `:985-1005`).
- Deliver as a **runtime-tagged** message (role `user` on the wire for protocol legality, but `runtime_kind=async_tool_completion` for UI, compression, and structural correlation) — mirroring the hidden compressible resume messages children already use (`:400`, folded via `runtime_kind`). This gives compression a structural signal (answering the "summarizer can't tell it belongs to a call" open question) without an out-of-band `tool_result`.

**Relation to the subagent-unification RFC.** That RFC unifies how workers are *provisioned/transported* (one `ProvisionSpec`/`WorkerHandle`/registry/resolver across PULL-actor and PUSH-broker families). This RFC is its **loop-facing dual**: it unifies how a worker's *completion re-enters the agent loop*. They meet at the coordinator — `WorkerHandle` is the AsyncNotify handle; `on_child_completed` is one implementation of `AsyncToolCompletionSink`. Land the sink abstraction so both RFCs share it.

## Phased plan

**Phase 0 — Taxonomy scaffolding (no behavior change).** Add `ToolExecKind` + `Tool::execution_kind`/`call_execution_kind` (default `Sync`) + `ToolExecutor` resolver fused into the once-per-call classifier. All tools default `Sync` ⇒ byte-for-byte identical behavior. *Files:* `bamboo-agent-core/src/tools/mod.rs`, `registry.rs`, `executor.rs`; `bamboo-tools/src/executor.rs`.

**Phase 1 — Generic sink + delivery, Bash migrated.** Add `AsyncToolCompletionInfo`/`AsyncToolCompletionSink` (core), `async_completion_sink` on `ToolExecutionContext` + `AgentLoopConfig`, engine impl `on_tool_completed`→`enqueue_async_tool_completion_injection` (copy of `:1029`). Re-point Bash's producer at the generic sink; verify identical output. Delivery half only — no new suspend state yet (Bash keeps `waiting_for_bash` for now). *Files:* `async_completion.rs` (new), `context.rs`, `config.rs`, `child_completion_coordinator.rs`, `bash_runtime.rs`.

**Phase 2 — Generic durability + registry.** Add `AsyncToolRegistry` (liveness), `WaitingForAsyncToolsState`, `maybe_suspend_for_outstanding_async_tools`, `"waiting_for_async_tools"` finalize arm (peer of `pipeline.rs:1539`), `AsyncToolResumeHook`. Fold `waiting_for_bash` into it. *Files:* `runtime_state.rs`, `pipeline.rs`, `child_completion_coordinator.rs`, `bamboo-tools` registry.

**Phase 3 — MCP async.** Thread `ctx` through `CompositeToolExecutor::execute_with_context` (`executor.rs:230`); add `McpToolExecutor::execute_with_context` with shadow-await-then-promote + sink push; register in `AsyncToolRegistry`; keep QoS/breaker. Classify MCP `AsyncNotify`. *Files:* `bamboo-mcp/src/executor.rs`, `manager/lifecycle.rs`.

**Phase 4 — Result-level interactive guard hardening.** Move interactive detection to a first-class `InteractiveSuspend` `execution_kind`, but keep `should_handle_user_question_tool` (`payload.rs:27`) as the belt-and-suspenders result-level short-circuit for synthesized permission gates + MCP elicitation. *Files:* interactive tools' `execution_kind`, `clarification/payload.rs`.

**Phase 5 — SubAgent/deploy + WebFetch/WebSearch opt-in.** Migrate SubAgent completion onto `AsyncToolCompletionSink`; converge with subagent-unification `WorkerHandle`. Opt WebFetch/WebSearch/deploy into `AsyncNotify` (measure value — see Risks). *Files:* `child_completion_coordinator.rs`, web/deploy tools.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Model ignores injected-user-message results** (no code forces it to re-read the handle; correlation is prose today, `:985-1005`) | Typed, runtime-tagged completion messages (§8) + explicit "act on this result" phrasing; measure tool-use quality before broad rollout (Phase 5 gated on this). |
| **Multiple concurrent completions race between rounds** | All enqueue via race-safe `update_runtime_config` (`session_merge.rs:183`); confirm coalescing/ordering when N land in one round. |
| **Three simultaneous suspend discriminants** (children + bash + async) at end-of-turn | Unify onto one `WaitingForAsyncToolsState`; until then keep gates independent and idempotent (existing pattern). |
| **Detached async tool outlives the `select!` cancel** (foreground futures are dropped on cancel, `pipeline.rs:878`; a detached one is not) | Reap via `AsyncToolRegistry` on cancel; give each family kill/reap wiring like Bash's `kill_on_drop`. |
| **Handle overhead on fast MCP/network calls** | Latency-adaptive shadow-await-then-promote (§5); Sync stays the default. |
| **In-place tool_result editing tempts a "cleaner" binding** | Explicitly rejected (§8): orphan-prune + cache-bust + live-loop race. |
| **MCP across-restart in-flight work lost** (push-only backstop) | Documented limitation; MCP handle result tells the model to re-issue if needed. |
| **Prefix-stability regression** if Sync read-only batches were ever made async | Out of scope: Sync tools keep order-preserving in-round apply (`tool_execution.rs:638-674`); only tail-appended completions are async. |

## Open decisions

Calls the **user** must make; each with tradeoff + recommended default.

1. **Adaptive vs static async.** Latency-adaptive (foreground-then-promote, Bash's ~10s model) vs static per-tool flag. *Tradeoff:* adaptive avoids handle overhead on fast calls but needs a promotion path MCP's single round trip doesn't natively stream. **Default: adaptive** via shadow-await-then-promote for MCP/network; static for Bash/SubAgent (already handle-first).
2. **Completion delivery shape.** Append runtime-tagged user message vs in-place tool_result edit. *Tradeoff:* append is cache-safe + protocol-legal but role-inexact; edit is role-exact but cache-busting + racy + orphan-prone. **Default: append + typed runtime tag** (§8).
3. **Unify `waiting_for_children` into `waiting_for_async_tools` now or later.** *Tradeoff:* full unification is cleaner but touches the delicate children finalize/clobber logic. **Default: unify bash first (Phase 2), children later (Phase 5).**
4. **WebFetch/WebSearch async at all.** They are already parallel-scheduled read-only, so the batch may already hide their latency. *Tradeoff:* async adds complexity for possibly-marginal gain. **Default: keep Sync-batched initially; opt in only if measurement shows round starvation.**
5. **Durable backstop for MCP.** In-process poll (hold `JoinHandle`) vs push-only. *Tradeoff:* poll survives lost-wakeups within a process but not restart; push-only is simpler. **Default: push-only for MCP, documented; poll for Bash/children which have re-observable state.**
6. **Wait policy granularity.** Fixed "all" (Bash) vs policy enum (All/Any/FirstError, children). **Default: fixed "all" for `waiting_for_async_tools`; reserve the enum.**

## Feasibility claims

- The LLM wire protocol requires every assistant `tool_call` to be answered by a paired `tool_result` before the next assistant turn, on all three providers, and the engine re-enforces this by stripping/pruning/rewinding unpaired chains (`anthropic/mod.rs:838-897`, `openai_compat.rs:35-53`, `openai_responses.rs:69-88`, `truncation.rs:36-105`).
- A synthetic `{handle, status:"running"}` `tool_result` returned in-round fully satisfies that pairing rule and lets the round proceed, as Bash already proves (`bash.rs:621-627`, `:424`).
- The real result can be delivered later only as an appended message (not a second `tool_result` for the same id), and appending at the tail preserves prompt-cache prefix stability (`state_bridge.rs:112`, `cache.rs:6-12`).
- The delivery **transport** — `update_runtime_config` → `pending_injected_messages` → `merge_pending_injected_messages` — is payload-agnostic (reads only a `content` string, `state_bridge.rs:110-115`) and reusable **verbatim**. (Scope note: "verbatim" is the transport only; a fully-general async tool additionally requires a synchronous handle contract in the emitting round and an idle-loop wake backstop — §4 "Durability half" + Phase 2 — which are *not* in this transport.)
- The completion-sink wiring **topology** (trait in `bamboo-agent-core`, producer in `bamboo-tools`, impl on `ChildCompletionCoordinator` in `bamboo-engine`) already exists (`context.rs:89`, `AgentLoopConfig` field at `config.rs:464`) and the peer-field precedent is real (`guardian_spawner`/`bash_resume_hook`/`approval_delegate`). Generalizing it requires a **generic** completion type + trait (the current `BashCompletionInfo`/`on_bash_completed` are Bash-specific), not cloning the Bash peer field per tool.
- No sync/async execution-mode axis exists today (`ToolMutability` `mod.rs:126` and `ToolCategory` `guide/mod.rs:85` are orthogonal), so a new `ToolExecKind` must be added but slots into the existing once-per-call classifier (`executor.rs:448`).
- MCP is currently fully synchronous and context-blind: `CompositeToolExecutor` *does* forward `ctx` to `mcp.execute_with_context` (`executor.rs:231`), but `McpToolExecutor` overrides only `execute` (not `execute_with_context`), so the core default drops `ctx` and falls back to `execute()` (`core executor.rs:82`) — no channel to push a completion. Adding `McpToolExecutor::execute_with_context` is additive, but background async is *not* transparent: it needs the generalized sink (Phase 1) **and** changes the model-facing result contract per MCP tool (synthetic "started" now, injected completion later).
- Interactive tools already ride a *separate* human-answer substrate (`pending_question` + respond API, `respond.rs:84`) distinguished by a distinct `suspend_reason` arm (`pipeline.rs:1453`), so excluding them from `AsyncNotify` requires no new mechanism — only preserving the existing `should_handle_user_question_tool` short-circuit (`payload.rs:27`).