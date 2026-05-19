# Task Summary Model Analysis

## Executive Summary

Current model preference selection already has a fairly complete **backend capability model**, but the **frontend Settings UI only exposes part of it**.

### What exists today

- Frontend `ProviderSettings` only exposes 4 centralized model preference types:
  - `chat`
  - `fast`
  - `sub_agent`
  - `vision`
- Frontend type definitions already support more defaults:
  - `memory_background`
  - `planning`
  - `search`
  - `code_review`
  - `subagent_models`
- Backend `DefaultsConfig` also already supports those richer capability slots.
- Runtime already has a dedicated engine slot named `summarization_model_name`, but it is **not currently wired from config/settings**.

### Key conclusion

If you want to add a new centralized model preference type for **task summary**, the cleanest and most future-proof solution is:

> Add a new capability field `defaults.task_summary: ProviderModelRef`
> and wire it to the runtime's `summarization_model_name`.

This is better than reusing `fast` or overloading `memory.background_model`, because it keeps the model-selection UX consistent with the existing centralized preference card.

---

## Current Architecture

## 1. Frontend: where model preferences are defined and rendered

### 1.1 Type definitions already support more than the UI shows

Frontend default model preference types live in:

- `lotus/src/pages/ChatPage/types/providerConfig.ts:9`

Current `DefaultsConfig` already contains:

- `chat`
- `fast`
- `vision`
- `memory_background`
- `planning`
- `search`
- `code_review`
- `sub_agent`
- `subagent_models`

So from the **type level**, the frontend is already prepared for more centralized model categories than the current UI exposes.

### 1.2 Settings UI only renders 4 centralized preference sections

The current centralized model preference card is rendered in:

- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:933`

The UI currently only renders pickers for:

- `chat`
- `fast`
- `sub_agent`
- `vision`

See:

- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:935`
- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:950`
- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:1000`

This means the **frontend model-preference system is partially exposed**: the types are richer than the visible UI.

### 1.3 Save path already persists `defaults`

When saving provider settings, the frontend already includes the full `defaults` object in payloads.

Legacy provider settings save path:

- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:671`
- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:674`
- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:689`

Instance mode save path:

- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:658`
- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:661`
- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:668`

So once a new field is added to frontend types and UI, the save pipeline already has the right shape.

### 1.4 Auto-save helper is currently hard-coded to only 4 fields

The auto-save model preference handler is still hard-coded to:

- `chat`
- `fast`
- `sub_agent`
- `vision`

See:

- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:802`
- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:803`
- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:935`
- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:951`

This will need to be extended for `task_summary`.

---

## 2. Backend: config structure and settings APIs

## 2.1 Backend `Config.defaults` already supports many capability-specific model refs

Backend config lives in:

- `bamboo/crates/bamboo-infrastructure/src/config/config.rs:184`

Backend `DefaultsConfig` is defined at:

- `bamboo/crates/bamboo-infrastructure/src/config/config.rs:355`

It already supports:

- `chat`
- `fast`
- `vision`
- `memory_background`
- `planning`
- `search`
- `code_review`
- `sub_agent`
- `subagent_models`

This is important because it shows the architecture is already moving toward a **capability-keyed model preference system**, not just a few ad hoc fields.

## 2.2 Provider Settings GET/POST already round-trip `defaults`

Backend provider settings GET returns `defaults`:

- `bamboo/crates/bamboo-server/src/handlers/settings/provider/endpoints/get.rs:18`
- `bamboo/crates/bamboo-server/src/handlers/settings/provider/endpoints/get.rs:25`

Backend provider settings POST persists `defaults` into config patch:

- `bamboo/crates/bamboo-server/src/handlers/settings/provider/endpoints/update.rs:57`
- `bamboo/crates/bamboo-server/src/handlers/settings/provider/endpoints/update.rs:64`
- `bamboo/crates/bamboo-server/src/handlers/settings/provider/endpoints/update.rs:67`

So adding a new optional field like `defaults.task_summary` fits the existing API design.

## 2.3 Provider instances API also returns `defaults`

In multi-instance mode, `defaults` is also returned from:

- `bamboo/crates/bamboo-server/src/handlers/settings/provider_instances/mod.rs:25`
- `bamboo/crates/bamboo-server/src/handlers/settings/provider_instances/mod.rs:30`
- `bamboo/crates/bamboo-server/src/handlers/settings/provider_instances/mod.rs:311`
- `bamboo/crates/bamboo-server/src/handlers/settings/provider_instances/mod.rs:314`

So the same new field can work in both legacy and instance mode.

---

## 3. Main session model resolution today

Main session execution model resolution happens in:

- `bamboo/crates/bamboo-server/src/session_app/execute.rs:22`

The important cascade is:

- provider-model-ref mode: `session.model_ref -> request.model_ref -> config.default_model_ref`
- legacy mode: `session.model -> config.default_model -> request.model`

See:

- `bamboo/crates/bamboo-server/src/session_app/execute.rs:44`
- `bamboo/crates/bamboo-server/src/session_app/execute.rs:47`
- `bamboo/crates/bamboo-server/src/session_app/execute.rs:171`

This confirms that `defaults.chat` is the main session default model preference.

---

## 4. What current specialized model types actually do

Below is the current static mapping of capability types to actual usage.

### 4.1 `chat`

Used as the main session default model.

Evidence:

- `bamboo/crates/bamboo-server/src/session_app/execute.rs:44`
- `bamboo/crates/bamboo-server/src/session_app/execute.rs:171`

### 4.2 `fast`

Used today for lightweight / cheap tasks.

#### Title generation

- `bamboo/crates/bamboo-server/src/title_gen/mod.rs:236`
- `bamboo/crates/bamboo-server/src/title_gen/mod.rs:249`

This path explicitly uses `resolve_fast_model(...)`.

#### Async task evaluation

Task evaluation uses `fast_model_name` and falls back to `model_name`:

- `bamboo/crates/bamboo-engine/src/runtime/runner/loop_execution/pipeline.rs:280`
- `bamboo/crates/bamboo-engine/src/runtime/runner/loop_execution/pipeline.rs:281`
- `bamboo/crates/bamboo-engine/src/runtime/runner/loop_execution/pipeline.rs:283`

Task evaluation provider call is tagged as `request_purpose = "task_evaluation"`:

- `bamboo/crates/bamboo-engine/src/runtime/task_evaluation/executor.rs:105`
- `bamboo/crates/bamboo-engine/src/runtime/task_evaluation/executor.rs:110`

So **task evaluation is not a summary flow**; it is a separate task-analysis/update flow.

### 4.3 `vision`

Dedicated image-understanding model.

Resolver:

- `bamboo/crates/bamboo-server/src/model_config_helper.rs:280`

### 4.4 `sub_agent`

Dedicated default model for child/sub-agent runs.

Resolver chain:

- `bamboo/crates/bamboo-server/src/model_config_helper.rs:380`
- `bamboo/crates/bamboo-server/src/model_config_helper.rs:412`

It also supports per-subagent-type override via `subagent_models`.

### 4.5 `memory_background`

Current background / memory summarization model.

Resolver:

- `bamboo/crates/bamboo-server/src/model_config_helper.rs:217`
- `bamboo/crates/bamboo-server/src/model_config_helper.rs:224`

Its current documented resolution order is:

1. `defaults.memory_background`
2. `defaults.fast`
3. legacy `memory.background_model` / provider `fast_model`

See:

- `bamboo/crates/bamboo-server/src/model_config_helper.rs:220`
- `bamboo/crates/bamboo-server/src/model_config_helper.rs:223`

### 4.6 Current task-summary-like flow: context compression / conversation summary

The most relevant existing “summary” path is the context compression / conversation summary pipeline.

The summary prompt explicitly includes:

- current task list
- active tasks
- completed tasks
- obsolete/superseded tasks
- next step

See summary prompt builder:

- `bamboo/crates/bamboo-compression/src/compression_tooling.rs:760`
- `bamboo/crates/bamboo-compression/src/compression_tooling.rs:779`
- `bamboo/crates/bamboo-compression/src/compression_tooling.rs:786`

And the actual runtime compression chooses:

- `summarization_model_name`
- else `background_model_name`

See:

- `bamboo/crates/bamboo-engine/src/runtime/runner/round_lifecycle/context_preparation.rs:251`
- `bamboo/crates/bamboo-engine/src/runtime/runner/round_lifecycle/context_preparation.rs:254`
- `bamboo/crates/bamboo-engine/src/runtime/runner/round_lifecycle/context_preparation.rs:293`

This is the **closest existing consumer** to a dedicated `task summary` model.

---

## 5. Important gap: runtime already has `summarization_model_name`, but settings do not wire it

Engine config already has a dedicated field:

- `bamboo/crates/bamboo-engine/src/runtime/config.rs:127`
- `bamboo/crates/bamboo-engine/src/runtime/config.rs:128`

```rust
pub summarization_model_name: Option<String>
```

But in runtime construction, we currently only wire:

- `model_name`
- `fast_model_name`
- `background_model_name`
- `planning_model_name`
- `search_model_name`

See:

- `bamboo/crates/bamboo-engine/src/runtime/runtime.rs:353`
- `bamboo/crates/bamboo-engine/src/runtime/runtime.rs:354`
- `bamboo/crates/bamboo-engine/src/runtime/runtime.rs:355`
- `bamboo/crates/bamboo-engine/src/runtime/runtime.rs:358`
- `bamboo/crates/bamboo-engine/src/runtime/runtime.rs:363`

But **`summarization_model_name` is not set there**.

So today the engine has a dedicated slot for summary work, but config/settings never actually feed it.

---

## 6. Important gap: current background/fast naming is overloaded

There is some historical naming debt in the current execution path.

For example, in server execute handler:

- `resolved_background_model` is passed into a field named `fast_model`

See:

- `bamboo/crates/bamboo-server/src/handlers/agent/execute/handler/mod.rs:183`
- `bamboo/crates/bamboo-server/src/handlers/agent/execute/handler/mod.rs:224`

And in `SessionExecutionArgs`, that `fast_model` becomes `ExecuteRequest.background_model`:

- `bamboo/crates/bamboo-engine/src/runtime/execution/agent_spawn.rs:139`

This means current code still mixes:

- fast model
- background model
- summary model

semantically more than the UI suggests.

That is exactly why adding a dedicated `task_summary` capability is useful.

---

## Recommended Solution

## 7. Add a new centralized capability: `defaults.task_summary`

### Proposed config shape

Frontend + backend:

```ts
// frontend
interface DefaultsConfig {
  chat: ProviderModelRef;
  fast?: ProviderModelRef;
  task_summary?: ProviderModelRef;
  vision?: ProviderModelRef;
  memory_background?: ProviderModelRef;
  planning?: ProviderModelRef;
  search?: ProviderModelRef;
  code_review?: ProviderModelRef;
  sub_agent?: ProviderModelRef;
  subagent_models?: Record<string, ProviderModelRef>;
}
```

```rust
// backend
pub struct DefaultsConfig {
    pub chat: ProviderModelRef,
    pub fast: Option<ProviderModelRef>,
    pub task_summary: Option<ProviderModelRef>,
    pub vision: Option<ProviderModelRef>,
    pub memory_background: Option<ProviderModelRef>,
    pub planning: Option<ProviderModelRef>,
    pub search: Option<ProviderModelRef>,
    pub code_review: Option<ProviderModelRef>,
    pub sub_agent: Option<ProviderModelRef>,
    pub subagent_models: HashMap<String, ProviderModelRef>,
}
```

### Why `defaults.task_summary` is the best fit

Because the user requirement is:

- centralized type-based model selection
- same UX family as `default / fast / sub-agent / vision`

So it should live in **the same centralized defaults system**, not in `memory.background_model`.

---

## 8. Recommended meaning of `task_summary`

I recommend defining `task_summary` as:

> The dedicated model for task-oriented summarization and compression work,
> especially conversation/task-list summary generation used to preserve task state.

This should cover:

- context compression summary generation
- manual `compact_context`
- future explicit task-summary generation features

It should **not** automatically cover task evaluation.

Why:

- task evaluation is classification / status update logic
- task summary is summarization / consolidation logic
- those are different workloads and should stay separately configurable if needed later

If later you also want a separate model for evaluation, add another capability such as:

- `task_evaluation`

but do not conflate it with `task_summary`.

---

## 9. Recommended fallback chain

Recommended fallback chain for the new resolver:

### Provider-model-ref mode

1. `defaults.task_summary`
2. `defaults.memory_background`
3. `defaults.fast`
4. `defaults.chat`

### Legacy / mixed fallback

If provider-model-ref lookup is unavailable or fails:

1. `memory.background_model`
2. provider `fast_model`
3. provider default `model`

This keeps the new field backward compatible while preserving current behavior as fallback.

---

## 10. Frontend changes

## 10.1 Type updates

Update:

- `lotus/src/pages/ChatPage/types/providerConfig.ts`

Add:

- `task_summary?: ProviderModelRef`

Update `EditableDefaults` in:

- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:83`

Add:

- `task_summary?: ProviderModelRef`

## 10.2 Settings UI updates

In `renderModelPreferences()`:

- extend the supported field union from
  - `chat | fast | sub_agent | vision`
- to
  - `chat | fast | task_summary | sub_agent | vision`

Relevant places:

- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:935`
- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:951`
- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:987`
- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:1016`

Add a new section, for example between `fast` and `sub_agent`:

- label: `Task Summary Model (Optional)`
- help text: `Used for task-oriented summarization and context compression. Falls back to Memory Background, then Fast Model, then Default Model when unset.`

## 10.3 Auto-save handler updates

Update:

- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:802`

so `handleDefaultsModelChange(...)` accepts `task_summary` too.

## 10.4 i18n updates

Add translation keys in:

- `lotus/src/shared/i18n/resources/en-US.ts`
- `lotus/src/shared/i18n/resources/zh-CN.ts`

Suggested keys:

- `settings.providerTab.taskSummaryModel`
- `settings.providerTab.taskSummaryModelHelp`

Suggested Chinese copy:

- `任务总结模型（可选）`
- `用于 task 相关总结、上下文压缩与工作记忆摘要。未设置时回退到后台记忆模型、快速模型，再回退到默认模型。`

## 10.5 Keep `memory.background_model` for now, but treat it as fallback

Current System Settings still exposes:

- `memory.background_model` as a plain string input

See:

- `lotus/src/pages/SettingsPage/components/SystemSettingsPage/SystemSettingsConfigTab.tsx:327`
- `lotus/src/pages/SettingsPage/components/SystemSettingsPage/SystemSettingsConfigTab.tsx:330`

This should remain temporarily for backward compatibility.

But from a product perspective, once `task_summary` exists, `memory.background_model` should be treated as:

- legacy fallback / advanced setting
- not the primary centralized choice

---

## 11. Backend changes

## 11.1 Config schema

Update backend `DefaultsConfig` in:

- `bamboo/crates/bamboo-infrastructure/src/config/config.rs:355`

Add:

- `task_summary: Option<ProviderModelRef>`

Because provider settings GET/POST already serializes `defaults`, the existing API contracts can continue unchanged.

## 11.2 Add a dedicated resolver

In:

- `bamboo/crates/bamboo-server/src/model_config_helper.rs`

add something like:

```rust
pub fn resolve_task_summary_model(
    config: &Config,
    provider_name: &str,
    provider_registry: &Arc<ProviderRegistry>,
) -> Option<ResolvedModel>
```

Suggested fallback chain:

1. `defaults.task_summary`
2. `defaults.memory_background`
3. `defaults.fast`
4. `defaults.chat`
5. legacy `memory.background_model`
6. legacy provider `fast_model`
7. legacy provider default `model`

## 11.3 Wire runtime summarization model explicitly

Today context compression uses:

- `config.summarization_model_name`
- else `config.background_model_name`

See:

- `bamboo/crates/bamboo-engine/src/runtime/runner/round_lifecycle/context_preparation.rs:251`
- `bamboo/crates/bamboo-engine/src/runtime/runner/round_lifecycle/context_preparation.rs:254`

So when building runtime config, explicitly set:

- `summarization_model_name = resolved_task_summary_model_name`

### Important: provider override must also be handled

This is the most important implementation detail.

Because the UI uses `ProviderModelPicker`, the new `task_summary` field can point to a **different provider instance** than the main model or background model.

If you only pass the model name string without its resolved provider, the runtime may call the wrong provider.

### Therefore I recommend adding a dedicated provider override field

Add to engine/runtime config path:

- `summarization_model_provider: Option<Arc<dyn LLMProvider>>`

Affected areas likely include:

- `bamboo/crates/bamboo-engine/src/runtime/config.rs`
- `bamboo/crates/bamboo-engine/src/runtime/execution/agent_spawn.rs`
- `bamboo/crates/bamboo-server/src/handlers/agent/execute/runtime/execution.rs`
- `bamboo/crates/bamboo-server/src/handlers/agent/execute/handler/mod.rs`
- `bamboo/crates/bamboo-server/src/session_app/types.rs`
- resume-related config snapshots

Then change context compression provider selection from:

- `background_model_provider`

to something like:

- `summarization_model_provider.or(background_model_provider)`

This preserves existing behavior while allowing `task_summary` to use a different provider instance safely.

## 11.4 Do not change task evaluation to use `task_summary`

Current task evaluation model selection is here:

- `bamboo/crates/bamboo-engine/src/runtime/runner/loop_execution/pipeline.rs:280`
- `bamboo/crates/bamboo-engine/src/runtime/task_evaluation/executor.rs:105`

It currently uses:

- `fast_model_name`
- else main `model_name`

Recommended: keep this unchanged.

If you later decide task evaluation also needs a dedicated model, add a separate capability such as:

- `defaults.task_evaluation`

Do not overload `task_summary`.

---

## 12. Minimal file-level change plan

## Frontend

1. `lotus/src/pages/ChatPage/types/providerConfig.ts`
   - add `task_summary?: ProviderModelRef`

2. `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx`
   - extend `EditableDefaults`
   - extend `handleDefaultsModelChange` field union
   - add `Form.Item name={["defaults", "task_summary"]}`
   - render new preference section

3. `lotus/src/shared/i18n/resources/en-US.ts`
4. `lotus/src/shared/i18n/resources/zh-CN.ts`
   - add labels/help text

## Backend

5. `bamboo/crates/bamboo-infrastructure/src/config/config.rs`
   - add `DefaultsConfig.task_summary`

6. `bamboo/crates/bamboo-server/src/model_config_helper.rs`
   - add `resolve_task_summary_model`

7. `bamboo/crates/bamboo-engine/src/runtime/config.rs`
   - add `summarization_model_provider`

8. `bamboo/crates/bamboo-engine/src/runtime/runtime.rs`
   - set `summarization_model_name`
   - set `summarization_model_provider`

9. `bamboo/crates/bamboo-engine/src/runtime/runner/round_lifecycle/context_preparation.rs`
   - use `summarization_model_provider` first

10. Server execution / resume glue
   - pass resolved `task_summary` model + provider through execution request chain

---

## 13. Compatibility and risk assessment

## Compatibility

This is backward compatible if implemented as an optional field:

- existing configs keep working
- existing `fast` behavior remains default fallback
- existing `memory.background_model` remains usable

## Main risk

### Cross-provider selection bug

If `task_summary` is stored as `ProviderModelRef`, but runtime only receives a string model name, then selecting:

- main chat model on provider A
- task summary model on provider B

can silently fail or hit the wrong upstream provider.

So **provider propagation is mandatory**, not optional.

## Secondary risk

### Naming confusion between fast/background/summary

Current code already has overloaded naming (`fast_model` field carrying resolved background model in some server paths).

Do not extend that naming debt.

Use explicit names:

- `task_summary`
- `summarization_model_name`
- `summarization_model_provider`

---

## 14. Recommendation

## Recommended final design

### User-facing capability name

- `Task Summary Model (Optional)`

### Stored config field

- `defaults.task_summary`

### Runtime wiring target

- `AgentLoopConfig.summarization_model_name`
- `AgentLoopConfig.summarization_model_provider`

### Fallback chain

- `task_summary -> memory_background -> fast -> chat`

### Scope of usage

Use for:

- context compression summary generation
- `compact_context`
- future task-summary generation

Do not use for:

- task evaluation status updates
- title generation
- sub-agent execution

---

## 15. Short recommendation in one sentence

If the product goal is “add one more centralized model type for task summary”, the cleanest implementation is:

> add `defaults.task_summary` in the same model-preferences system, and wire it to the runtime’s existing `summarization_model_name` with a dedicated provider override path.
