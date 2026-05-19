# Final Design — Scheme C + Elevated Memory Background

## Confirmed Direction

This design adopts **Scheme C** and promotes **memory background** to the same centralized model-preference layer as other capability-specific model selections.

### Final capability set in centralized Model Preferences

Recommended visible centralized capability picks:

1. `chat`
2. `fast`
3. `task_summary`
4. `memory_background`
5. `sub_agent`
6. `vision`

This means `memory_background` should no longer exist only as a string field under System Settings. It should be selectable through the same `ProviderModelPicker`-based centralized preference system.

---

## Final Config Model

## Frontend / Backend `defaults`

```ts
interface DefaultsConfig {
  chat: ProviderModelRef;
  fast?: ProviderModelRef;
  task_summary?: ProviderModelRef;
  memory_background?: ProviderModelRef;
  vision?: ProviderModelRef;
  planning?: ProviderModelRef;
  search?: ProviderModelRef;
  code_review?: ProviderModelRef;
  sub_agent?: ProviderModelRef;
  subagent_models?: Record<string, ProviderModelRef>;
}
```

```rust
pub struct DefaultsConfig {
    pub chat: ProviderModelRef,
    pub fast: Option<ProviderModelRef>,
    pub task_summary: Option<ProviderModelRef>,
    pub memory_background: Option<ProviderModelRef>,
    pub vision: Option<ProviderModelRef>,
    pub planning: Option<ProviderModelRef>,
    pub search: Option<ProviderModelRef>,
    pub code_review: Option<ProviderModelRef>,
    pub sub_agent: Option<ProviderModelRef>,
    pub subagent_models: HashMap<String, ProviderModelRef>,
}
```

---

## Final Semantic Boundaries

## `task_summary`

Use for:

- context compression summary generation
- `compact_context`
- task-oriented working-memory summaries
- future explicit task summary features

Do **not** use for:

- task evaluation/status classification
- title generation
- sub-agent execution
- generic background memory recall reranking unless explicitly desired later

## `memory_background`

Use for:

- memory summarization / reflection
- dream generation / background memory work
- memory-related reranking or background memory LLM tasks

This keeps `task_summary` and `memory_background` separate:

- `task_summary` = summary for task continuity
- `memory_background` = summary / reflection for memory system

---

## Final Fallback Strategy

## Task summary model fallback

Recommended order:

1. `defaults.task_summary`
2. `defaults.memory_background`
3. `defaults.fast`
4. `defaults.chat`
5. legacy `memory.background_model`
6. legacy provider `fast_model`
7. legacy provider `model`

## Memory background model fallback

Recommended order:

1. `defaults.memory_background`
2. `defaults.fast`
3. `defaults.chat`
4. legacy `memory.background_model`
5. legacy provider `fast_model`
6. legacy provider `model`

This preserves backward compatibility while establishing the new centralized source of truth.

---

## Frontend Changes

## 1. Extend types

File:

- `lotus/src/pages/ChatPage/types/providerConfig.ts`

Add:

- `task_summary?: ProviderModelRef`
- keep `memory_background?: ProviderModelRef` as first-class centralized default

## 2. Extend editable defaults in ProviderSettings

File:

- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx`

Update `EditableDefaults` to include:

- `task_summary`
- `memory_background`

## 3. Extend the centralized Model Preferences card

File:

- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx`

Current visible items:

- chat
- fast
- sub_agent
- vision

Change to visible items:

- chat
- fast
- task_summary
- memory_background
- sub_agent
- vision

Recommended order:

1. Default Model
2. Fast Model
3. Task Summary Model
4. Memory Background Model
5. Sub Agent Model
6. Vision Model

## 4. Extend auto-save handler

Current auto-save field union is limited.

Extend `handleDefaultsModelChange(...)` and related unions to support:

- `task_summary`
- `memory_background`

## 5. Add i18n keys

Files:

- `lotus/src/shared/i18n/resources/en-US.ts`
- `lotus/src/shared/i18n/resources/zh-CN.ts`

Suggested keys:

- `settings.providerTab.taskSummaryModel`
- `settings.providerTab.taskSummaryModelHelp`
- `settings.providerTab.memoryBackgroundModel`
- `settings.providerTab.memoryBackgroundModelHelp`

Suggested Chinese copy:

- `任务总结模型（可选）`
- `用于任务导向的总结、上下文压缩与工作记忆摘要。未设置时依次回退到后台记忆模型、快速模型、默认模型。`
- `后台记忆模型（可选）`
- `用于 Memory / Dream / 反思等后台记忆任务。未设置时依次回退到快速模型、默认模型。`

## 6. UI migration guidance

Current System Settings contains a string input for `memory.background_model`.

File:

- `lotus/src/pages/SettingsPage/components/SystemSettingsPage/SystemSettingsConfigTab.tsx`

Recommended final treatment:

- remove it from primary UX after centralized picker is ready, or
- keep it temporarily as legacy advanced fallback input with clear deprecation copy

Preferred direction: remove from primary UX and let centralized ProviderSettings become the source of truth.

---

## Backend Changes

## 1. Extend backend `DefaultsConfig`

File:

- `bamboo/crates/bamboo-infrastructure/src/config/config.rs`

Add:

- `task_summary: Option<ProviderModelRef>`

Keep:

- `memory_background: Option<ProviderModelRef>`

This keeps both as first-class centralized capabilities.

## 2. Add dedicated resolvers

File:

- `bamboo/crates/bamboo-server/src/model_config_helper.rs`

Recommended new/updated functions:

### `resolve_task_summary_model(...)`

Resolves with fallback:

- `defaults.task_summary`
- `defaults.memory_background`
- `defaults.fast`
- `defaults.chat`
- legacy `memory.background_model`
- legacy provider `fast_model`
- legacy provider `model`

### `resolve_memory_background_model(...)`

Refine current background resolver semantics so it prefers centralized:

- `defaults.memory_background`
- `defaults.fast`
- `defaults.chat`
- legacy `memory.background_model`
- legacy provider `fast_model`
- legacy provider `model`

This is cleaner than letting legacy memory config remain the primary path.

## 3. Runtime wiring

The engine already has:

- `summarization_model_name`
- `background_model_name`

Files involved:

- `bamboo/crates/bamboo-engine/src/runtime/config.rs`
- `bamboo/crates/bamboo-engine/src/runtime/runtime.rs`
- `bamboo/crates/bamboo-engine/src/runtime/runner/round_lifecycle/context_preparation.rs`

### Required wiring

- `task_summary` -> `summarization_model_name`
- `memory_background` -> `background_model_name`

This cleanly separates:

- summary-specific work
- memory/background-specific work

## 4. Provider propagation is mandatory

Because these settings use `ProviderModelRef`, model string alone is insufficient.

If user selects:

- main chat on provider A
- task summary on provider B
- memory background on provider C

runtime must preserve both:

- model name
- provider instance/provider route

So recommended runtime additions:

- `summarization_model_provider: Option<Arc<dyn LLMProvider>>`
- keep `background_model_provider: Option<Arc<dyn LLMProvider>>`

Then use:

- summary tasks -> `summarization_model_provider`
- memory background tasks -> `background_model_provider`

This avoids cross-provider misrouting bugs.

## 5. Keep legacy compatibility during migration

Legacy `memory.background_model` can remain readable for some time, but should no longer be the primary authored setting.

Recommended policy:

- centralized `defaults.memory_background` wins
- legacy `memory.background_model` only acts as fallback

---

## Runtime Responsibility Split

## Task-summary path

Use:

- `summarization_model_name`
- `summarization_model_provider`

Consumers:

- context compression
- manual compaction
- future task-summary generation

## Memory-background path

Use:

- `background_model_name`
- `background_model_provider`

Consumers:

- dream generation
- memory reflection
- memory rerank / memory background jobs

## Fast path

Keep `fast` for:

- title generation
- lightweight classification/evaluation
- other cheap foreground helper tasks

Do not overload it as the source of truth for both summary and memory once the new centralized fields exist.

---

## Recommended Migration Policy

## Phase 1

- add `defaults.task_summary`
- promote `defaults.memory_background` in frontend UI
- keep legacy `memory.background_model` hidden or secondary
- wire runtime fallback chains

## Phase 2

- migrate internal summary usage fully to `task_summary`
- migrate memory jobs fully to centralized `memory_background`
- de-emphasize/remove old string input from System Settings

## Phase 3

- optionally expose more centralized capability picks later:
  - `planning`
  - `search`
  - `code_review`

This keeps the model-preference architecture fully consistent.

---

## Final Recommendation

Adopt this as the final design:

- **Scheme C** for `task_summary`
- **Promote `memory_background` to the same centralized preference level**
- make `defaults` the primary source of truth
- keep legacy `memory.background_model` only as compatibility fallback
- pass provider overrides explicitly for both summary and memory-background paths

In short:

> `task_summary` and `memory_background` should both be first-class centralized capability models in ProviderSettings, with separate runtime responsibilities and explicit provider propagation.
