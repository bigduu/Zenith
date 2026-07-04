# Tool v2 — Clean-Slate Async-Native Tool Trait with Per-Call `ToolOutcome`

Status: Proposed (single-epic, full rewrite, deletes v1)
Scope: `bamboo` agent runtime — the tool trait, the executor dispatch seam, and the loop tool-barrier
Decision already taken (not re-litigated here): clean-slate rewrite. One async-native `ToolV2` trait; one entry `invoke` returning a per-call `ToolOutcome`; migrate all ~35 production tool surfaces; rewrite the executor + both loop consumers; delete the v1 `Tool` trait and the `execute`/`execute_with_context` split.

> **Verification:** load-bearing claims below were adversarially checked against the source (0 refuted). Three scope sharpenings the check surfaced, folded in: (1) the `Running` runtime's *transport* reuses verbatim, but generalizing needs a generic sink payload + consumer-format change + a generic `waiting_for_async_tools` durable backstop (not "merely widen the payload"); (2) `NeedsHuman` must still emit the synthetic paired ack, `set_pending_question`, stamp the `suspend_reason` marker, **and** preserve the distinct child→parent-approval branch (`try_delegate_child_approval`); (3) the agentic result-handling is **duplicated across ~4 surfaces**, not one funnel — see §5.4.

---

## 1. Summary / TL;DR

Today a tool statically *is* one kind of thing — its `ToolResult` (`crates/core/bamboo-domain/src/tool_types.rs:16`) is a plain struct, and the loop **infers** async/interactive behavior *after the fact* by sniffing string markers on that result (`is_waiting_for_children_control`, `crates/core/bamboo-agent-core/src/tools/result_handler.rs:21`; `should_handle_user_question_tool`, `crates/engine/bamboo-engine/src/runtime/runner/tool_execution/clarification/payload.rs:27`). v2 makes the tool **declare its per-call disposition as its return value**.

| v1 (today) | v2 |
|---|---|
| `Tool` trait with `execute` + `execute_with_context` split (`registry.rs:127`,`:133`) | one `ToolV2` trait, sole entry `async fn invoke(&self, args, ctx) -> ToolOutcome` |
| tool returns `ToolResult`; loop sniffs markers to discover async/interactive intent (`result_handler.rs:15`) | tool returns `ToolOutcome { Completed \| Running \| NeedsHuman }`; loop reads it directly |
| Sync / AsyncNotify / InteractiveSuspend are *static* tool labels (the async-tools RFC taxonomy) | those three become the **per-call** `ToolOutcome` variants; a slow `Completed` can be **runtime-promoted** to `Running` |
| four args-aware hooks: `mutability`/`call_mutability`/`concurrency_safe`/`call_concurrency_safe` (`registry.rs:109-125`) | one args-aware `classify(args) -> ToolClass` |
| MCP "sometimes elicits" needs a result-guard hack | an MCP call simply returns `NeedsHuman` for that call — no guard |

**How v2 subsumes the async-tools RFC.** That RFC's *substrate* (the `BashCompletionSink` → `pending_injected_messages` → `merge_pending_injected_messages` boundary re-entry, and the `pending_question` → `SuspensionState` → `submit_pending_response` suspend/resume) is **already built** and becomes the v2 runtime verbatim. That RFC's *taxonomy* (Sync/AsyncNotify/InteractiveSuspend) stops being a design-time classification and becomes the `ToolOutcome` enum returned per call. Nothing in the transport changes; what changes is that the return type — not a string marker — is authoritative.

Net deletion target: the entire post-hoc inference channel (`ToolHandlingOutcome` + the `display_preference="runtime_control:…"` / `runtime_control` JSON markers + the `should_handle_user_question_tool` sniff), plus the `execute`/`execute_with_context` fork in both `Tool` (`registry.rs`) and `ToolExecutor` (`executor.rs`).

---

## 2. Why v2 over the incremental RFC

The incremental RFC would keep the static taxonomy and bolt async/interactive on as *tool attributes*. Three concrete forces make that the wrong shape given what the code already is:

- **The taxonomy is already per-call, not per-tool.** Bash is the proof: the *same* tool returns a normal foreground `ToolResult` for a fast command and a synthetic `{status:"running"}` for a command that crosses the ~10s promotion deadline (`crates/engine/bamboo-tools/src/tools/bash.rs:384` `promotion_fired` → `adopt_running_child` `:406` → synthetic body `:421`). A static label cannot express "this call was sync, that call was async." `ToolOutcome`-as-return-value expresses it natively.
- **Arg-dependent mutability already exists and would have to be duplicated.** `session_note` (read/list = RO), `Workspace` (get = RO / set = Mut), and `memory` (search/inspect = RO) already override the args-aware hooks (`registry.rs:113`,`:123`). The static taxonomy re-introduces a second, coarser per-tool axis on top of the per-call one that's already there. v2 folds all of it into one `classify(args)`.
- **It kills the MCP result-guard hack.** MCP tools can *elicit* (ask the human) on some calls and not others, but they have **no `impl Tool`** — they are proxied at the executor seam (`McpToolExecutor`, `crates/infra/bamboo-mcp/src/executor.rs:73`; `McpProxyExecutor`, `crates/app/bamboo-broker/src/mcp.rs:606`). Under a static taxonomy you must label the whole proxy "maybe-interactive" and then guard every result to see whether *this* call elicited. Under v2 the proxy just returns `NeedsHuman` for the call that elicited and `Completed` otherwise — the disposition rides the value.

**Runtime latency-adaptive promotion is the genuinely new capability** and it only makes sense in the per-call model: sync-vs-async becomes a property the *runtime* decides by watching the clock, not a property the tool author guesses. Bash already does exactly this by hand (`bash.rs:384`); v2 lifts that one bespoke mechanism into an executor-level wrapper any `promotable` tool inherits for free.

---

## 3. The v2 core types

Rust sketches below are the buildable target shapes. Where the decided signature said `invoke(self, …)`, the realized form is `&self`: tools are stored `Arc`-shared (`SharedTool = Arc<dyn Tool>`, `registry.rs:157`), so by-value `self` is impossible; `&self` is the only sound form and matches every existing tool (all v1 tools are `&self`).

### 3.1 `ToolOutcome` — the per-call return

```rust
/// The per-call disposition of a v2 tool. Replaces the post-hoc string-marker
/// channel (result_handler.rs:15 `ToolHandlingOutcome` + is_waiting_for_children_control
/// at result_handler.rs:21 + should_handle_user_question_tool at payload.rs:27).
pub enum ToolOutcome {
    /// Terminal in-round. Append `ToolResult` as the paired tool_result NOW.
    /// This is today's success/error path (tool_types.rs:16 `ToolResult`).
    /// Loop control == Continue.
    Completed(ToolResult),

    /// The work detaches and continues after `invoke` returns. The executor emits
    /// a synthetic `{handle, status:"running"}` paired tool_result NOW (protocol:
    /// bash.rs:421) and delivers the REAL result later via the existing sink ->
    /// pending_injected_messages -> merge boundary (pipeline.rs:1118).
    /// Loop control == Continue (never breaks — mirrors bash today).
    Running(RunningHandle),

    /// Suspend the turn for a human decision. Carries a fully-formed
    /// `PendingQuestion` (session/types.rs:305) DIRECTLY instead of encoding
    /// intent in result JSON. Loop control == Break.
    NeedsHuman(PendingQuestion),
}
```

The `Completed → Continue`, `Running → Continue`, `NeedsHuman → Break` mapping is not new policy — it is exactly today's `success_path` behavior made explicit: a running bash result is `Continue` (`success_path.rs:118`), a clarification breaks `'tool_calls` (`success_path.rs:53`), and `WaitingForChildren` deliberately does **not** break (`success_path.rs:111`). See §5 for how `WaitingForChildren` folds into `Running`.

### 3.2 `ToolV2` — one trait, no split

```rust
#[async_trait]
pub trait ToolV2: Send + Sync {
    // --- static metadata: unchanged from v1 (registry.rs:102-106) ---
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters_schema(&self) -> serde_json::Value;

    // --- per-call scheduling class: folds the FOUR v1 hooks
    //     (mutability/call_mutability/concurrency_safe/call_concurrency_safe,
    //     registry.rs:109-125) into one args-aware call. No loss: v1's hooks
    //     were already args-aware. ---
    fn classify(&self, _args: &serde_json::Value) -> ToolClass {
        ToolClass::MUTATING_SERIAL // conservative default == v1 default (registry.rs:110)
    }

    // --- THE sole entry. Collapses execute (registry.rs:127) +
    //     execute_with_context (registry.rs:133). Every tool is ctx-aware now;
    //     the execute-only vs execute_with_context fork is gone. ---
    async fn invoke(&self, args: serde_json::Value, ctx: ToolCtx) -> ToolOutcome;

    // --- unchanged (registry.rs:144) ---
    fn to_schema(&self) -> ToolSchema { /* identical body */ }
}

pub type SharedToolV2 = Arc<dyn ToolV2>;
```

```rust
/// One value replacing v1's {mutability, concurrency_safe} pair plus the new
/// promotion opt-in. Args-aware because classify() takes args.
#[derive(Clone, Copy)]
pub struct ToolClass {
    /// Approval/permission gating axis (== v1 ToolMutability, mod.rs:126).
    pub mutability: ToolMutability,
    /// May join the contiguous read-only parallel batch (== v1 concurrency_safe).
    pub parallel_safe: bool,
    /// May be latency-promoted Completed -> Running by the executor. Default
    /// false; opt-in for network/remote/idempotent tools. NEVER for local
    /// non-idempotent writes. (New in v2; answers the promotion-safety question.)
    pub promotable: bool,
}

impl ToolClass {
    pub const MUTATING_SERIAL: Self =
        Self { mutability: ToolMutability::Mutating, parallel_safe: false, promotable: false };
    pub const READONLY_PARALLEL: Self =
        Self { mutability: ToolMutability::ReadOnly, parallel_safe: true, promotable: false };
}
```

### 3.3 `RunningHandle` — the detached-work handle

```rust
pub struct RunningHandle {
    /// The model's tool_call_id — pairs the synthetic ack now with the real
    /// result later (protocol: same-turn paired tool_result).
    pub tool_call_id: String,

    /// The synthetic paired tool_result shown NOW. success == true; body is the
    /// `{handle/bash_id, status:"running"}` shape (bash.rs:421).
    pub ack: ToolResult,

    /// How the REAL result re-enters the loop. Both variants terminate at the
    /// SAME pending_injected_messages -> merge_pending_injected_messages boundary
    /// (pipeline.rs:1118); they differ only in who drives the wait.
    pub completion: RunningCompletion,

    /// Which durable-wait bucket + terminal-gate suspend_reason this belongs to.
    /// Preserves the DISTINCT discriminants the finalize match keys on
    /// (waiting_for_children pipeline.rs:1475 vs waiting_for_bash pipeline.rs:1539).
    /// Do NOT overload these (suspend_reason is a finalize-merge discriminant).
    pub wait_kind: AsyncWaitKind,

    /// Cooperative kill. Bash reaps via kill_on_drop; a promoted future is
    /// aborted by dropping its JoinHandle.
    pub kill: Box<dyn FnOnce() + Send>,
}

pub enum RunningCompletion {
    /// The tool ALREADY wired an out-of-band delivery (Bash: it clones the sink
    /// into bash_runtime::adopt_running_child, bash.rs:406-417). The executor
    /// only records the durable wait as the idle backstop; nothing to drive.
    Detached,
    /// Executor-driven: it awaits this future, then feeds the ToolResult to the
    /// completion sink. This is the vehicle for latency-adaptive promotion —
    /// wrap ANY slow Completed future here with zero per-tool code.
    Driven(futures::future::BoxFuture<'static, ToolResult>),
}

pub enum AsyncWaitKind {
    /// Bash + all executor-driven promoted tools. Terminal-gate reason:
    /// "waiting_for_async_tools" (the generalized rename of "waiting_for_bash").
    AsyncTools,
    /// SubAgent create/wait. Terminal-gate reason: "waiting_for_children"
    /// (unchanged — distinct merge path at pipeline.rs:1491).
    Children,
}
```

### 3.4 `ToolCtx` — owned, unifies the old context + parsed args

Today `ToolExecutionContext` (`crates/core/bamboo-agent-core/src/tools/context.rs:56`) is `Copy`-over-borrows (`&'a`). For v2 it becomes **owned** (Arc-based). This is the one enabling change that makes every `invoke` future `'static`-capable, so a promoted `Completed` future can be moved into the executor's drive task (§4.2) — the same trick Bash already uses by cloning owned handles (`context.rs:184` `cloned_bash_completion_sink`, `:176` `cloned_sender`). It preserves the load-bearing invariant that tool execution never borrows `&mut session` (only apply mutates), so concurrent `join_all` stays sound.

```rust
#[derive(Clone)]
pub struct ToolCtx {
    pub session_id: Option<Arc<str>>,
    pub tool_call_id: Arc<str>,
    /// Streaming progress channel (was &'a mpsc::Sender, context.rs:62).
    pub event_tx: Option<mpsc::Sender<AgentEvent>>,
    /// Snapshot of tools available to the session (was &'a [ToolSchema]).
    pub available_tool_schemas: Arc<[ToolSchema]>,
    /// Per-session flag from ToolExecutionSessionFlags (context.rs:27).
    pub bypass_permissions: bool,
    /// Loop can suspend-and-self-resume for detached work (context.rs:78).
    pub can_async_resume: bool,
    /// Generalizes bash_completion_sink (context.rs:89) to ALL async tools.
    pub async_completion_sink: Option<Arc<dyn AsyncToolCompletionSink>>,
}
```

`AsyncToolCompletionSink` is the generalized `BashCompletionSink` (`crates/core/bamboo-agent-core/src/tools/bash_completion.rs:51`); its info payload carries a `ToolResult` (and `tool_call_id`) instead of the bash-specific `{bash_id, exit_code, output_tail}`:

```rust
pub struct AsyncToolCompletionInfo {
    pub session_id: String,
    pub tool_call_id: String,
    pub result: ToolResult, // the real result to inject as a paired-then-user message
}
pub trait AsyncToolCompletionSink: Send + Sync {
    /// Called once, off the loop, when detached work finishes. MUST stay
    /// idempotent with the durable poll backstop (bash_completion.rs:47).
    fn on_tool_completed(&self, info: AsyncToolCompletionInfo);
}
```

Note `args` is now the explicit `invoke` parameter (the owned parsed value), which retires the `pre_parsed_args` threading field (`context.rs:99`) — the dispatcher parses once and hands the owned value in.

---

## 4. The executor rewrite

### 4.1 Where the change lands, and what stays

| Component | file:line / symbol | v2 disposition |
|---|---|---|
| Cancel barrier | `pipeline.rs:878` biased `tokio::select!` over `cancel_token.cancelled()` vs `execute_round_tool_calls` | **stays verbatim** — outcome-agnostic; wraps the round future as an opaque unit. Cancel-drops-in-flight + `kill_on_drop` preserved (`pipeline.rs:864-877`). |
| Round scheduler | `tool_execution.rs:369` `execute_round_tool_calls` | **kept, re-plumbed** — same contiguous batching (`:418-426`), same `join_all` concurrency (`:529`), same per-tool + per-batch `tokio::time::timeout` (`:527`,`:532`), same **sequential apply in tool_calls order** (`:638`). Classification source flips from `call_concurrency_safe` to `ToolV2::classify(args).parallel_safe`. |
| Parallel classifier | `tool_execution.rs:77` `scheduling_mode_for_tool_call` → `supports_parallel` (`crates/engine/bamboo-tools/src/parallel.rs:55`) | **kept** — now reads `ToolClass.parallel_safe`. |
| Per-call dispatch | `per_call.rs` `execute_tool_call_only` + `apply_tool_execution_outcome` | **collapsed** into one `invoke(args, ctx).await` + the outcome `match` below. The execute/apply split and the `for_dispatch` sink/gate threading (`per_call.rs:158`,`:169`) move into the executor. |

### 4.2 The outcome match (core sketch)

This replaces the body of `execute_and_apply_single_tool_call` (and the `execute_tool_call_only`/`apply_tool_execution_outcome` pair in `per_call.rs`):

```rust
// classify once (args-aware); drives both scheduling and permission gating.
let class = tool.classify(&args);

// Permission gate: a mutating call under a non-bypass session may need approval.
// Today the checker SYNTHESIZES a request_permissions-shaped result and the loop
// sniffs display_preference=="request_permissions" (payload.rs:38). In v2 the
// gate returns NeedsHuman DIRECTLY — no marker, no sniff.
if let Some(pq) = permission_gate(&class, &tool, &args, &ctx) {
    return apply(ToolOutcome::NeedsHuman(pq), &mut state, session);
}

// Latency-adaptive promotion wraps invoke ONLY for promotable tools (§4.3).
let outcome = if class.promotable {
    invoke_with_promotion(&*tool, args, ctx.clone(), promotion_deadline).await
} else {
    tool.invoke(args, ctx.clone()).await
};

match outcome {
    ToolOutcome::Completed(result) => {
        // today's success/error apply: append the paired tool_result in order.
        append_paired_tool_result(session, &ctx.tool_call_id, result);
        Control::CONTINUE
    }

    ToolOutcome::Running(handle) => {
        // Protocol: emit the synthetic paired tool_result NOW (bash.rs:421 shape).
        append_paired_tool_result(session, &handle.tool_call_id, handle.ack);
        // Durable backstop so an idle loop still suspends+resumes for this work.
        register_async_wait(session, handle.wait_kind, &handle.tool_call_id);
        match handle.completion {
            // Bash & SubAgent already wired their own delivery: do nothing here.
            RunningCompletion::Detached => {}
            // Promoted tools: drive the future, then hand its result to the sink,
            // which lands it in pending_injected_messages (merged at pipeline.rs:1118).
            RunningCompletion::Driven(fut) => {
                let sink = ctx.async_completion_sink.clone();
                let (sid, tcid) = (ctx.session_id.clone(), handle.tool_call_id.clone());
                tokio::spawn(async move {
                    let result = fut.await;
                    if let (Some(sink), Some(sid)) = (sink, sid) {
                        sink.on_tool_completed(AsyncToolCompletionInfo {
                            session_id: sid.to_string(), tool_call_id: tcid, result,
                        });
                    }
                });
            }
        }
        Control::CONTINUE // NEVER breaks — remaining same-round calls still run.
    }

    ToolOutcome::NeedsHuman(pq) => {
        // set pending_question + stamp the finalize-match discriminant
        // (result_handler.rs:328). Break so the tail is not executed (§10.5).
        session.set_pending_question_with_source(pq, PendingQuestionSource::PauseTool);
        session.metadata.insert(
            "runtime.suspend_reason".into(),
            suspend_reason_for(&pq).into(), // "awaiting_clarification" | "awaiting_parent_approval"
        );
        state.mark_awaiting_clarification(); // loop_state.rs:25
        Control::BREAK
    }
}
```

### 4.3 Latency-adaptive promotion

```rust
/// Wraps invoke() for a promotable tool. If invoke finishes before the deadline,
/// pass its outcome through unchanged. If it is still running at the deadline,
/// PROMOTE: return Running whose Driven future keeps polling the SAME invoke
/// future. Requires the invoke future be 'static — which owned ToolCtx (§3.4)
/// guarantees.
async fn invoke_with_promotion(
    tool: &dyn ToolV2, args: serde_json::Value, ctx: ToolCtx, deadline: Duration,
) -> ToolOutcome {
    let tcid = ctx.tool_call_id.clone();
    let mut fut = Box::pin(tool.invoke(args, ctx));
    tokio::select! {
        biased;
        outcome = &mut fut => outcome,                 // fast: unchanged behavior
        _ = tokio::time::sleep(deadline) => {
            ToolOutcome::Running(RunningHandle {
                tool_call_id: tcid.to_string(),
                ack: running_ack(&tcid),               // {status:"running"}
                wait_kind: AsyncWaitKind::AsyncTools,
                completion: RunningCompletion::Driven(Box::pin(async move {
                    match fut.await {
                        ToolOutcome::Completed(r) => r,
                        // a promoted tool that itself elicits/detaches is a forbidden
                        // class (Open decision 8) — degrade to an error result.
                        other => degrade_promoted_outcome(other),
                    }
                })),
                kill: Box::new(move || { /* abort drive task */ }),
            })
        }
    }
}
```

**Promotion vs the existing timeouts — one ordered ladder.** For a `promotable` tool the promotion deadline *replaces* the per-tool `timeout` (`tool_execution.rs:532`): promotion fires first and lets the work continue to the sink, so there is no competing "synthesize Err on timeout." For a non-promotable tool the per-tool/per-batch timeout is unchanged (still synthesizes an `Err` `ToolResult` so pairing survives, `tool_execution.rs:548-577`). This resolves the timeout/promotion collision (open question 3).

**Preserved invariants** (all four, unchanged): (a) exactly one paired `tool_result` per `tool_call`, appended in `tool_calls` order via the sequential apply after concurrent execute (`tool_execution.rs:638`); (b) `Running` = synthetic-ack-now + real-later via `pending_injected_messages`; (c) a parallel batch is contiguous side-effect-free calls whose futures never borrow `&mut session`; (d) `NeedsHuman` breaks the batch loop, `Running` does not.

---

## 5. The loop rewrite

### 5.1 `handle_tool_calls_path` becomes outcome-aware

The barrier (`pipeline.rs:878`) and the round-state plumbing (`pipeline.rs:898-941`) stay. What changes: `RoundExecutionState.{awaiting_clarification, waiting_for_children}` (`loop_state.rs:7-8`) are now **direct consequences of the returned `ToolOutcome`**, set inside the `match` in §4.2, not derived by marker classification. The finalize match on `runtime.suspend_reason` (`pipeline.rs:1448`) is untouched — it still keys on the same strings.

### 5.2 `Running` completion re-entry

Reuse the existing machinery wholesale:

| Mechanism | file:line | v2 role |
|---|---|---|
| `pending_injected_messages` (persisted) | set by the completion coordinator | unchanged destination for a finished `Running` result |
| `merge_pending_injected_messages` at round top | `pipeline.rs:1118` | unchanged — drains injected results as user messages |
| terminal-gate suspend for outstanding work | `maybe_suspend_for_outstanding_bash`, `pipeline.rs:263` | **generalized** to `maybe_suspend_for_outstanding_async_tools`; discriminant `"waiting_for_bash"` (`pipeline.rs:224`,`:1539`) renamed `"waiting_for_async_tools"`, covering Bash **and** promoted tools |
| child completion (SubAgent) | `waiting_for_children` finalize (`pipeline.rs:1475`) + persisted-state merge (`pipeline.rs:1491`) | **unchanged**, distinct discriminant — `SubAgent` `Running` uses `AsyncWaitKind::Children` |

Both async families are now the same `ToolOutcome::Running` shape, differing only by `wait_kind`. This is the symmetric truth the marker channel obscured: Bash `Running` ↔ `waiting_for_async_tools` backstop; SubAgent `Running` ↔ `waiting_for_children` backstop.

### 5.3 `NeedsHuman` suspend/resume

Unchanged runtime: `set_pending_question_with_source` + `suspend_reason` (`result_handler.rs:328`) → finalize match flips status to `Suspended` with `SuspensionState { reason, resumable:true, hook_point:"AfterToolExecution" }` (`pipeline.rs:1453` clarification, `:1462` parent-approval; `SuspensionState` at `crates/core/bamboo-domain/src/session/runtime_state.rs:223`). Resume via `submit_pending_response` sets the re-execute marker and resumes. The **only** change is provenance: the `PendingQuestion` is carried in the outcome instead of parsed out of result JSON by `parse_user_question_payload` (`payload.rs:41`).

### 5.4 Delete the post-hoc inference (four surfaces, not one)

Correction from verification: this is **not** a single funnel. The engine's success path does funnel through `handle_tool_result_with_agentic_support` (`success_path.rs:96`) + its `ToolHandlingOutcome` match (`success_path.rs:106-119`), but that function has **one** production caller (the engine); the "core `result_handler` loop" is `execute_sub_actions` (`result_handler.rs:332`), a **nested** sub-loop reachable only from within the function (`result_handler.rs:284`) that carries its **own duplicated** agentic-result match (`result_handler.rs:409-458`); and the engine tool-**error** path (`error_path` via `per_call.rs:257`) never routes through the function. A clean-slate v2 therefore rewrites **four** surfaces: (a) `handle_tool_result_with_agentic_support`, (b) `ToolHandlingOutcome` + its match (`success_path.rs:106-119`), (c) the duplicated inline match inside `execute_sub_actions` (`result_handler.rs:409-458`), (d) the error path (`per_call.rs:257`). Practically: collapse (a)+(c) into the shared `apply(outcome)` reducer, and route (d) through the same `Completed(Err)` path.

Deleted across those surfaces: `ToolHandlingOutcome` (`result_handler.rs:15`), `is_waiting_for_children_control` (`result_handler.rs:21`), the `should_handle_user_question_tool` sniff (`payload.rs:27`), `parse_user_question_payload` (`payload.rs:41`), and the `runtime_control` / `display_preference="runtime_control:…"` marker fields.

**Agentic path caveat.** `handle_tool_result_with_agentic_support` also expands the agentic `ToolResult` enum (`crates/core/bamboo-agent-core/src/tools/agentic.rs:493`: `Success`/`Error`/`NeedClarification`/`NeedMoreActions`, capped at `MAX_SUB_ACTIONS=64`, `result_handler.rs:34`). v2 mapping: `NeedClarification → ToolOutcome::NeedsHuman`; `NeedMoreActions` stays a loop-level sub-action expansion driven off a `Completed` result. This is the largest single rewrite surface (see §9).

---

## 6. Full tool inventory → v2 mapping

Every production tool surface (~35). "Outcome" is the variant(s) a call returns in v2.

| Tool | file:line | v2 outcome | Migration note |
|---|---|---|---|
| **Bash** | `bamboo-tools/…/bash.rs:468` | `Completed` \| `Running` | Canonical promotion case. Fast fg → `Completed`; forced/auto-bg → `Running{wait_kind:AsyncTools, completion:Detached}` (already self-wires the sink, `bash.rs:406`). Reference implementation. |
| BashInput | `bash_input.rs:40` | `Completed` | Writes stdin to a live shell. |
| BashOutput | `bash_output.rs:33` | `Completed` | `classify → READONLY_PARALLEL`. |
| KillShell | `kill_shell.rs:46` | `Completed` | Terminates a bg shell. |
| Read | `read.rs:142` | `Completed` | `READONLY_PARALLEL`; ctx supplies workspace root. |
| Edit | `edit.rs:504` | `Completed` | Mutating; **never `promotable`** (local non-idempotent write). |
| Write | `write.rs:31` | `Completed` | Mutating; not `promotable`. |
| Grep | `grep.rs:295` | `Completed` | `READONLY_PARALLEL` — the parallel-batch exemplar. |
| Glob | `glob.rs:66` | `Completed` | `READONLY_PARALLEL`. |
| GetFileInfo | `get_file_info.rs:22` | `Completed` | `READONLY_PARALLEL`. |
| NotebookEdit | `notebook_edit.rs:83` | `Completed` | Mutating. |
| WebFetch | `web_fetch.rs:112` | `Completed` (`promotable`) | Network I/O; promote slow fetches. |
| WebSearch | `web_search.rs:122` | `Completed` (`promotable`) | Network I/O. |
| js_repl | `js_repl.rs:95` | `Completed` (`promotable`) | Spawns node subprocess; promote long scripts. |
| session_note | `memory_note.rs:53` | `Completed` | **Arg-dependent** `classify`: read/list_topics → RO, else Mut. |
| update_goal | `goal.rs:59` | `Completed` | Self-report; `classify → ReadOnly` (mod.rs:151). |
| Workspace | `workspace.rs:29` | `Completed` | **Arg-dependent**: get → RO, set → Mut. |
| Sleep | `sleep.rs:32` | `Completed` (`promotable`) | Natural promotion candidate (pure delay). |
| Task | `task.rs:389` | `Completed` | Writes the shared task list; **not** a child spawner. |
| SlashCommand | `slash_command_tool.rs:28` | `Completed` | Expands a command into the conversation. |
| **conclusion_with_options** | `conclusion_with_options.rs:90` | `NeedsHuman` | Returns `PendingQuestion` directly (was `{status:awaiting_user_input}` + `should_handle_user_question_tool`, `payload.rs:4`). |
| **EnterPlanMode** | `enter_plan_mode.rs:27` | `NeedsHuman` | Confirm entering plan mode. |
| **ExitPlanMode** | `exit_plan_mode.rs:28` | `NeedsHuman` | Present plan + suggested exit mode; in `PAUSE_TOOLS` (`payload.rs:4`). |
| **request_permissions** | `request_permissions.rs:49` | `NeedsHuman` | Grant-on-approve; the permission-gate synth path (`payload.rs:38`) also emits `NeedsHuman` for *any* gated mutating tool. |
| **SubAgent** | `bamboo-server-tools/…/sub_agent.rs:435` | `Running` (both actions) | `create` → `Running{Children, Detached}` (child handle); `wait` → `Running{Children, Detached}` whose backstop is `waiting_for_children`. Keep discriminant distinct from clarification (finalize-merge, `pipeline.rs:1491`). |
| ask_agent | `ask_agent.rs:51` | `Completed` (`promotable`) | Blocking round-trip to a remote worker — strong promotion candidate. |
| deploy_agent | `deploy_agent.rs:232` | `Completed` (`promotable`) | Long SSH/Docker provisioning. |
| cluster | `cluster_tool.rs:207` | `Completed` | **`classify → ReadOnly`** — fix the semantic/declared mismatch (was defaulted Mutating). |
| compact_context | `compact.rs:20` | `Completed` (`promotable`) | Summarization is itself an LLM call. Already RO-classified (mod.rs:146). |
| memory | `memory/mod.rs:69` | `Completed` | **Arg-dependent**: search/inspect → RO, else Mut (mod.rs:144). |
| session_history | `session_inspector/mod.rs:52` | `Completed` | **`classify → ReadOnly`** — fix mismatch (semantically RO). |
| load_skill | `skill_runtime/load_skill.rs:39` | `Completed` | Injects skill content. |
| read_skill_resource | `skill_runtime/read_resource.rs:48` | `Completed` | **`classify → ReadOnly`** — fix mismatch. |
| scheduler | `schedule_app/scheduler_tool.rs:155` | `Completed` | Cron management. |
| **MCP proxy** (all servers, incl. `mcp__nova__*`) | `bamboo-mcp/…/executor.rs:73`; broker `bamboo-broker/…/mcp.rs:606` | `Completed` \| `NeedsHuman` (`promotable`) | **Not `impl Tool`** — one dispatch seam, not N tools. `Completed` normally; `NeedsHuman` when a call elicits (kills the result-guard hack). Promote slow/remote calls (nova screenshot/click). `classify` = opaque → treat as `MUTATING_SERIAL` unless a server advertises otherwise. |

Tricky ones called out: **Bash** (mixed Completed/Running, the promotion exemplar) · **SubAgent** (create + wait both `Running`, distinct `Children` discriminant) · **MCP proxy** (seam-level, opaque mutability, per-call `NeedsHuman`) · **ask_agent/deploy_agent/compact** (blocking futures → free promotion) · **the four interactive tools** (marker → direct `NeedsHuman`) · **arg-dependent trio** (`session_note`/`Workspace`/`memory`) · **the three misclassified read-onlys** (`cluster`/`session_history`/`read_skill_resource`) migration widens parallelism.

---

## 7. v1 teardown

| Deleted | file:line / symbol | Becomes in v2 |
|---|---|---|
| `Tool` trait | `registry.rs:101` | `ToolV2` (§3.2) |
| `execute` | `registry.rs:127` | folded into `invoke` |
| `execute_with_context` (default delegates) | `registry.rs:133` | folded into `invoke` — every tool is ctx-aware; the split is gone |
| `mutability` + `call_mutability` | `registry.rs:109`,`:113` | `ToolClass.mutability` via `classify(args)` |
| `concurrency_safe` + `call_concurrency_safe` | `registry.rs:119`,`:123` | `ToolClass.parallel_safe` via `classify(args)` |
| `ToolExecutor::execute` / `execute_with_context` | `executor.rs:76`,`:82` | one `invoke`-based dispatch; `execute_tool_call_with_context` (`executor.rs:201`) collapses |
| `call_parallel_classification` | `executor.rs:144` | subsumed by one `classify(args)` call |
| `ToolHandlingOutcome` | `result_handler.rs:15` | direct `ToolOutcome` variants |
| `is_waiting_for_children_control` | `result_handler.rs:21` | `Running{wait_kind:Children}` |
| `should_handle_user_question_tool` + `parse_user_question_payload` + `PAUSE_TOOLS` | `payload.rs:27`,`:41`,`:4` | `NeedsHuman(PendingQuestion)` returned directly |
| `runtime_control` / `display_preference="runtime_control:…"` markers | `result_handler.rs:22-31` | deleted (no marker channel) |
| `handle_tool_result_with_agentic_support` | `result_handler.rs` (called `success_path.rs:96`) | rewritten as the shared `apply(outcome)` reducer |
| `pre_parsed_args` threading | `context.rs:99` | owned `args` param on `invoke` |
| `bash_completion_sink` (bash-specific) | `context.rs:89`; `BashCompletionSink` `bash_completion.rs:51` | `async_completion_sink`; `AsyncToolCompletionSink` |
| **Kept** — `classify_tool` / `ToolMutability` / `READ_ONLY_TOOLS` | `mod.rs:126`,`:155`,`:132` | **retained as the MCP/opaque fallback only** (proxied tools have no `ToolV2::classify`) |
| **Kept verbatim** — the barrier | `pipeline.rs:878` | outcome-agnostic; unchanged |

---

## 8. Migration plan (one epic, tree-green sequence)

The epic ships as one merge, but the internal order keeps the tree compiling and testable at each step.

1. **Land v2 types alongside v1.** Add `ToolOutcome`, `ToolV2`, `ToolClass`, `ToolCtx`, `RunningHandle`, `AsyncToolCompletionSink`. Nothing deleted → compiles.
2. **v1→v2 adapter shim.** A blanket `impl ToolV2 for Arc<dyn Tool>` that calls `execute_with_context`, wraps `Ok → Completed`, and *lifts the existing markers*: `should_handle_user_question_tool`-shaped results → `NeedsHuman`; `{status:"running"}`/`runtime_control` → `Running`. This lets the v2 executor drive **all** tools before any is ported.
3. **Stand up the v2 executor behind a flag / parallel path.** Wire the §4.2 match; run it against the adapter. Golden-parity harness: capture v1 `(args → ToolResult)` fixtures per tool; assert v2 `Completed(result)` is **byte-identical** (`ToolResult` is `Serialize`, `tool_types.rs:16`).
4. **Port tools in batches** (each: native `ToolV2` impl, drop adapter reliance, run golden-parity):
   1. read-only leaves — Read, Grep, Glob, GetFileInfo, BashOutput (also fix `cluster`/`session_history`/`read_skill_resource` to `ReadOnly`);
   2. mutating leaves — Edit, Write, NotebookEdit, Task, SlashCommand, update_goal, scheduler, load_skill;
   3. arg-dependent — session_note, Workspace, memory;
   4. live-shell — Bash, BashInput, KillShell (`Running{Detached}` parity: assert ack shape + sink fires with the same completion);
   5. interactive — conclusion_with_options, EnterPlanMode, ExitPlanMode, request_permissions (parity: `PendingQuestion` fields == today's parsed payload);
   6. app/remote — SubAgent, ask_agent, deploy_agent, compact_context, cluster, session_history, load_skill, read_skill_resource;
   7. MCP dispatch seam — `McpToolExecutor` / `McpProxyExecutor` → per-call `Completed`/`NeedsHuman`;
   8. agentic path — the `NeedMoreActions`/`NeedClarification` expansion.
5. **Switch the loop.** Make `ToolOutcome` authoritative; delete the marker channel and rewrite both consumers (`success_path` + `result_handler`) against the shared `apply(outcome)` reducer; rename `waiting_for_bash → waiting_for_async_tools` in the terminal gate + finalize match in lockstep.
6. **Delete v1.** Remove the `Tool` trait, the `execute`/`execute_with_context` splits, `ToolHandlingOutcome`, the markers, and the adapter. Keep `classify_tool` for the MCP fallback.

Per-batch test strategy: **per-tool golden parity** — same args → same `ToolResult` bytes for `Completed` tools; ack-shape + sink-fired parity for `Running`; `PendingQuestion`-field parity for `NeedsHuman`. Cancel test (`tool_execution_cancel_returns_promptly`, `pipeline.rs:3498`) and the injected-merge test (`pending_injected_messages_are_merged_once_and_cleared`, `pipeline.rs:2633`) run every batch.

---

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Large regression surface** — every tool + the executor + both loops change at once. | Adapter shim (step 2) lets the v2 executor run before any port; golden-parity gates every batch; v1 stays until step 6. |
| **Agentic path** is the deepest rewrite (`NeedMoreActions` sub-action expansion, `MAX_SUB_ACTIONS`, `result_handler.rs:34`). | Port it last (batch 4.8) behind its own parity fixtures; keep sub-action expansion a loop concern off a `Completed` result. |
| **Ordering / cancel** — one paired result per call in order; cancel drops in-flight. | Sequential apply (`tool_execution.rs:638`) and the biased barrier (`pipeline.rs:878`) are kept verbatim; `Running` ack is applied *in order* before the drive task spawns. |
| **MCP semantics change** — per-call `NeedsHuman` is new behavior for proxied elicitation. | Default proxied calls to `Completed`; only lift to `NeedsHuman` on an explicit elicitation signal; treat opaque mutability as `MUTATING_SERIAL` (matches today's conservatism). |
| **Prompt-cache** — a changed tool `description`/`schema` busts the 1h cache prefix (see memory: prompt-cache prefix invariants). | `name`/`description`/`parameters_schema`/`to_schema` bodies are copied byte-identical (§3.2, §7); golden-parity includes `to_schema()` output. |
| **Plan-mode / permission gating** — the synth `request_permissions` path (`payload.rs:38`) currently reaches *any* gated mutating tool via a marker. | The permission gate returns `NeedsHuman` *before* `invoke` (§4.2), preserving grant-on-approve without the marker. |
| **Promotion `'static` constraint** — a promoted `Completed` future must outlive the borrowed ctx. | Owned `ToolCtx` (§3.4) makes every `invoke` future `'static`; only `promotable` tools are promoted, and they are the network/idempotent set. |
| **Double-delivery** — the sink push races the durable poll backstop. | `AsyncToolCompletionSink` keeps the idempotency contract of `BashCompletionSink` (`bash_completion.rs:47`) — push is a latency optimization over the poll, guarded on the persisted wait. |

---

## 10. Open decisions (with recommended defaults)

1. **`invoke(&self)` vs `invoke(self)`.** → **`&self`.** Tools are `Arc`-shared (`registry.rs:157`); by-value `self` is impossible and every existing tool is `&self`.
2. **`ToolCtx` owned vs `Copy`-of-borrows.** → **owned (Arc-based).** Enables uniform promotion and `'static` detached futures; preserves the no-`&mut session` invariant.
3. **Which tools are `promotable`.** → **opt-in allowlist**, default false: WebFetch, WebSearch, js_repl, Sleep, ask_agent, deploy_agent, compact_context, MCP proxy. **Never** Edit/Write/NotebookEdit (local non-idempotent). Bash self-promotes already.
4. **Promotion deadline vs per-tool timeout.** → **one ladder**: promotion deadline *replaces* the timeout for `promotable` tools; non-promotable keep timeout-as-`Err`.
5. **`NeedsHuman` un-run tail.** A mid-round `NeedsHuman` breaks `'tool_calls`, leaving later calls in the same assistant message unpaired → Anthropic missing-`tool_result` hard-error risk on resume. → **synthesize placeholder `Err` results** ("not executed — turn suspended for user input") for the tail *before* suspending (mirrors the cancelled-batch Err synthesis, `tool_execution.rs:548`), so the transcript is always well-paired; the model re-issues on resume.
6. **New suspend discriminant.** → **rename** `waiting_for_bash → waiting_for_async_tools` (covers Bash + promoted); **keep** `waiting_for_children` distinct (its merge path, `pipeline.rs:1491`). No overloading of an existing reason.
7. **`classify_tool` fate.** → **keep** (`mod.rs:155`) strictly as the MCP/opaque fallback; delete it from the native path.
8. **Can a `parallel_safe` tool return `Running`?** → **yes.** A promoted WebFetch mid-batch stays correct: its ack is applied in `tool_calls` order and the drive task spawns after. A promoted tool that itself elicits/re-detaches is forbidden (degraded to an error in the drive future, §4.3).

---

## Feasibility claims

- Every `tool_call` requires a paired `tool_result` in the same turn (Anthropic hard-errors on a missing id), and Bash already emits exactly the synthetic `{status:"running"}` ack that `ToolOutcome::Running` needs (`crates/engine/bamboo-tools/src/tools/bash.rs:421`).
- The `Running` runtime's round-boundary **transport** reuses verbatim — `BashCompletionSink` (`crates/core/bamboo-agent-core/src/tools/bash_completion.rs:51`) → `pending_injected_messages` → `merge_pending_injected_messages` (`crates/engine/bamboo-engine/src/runtime/runner/loop_execution/pipeline.rs:1118`). Generalizing to `AsyncToolCompletionSink` is *not* "merely widen the payload": the delivered artifact must stay an appended user message (a second real `ToolResult` for the already-acked id would break same-turn pairing), the consumer `merge_pending_injected_messages` (today `{content}`→`Message::user`) needs a format change, and the idle/terminal-case delivery **guarantee** needs a generic `waiting_for_async_tools` durable suspend/poll (the current guarantee is bash-specific, §5.2).
- The `NeedsHuman` runtime already exists — `PendingQuestion` (`crates/core/bamboo-domain/src/session/types.rs:305`) + the finalize match that flips to `Suspended` (`pipeline.rs:1453`) + `submit_pending_response`. The migration is "lower the outcome into `set_pending_question` + the `suspend_reason` marker + the synthetic paired ack + **preserve the child→parent-approval branch** (`try_delegate_child_approval`, sets `awaiting_parent_approval`)" — not merely "return the outcome instead of sniffing" (`payload.rs:27`).
- The cancel barrier is outcome-agnostic and can stay verbatim: it is a biased `tokio::select!` wrapping `execute_round_tool_calls` as an opaque future (`pipeline.rs:878`), so only the wrapped future's return type changes.
- The two *args-aware* v1 hooks (`call_mutability`/`call_concurrency_safe`, `registry.rs:113`/`:123`) collapse into one args-aware `classify(args) -> ToolClass`; v2 must **also** keep a name-only fallback (`classify_by_name` / retained `classify_tool`, `mod.rs:155`) because the two *static* hooks (`mutability`/`concurrency_safe`, `registry.rs:109`/`:119`) and the MCP/unregistered path classify by name with no args.
- Tool execution never borrows `&mut session` (only the apply phase mutates), so concurrent `join_all` + owned `ToolCtx` + detached promotion are all sound (`tool_execution.rs:369` scheduler; sequential apply at `tool_execution.rs:638`).
- The engine success path funnels through `handle_tool_result_with_agentic_support` (`success_path.rs:96`), but v2 must rewrite **four** surfaces, not one: that function + its `ToolHandlingOutcome` match (`result_handler.rs:15`, `success_path.rs:106-119`), the **duplicated** agentic match inside the nested `execute_sub_actions` (`result_handler.rs:409-458`), and the engine error path (`per_call.rs:257`). (§5.4)
- MCP tools have no `impl Tool` — they are proxied at one dispatch seam (`McpToolExecutor`, `crates/infra/bamboo-mcp/src/executor.rs:73`; `McpProxyExecutor`, `crates/app/bamboo-broker/src/mcp.rs:606`) — so v2 touches one seam, not N tools, and `classify_tool` (`crates/core/bamboo-agent-core/src/tools/mod.rs:155`) remains the opaque fallback.