# Provider 多实例（同类型可多个、可创建/删除）重设计报告

## 1. 需求结论

你现在要的不是“多 provider 路由”这么简单，而是更具体的 **Provider Instance Management**：

- 不再是 `OpenAI / Anthropic / Gemini / Copilot / Bodhi` 每种类型只能配置一个。
- 用户应该可以：
  - 创建多个 provider instance
  - 多个 instance 可以属于同一种 `provider type`
  - 删除任意 instance
  - 选择一个默认 instance 用于 chat / fast / vision / sub-agent 等默认能力
- UI 不应该再是“固定五个 provider 折叠面板 + 一个 active provider 下拉框”，而应该变成“provider 实例列表 + 创建/编辑/删除 + 默认路由配置”。

这实际上是从 **provider type 级配置** 迁移到 **provider instance 级配置**。

---

## 2. 当前代码现状

### 2.1 根配置仍然是“单 active provider”语义

`Config` 根上目前仍然保留一个全局 `provider: String` 字段：

- `bamboo/crates/bamboo-infrastructure/src/config/config.rs:206`
- `bamboo/crates/bamboo-infrastructure/src/config/config.rs:208`

同时 `providers` 也是固定字段结构，不是列表：

- `bamboo/crates/bamboo-infrastructure/src/config/config.rs:214`
- `bamboo/crates/bamboo-infrastructure/src/config/config.rs:216`
- `bamboo/crates/bamboo-infrastructure/src/config/config.rs:299`
- `bamboo/crates/bamboo-infrastructure/src/config/config.rs:323`

这意味着当前配置模型本质上是：

```json
{
  "provider": "openai",
  "providers": {
    "openai": { ... },
    "anthropic": { ... },
    "gemini": { ... }
  }
}
```

而不是：

```json
{
  "provider_instances": [ ... ],
  "default_provider_instance_id": "..."
}
```

### 2.2 `ProviderConfigs` 是固定五个字段，不支持同类型多个实例

当前 `ProviderConfigs` 定义：

- `openai?: Option<OpenAIConfig>`
- `anthropic?: Option<AnthropicConfig>`
- `gemini?: Option<GeminiConfig>`
- `copilot?: Option<CopilotConfig>`
- `bodhi?: Option<BodhiConfig>`

位置：

- `bamboo/crates/bamboo-infrastructure/src/config/config.rs:303`
- `bamboo/crates/bamboo-infrastructure/src/config/config.rs:318`

这层就是“每个 provider type 只有一个槽位”的根本限制。

### 2.3 各 provider 配置结构是“单配置对象”而不是“实例对象”

例如 OpenAI 配置结构：

- `bamboo/crates/bamboo-infrastructure/src/config/config.rs:571`
- `bamboo/crates/bamboo-infrastructure/src/config/config.rs:585`
- `bamboo/crates/bamboo-infrastructure/src/config/config.rs:589`
- `bamboo/crates/bamboo-infrastructure/src/config/config.rs:593`

里面仍然包含 legacy 的：

- `model`
- `fast_model`
- `vision_model`

这说明当前 provider 配置对象同时承担了：

1. 认证配置
2. 上游连接配置
3. 默认模型配置
4. provider 级行为配置

但它没有自己的稳定 identity，比如：

- `id`
- `name`
- `provider_type`
- `enabled`

所以没法天然表示多个 OpenAI instance。

---

## 3. 当前前端 UI 为什么只能“一种一个”

### 3.1 前端类型层直接把 `providers` 定义成固定 key 对象

前端 `ProviderConfig` 类型：

- `lotus/src/pages/ChatPage/types/providerConfig.ts:21`
- `lotus/src/pages/ChatPage/types/providerConfig.ts:24`
- `lotus/src/pages/ChatPage/types/providerConfig.ts:29`
- `lotus/src/pages/ChatPage/types/providerConfig.ts:127`

当前类型是：

```ts
providers: {
  openai?: OpenAIConfig;
  anthropic?: AnthropicConfig;
  gemini?: GeminiConfig;
  copilot?: CopilotConfig;
  bodhi?: BodhiConfig;
}
```

这已经把 UI 建模锁死成“按 type 固定槽位”。

### 3.2 设置页是固定五个面板，不是动态实例列表

设置页组件：

- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:58`
- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:93`
- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:1304`
- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:1313`

当前它维护了一个固定集合：

```ts
const MODEL_PROVIDERS = [
  "openai",
  "anthropic",
  "gemini",
  "copilot",
  "bodhi",
]
```

并最终渲染成：

```tsx
<Collapse items={MODEL_PROVIDERS.map(...)} />
```

所以 UI 天然是：

- 五个固定面板
- 每个 type 一个面板
- 不存在新增一个 `openai-2` 的入口

### 3.3 设置页有单一 `currentProvider` / `provider` 选择

设置页表单里有全局 active provider：

- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:174`
- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:1243`
- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:1259`

这进一步说明 UI 认知模型仍然是：

- 先选当前 provider type
- 再编辑该 type 的配置

而不是：

- 管理多个 provider instances
- 再从 instances 中选默认项

### 3.4 保存时 payload 也是固定 `provider + providers` 结构

设置页保存逻辑：

- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:474`
- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:532`
- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:550`

保存 payload 仍是：

```ts
{
  provider,
  defaults,
  providers,
  features,
}
```

这里 `providers` 仍是固定对象，不是实例数组。

### 3.5 前端为了兼容后端，还会把 defaults.chat 同步回 `providers.{provider}.model`

保存时还有一段兼容逻辑：

- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:523`
- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx:529`

即：

- 根据当前 active provider
- 把 `defaults.chat.model`
- 回写到 `providers.{provider}.model`

这进一步说明前后端仍然共享“一个 provider type 一个配置槽位”的历史包袱。

---

## 4. 当前后端 API 为什么也只能“一种一个”

### 4.1 设置读取接口直接返回单个 `provider` + 固定 `providers`

后端 response 类型：

- `bamboo/crates/bamboo-server/src/handlers/settings/provider/types.rs:6`
- `bamboo/crates/bamboo-server/src/handlers/settings/provider/types.rs:17`

字段：

- `provider: String`
- `available_providers: Vec<String>`
- `providers: Value`
- `defaults`
- `features`

读取 handler：

- `bamboo/crates/bamboo-server/src/handlers/settings/provider/endpoints/get.rs:12`
- `bamboo/crates/bamboo-server/src/handlers/settings/provider/endpoints/get.rs:27`

这里 response 语义仍然是：

- 当前激活的是哪个 provider type
- 当前每个 provider type 的配置是什么

不是：

- 当前有哪些 provider instances
- 哪个 instance 是默认实例

### 4.2 更新接口会 patch 根字段 `provider`

更新 request：

- `bamboo/crates/bamboo-server/src/handlers/settings/provider/types.rs:21`
- `bamboo/crates/bamboo-server/src/handlers/settings/provider/types.rs:29`

更新逻辑：

- `bamboo/crates/bamboo-server/src/handlers/settings/provider/endpoints/update.rs:15`
- `bamboo/crates/bamboo-server/src/handlers/settings/provider/endpoints/update.rs:59`
- `bamboo/crates/bamboo-server/src/handlers/settings/provider/endpoints/update.rs:72`

其中 `build_provider_patch()` 会直接写：

- `provider`
- `providers`
- `defaults`

这等于把设置 API 的存储语义完全绑定到旧模型上。

### 4.3 校验逻辑仍依赖 `config.provider`

provider reload / validation 仍围绕当前默认 provider 运行：

- `bamboo/crates/bamboo-server/src/handlers/settings/provider/endpoints/reload.rs:11`
- `bamboo/crates/bamboo-server/src/handlers/settings/provider/endpoints/reload.rs:31`
- `bamboo/crates/bamboo-infrastructure/src/llm/provider_factory.rs:228`
- `bamboo/crates/bamboo-infrastructure/src/llm/provider_factory.rs:229`

当前 `validate_provider_config(config)` 是按 `config.provider` 做 match，然后只验证当前默认 provider type 是否配置完备。

这不适合多实例场景，因为多实例下应该有两种校验：

1. **instance-level validation**：某个实例是否有效
2. **routing-level validation**：默认 chat/fast/vision/sub-agent 指向的实例是否存在

---

## 5. 当前运行时现状：已经有一半“多 provider 路由”基础，但还不是“多实例管理”

### 5.1 `ProviderRegistry` 已经存在，但 key 仍是 provider type

当前 registry：

- `bamboo/crates/bamboo-infrastructure/src/llm/provider_registry.rs:11`
- `bamboo/crates/bamboo-infrastructure/src/llm/provider_registry.rs:33`
- `bamboo/crates/bamboo-infrastructure/src/llm/provider_registry.rs:36`
- `bamboo/crates/bamboo-infrastructure/src/llm/provider_registry.rs:61`

它会为所有“已配置的 provider”创建 provider 实例，并存进：

```rust
HashMap<String, Arc<dyn LLMProvider>>
```

但这里的 key 仍然是：

- `openai`
- `anthropic`
- `gemini`
- `copilot`
- `bodhi`

并不是：

- `openai-main`
- `openai-azure`
- `anthropic-team-a`
- `gemini-exp`

也就是说：

**运行时已经初步支持“多 type 并存”，但不支持“同 type 多 instance 并存”。**

### 5.2 `ProviderModelRef` 已经存在，但 provider 字段目前表示 type，不是 instance id

`ProviderModelRef`：

- `bamboo/crates/bamboo-domain/src/provider_model_ref.rs:10`
- `bamboo/crates/bamboo-domain/src/provider_model_ref.rs:13`
- `lotus/src/pages/ChatPage/types/providerModelRef.ts:1`
- `lotus/src/pages/ChatPage/types/providerModelRef.ts:4`

结构是：

```ts
{
  provider: string,
  model: string
}
```

目前这个 `provider` 虽然是字符串，但语义实际上还是 provider type。

**这是一个好消息**：

它不需要改名字就能升级成“provider instance id”。

也就是说未来可以直接让：

```json
{
  "provider": "openai-main",
  "model": "gpt-4.1"
}
```

这会比重新发明 `provider_instance_id` 更平滑。

### 5.3 `ProviderModelRouter` 已经能按 `ProviderModelRef.provider` 路由

router 实现：

- `bamboo/crates/bamboo-infrastructure/src/llm/router.rs:11`
- `bamboo/crates/bamboo-infrastructure/src/llm/router.rs:21`
- `bamboo/crates/bamboo-infrastructure/src/llm/router.rs:28`

目前它根据 `ProviderModelRef.provider` 去 registry 查 provider。

这意味着：

- 如果 registry 的 key 从 `provider type` 变成 `provider instance id`
- router 基本不需要换抽象

只需要换数据来源和 key 语义。

### 5.4 AppState 里同时存在旧单 provider 和新 registry，两套并存

`AppState` 当前同时持有：

- `provider: Arc<RwLock<Arc<dyn LLMProvider>>>`
- `provider_handle: Arc<dyn LLMProvider>`
- `provider_registry: Arc<ProviderRegistry>`
- `provider_router: Arc<ProviderModelRouter>`
- `model_catalog`

位置：

- `bamboo/crates/bamboo-server/src/app_state/mod.rs:167`
- `bamboo/crates/bamboo-server/src/app_state/mod.rs:176`
- `bamboo/crates/bamboo-server/src/app_state/mod.rs:277`
- `bamboo/crates/bamboo-server/src/app_state/mod.rs:284`

说明目前系统正处在一个中间态：

- 旧执行路径还依赖单一 active provider
- 新的 ProviderModelRef / catalog / router 已开始落地

### 5.5 `reload_provider()` 仍然只重载单 provider

当前 reload：

- `bamboo/crates/bamboo-server/src/app_state/config_runtime.rs:35`
- `bamboo/crates/bamboo-server/src/app_state/config_runtime.rs:68`
- `bamboo/crates/bamboo-server/src/app_state/config_runtime.rs:75`

逻辑仍然是：

- 读 `config.provider`
- `create_provider_with_dir(config, ...)`
- 替换单 provider handle

这也是旧语义残留的核心点之一。

---

## 6. Session / 路由层现状：已经接近实例路由，但身份还不够稳定

### 6.1 Session 已经有 `model_ref`

Session 结构里已有：

- `model: String`
- `model_ref: Option<ProviderModelRef>`

位置：

- `bamboo/crates/bamboo-domain/src/session/types.rs:468`
- `bamboo/crates/bamboo-domain/src/session/types.rs:470`

这是一个非常关键的基础：

**Session 层已经可以保存“provider + model”而不只是 model 字符串。**

### 6.2 Session 还通过 metadata 保存 `provider_name`

兼容逻辑：

- `bamboo/crates/bamboo-server/src/session_app/provider_model.rs:36`
- `bamboo/crates/bamboo-server/src/session_app/provider_model.rs:44`
- `bamboo/crates/bamboo-server/src/session_app/provider_model.rs:49`

当前会把 provider 信息写到：

- `session.model_ref`
- `session.metadata["provider_name"]`

这说明 session 侧已经具备迁移到 provider instance id 的条件。

### 6.3 `useActiveModel()` 前端仍主要返回 model string

前端 hook：

- `lotus/src/pages/ChatPage/hooks/useActiveModel.ts:28`
- `lotus/src/pages/ChatPage/hooks/useActiveModel.ts:33`
- `lotus/src/pages/ChatPage/hooks/useActiveModel.ts:44`

它优先取：

1. `session.config.model_ref.model`
2. `session.config.model`
3. `providerConfig.defaults.chat.model`

所以当前 UI/发送链路里，provider 身份虽然开始出现，但还不是所有地方的第一等公民。

---

## 7. 结论：这次设计不应该只改 UI，必须改配置模型

如果只改 UI，让前端可以“看起来新增多个 OpenAI”，但后端配置仍是：

```json
providers: {
  openai: {...}
}
```

那最终一定会落回：

- 后写覆盖前写
- 两个 OpenAI 面板映射到同一个后端槽位
- 删除逻辑也无法正确区分
- defaults.chat / fast / vision 指向会混乱

所以这次必须从 **配置 schema** 开始重设计，而不是只做展示层。

---

## 8. 推荐的新数据模型

## 8.1 新核心概念：ProviderInstance

建议新增统一实例模型：

```ts
interface ProviderInstance {
  id: string;                // 稳定主键，例如 openai-main
  type: "openai" | "anthropic" | "gemini" | "copilot" | "bodhi";
  label: string;             // 用户可编辑显示名，例如 “OpenAI Main”
  enabled: boolean;          // 是否启用
  config: ProviderTypeConfig; // 该类型专属配置
  metadata?: {
    created_at?: string;
    updated_at?: string;
    source?: "manual" | "imported";
  };
}
```

其中：

- `id` 是内部稳定标识，用于路由、session 持久化、defaults 绑定。
- `label` 是 UI 展示名，可改名。
- `type` 决定表单字段。
- `config` 里放 API key / base_url / overrides / provider-local defaults。

## 8.2 配置根结构建议

建议把现有：

```json
{
  "provider": "openai",
  "providers": { ... },
  "defaults": { ... }
}
```

重构成：

```json
{
  "provider_instances": [
    {
      "id": "openai-main",
      "type": "openai",
      "label": "OpenAI Main",
      "enabled": true,
      "config": {
        "api_key": "...",
        "base_url": "https://api.openai.com/v1",
        "reasoning_effort": "high",
        "responses_only_models": ["gpt-5*"],
        "request_overrides": { ... }
      }
    },
    {
      "id": "openai-azure",
      "type": "openai",
      "label": "Azure OpenAI",
      "enabled": true,
      "config": {
        "api_key": "...",
        "base_url": "https://xxx.openai.azure.com/..."
      }
    },
    {
      "id": "anthropic-main",
      "type": "anthropic",
      "label": "Anthropic Main",
      "enabled": true,
      "config": {
        "api_key": "..."
      }
    }
  ],
  "default_provider_instance_id": "openai-main",
  "defaults": {
    "chat": { "provider": "openai-main", "model": "gpt-4.1" },
    "fast": { "provider": "openai-main", "model": "gpt-4.1-mini" },
    "vision": { "provider": "openai-azure", "model": "gpt-4.1" },
    "sub_agent": { "provider": "anthropic-main", "model": "claude-sonnet-4" }
  }
}
```

## 8.3 为什么 `ProviderModelRef.provider` 应该直接复用为 instance id

不要新增：

- `provider_type`
- `provider_instance_id`

两个字段并存

建议直接复用现有：

```json
{ "provider": "openai-main", "model": "gpt-4.1" }
```

理由：

1. 当前 `ProviderModelRef` 已经广泛存在。
2. Router 本来就是按 `provider` 查 registry。
3. Session 已经存 `model_ref`。
4. 改语义比改结构便宜得多。

未来如果需要 provider type，应该从 instance 上反查，而不是每次冗余存两份。

---

## 9. 后端重设计建议

## 9.1 config 层

### 目标

把 `ProviderConfigs` 固定字段容器，替换成 `ProviderInstancesConfig`。

### 建议新增 Rust 类型

```rust
pub struct ProviderInstanceConfig {
    pub id: String,
    pub r#type: String,
    pub label: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub config: serde_json::Value,
}

pub struct ProviderInstancesConfig {
    pub instances: Vec<ProviderInstanceConfig>,
}
```

更好的做法是 `config` 用 tagged enum：

```rust
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProviderInstance {
    OpenAI(OpenAIInstance),
    Anthropic(AnthropicInstance),
    Gemini(GeminiInstance),
    Copilot(CopilotInstance),
    Bodhi(BodhiInstance),
}
```

但如果想降低第一阶段复杂度，也可以先：

- 外层统一实例对象
- 内层 `config` 仍是 typed struct + serde dispatch

### 兼容字段建议

迁移期建议保留只读兼容：

- 旧 `provider`
- 旧 `providers`

但内部逻辑应切到新结构。

不建议长期双写，否则会持续拖慢演进。

---

## 9.2 provider factory / registry 层

### 当前问题

当前 factory 和 registry 都是按 provider type 工作：

- `bamboo/crates/bamboo-infrastructure/src/llm/provider_factory.rs:39`
- `bamboo/crates/bamboo-infrastructure/src/llm/provider_registry.rs:33`
- `bamboo/crates/bamboo-infrastructure/src/llm/provider_registry.rs:36`

### 新目标

把 registry 的 key 改成 **provider instance id**。

### 建议新签名

```rust
pub async fn create_provider_for_instance(
    instance: &ProviderInstance,
    global_config: &Config,
    app_data_dir: PathBuf,
) -> Result<Arc<dyn LLMProvider>, LLMError>
```

以及：

```rust
pub struct ProviderRegistry {
    providers: HashMap<String, Arc<dyn LLMProvider>>, // key = instance_id
    default_provider_id: String,
}
```

### 关键收益

- 可以同时持有多个 OpenAI provider
- Router 无需理解 type，只要按 instance id 查表
- catalog 可以按实例维度列模型

---

## 9.3 validation 层

### 当前问题

当前 validation 是“验证当前默认 provider”。

### 新建议

拆成三层：

#### A. Instance schema validation

验证每个实例：

- `id` 非空、唯一、合法
- `label` 非空
- `type` 合法
- 对应类型必填字段齐全

#### B. Routing validation

验证：

- `default_provider_instance_id` 是否存在
- `defaults.chat.provider` 是否存在且 enabled
- `defaults.fast/vision/...` 指向的 instance 是否存在

#### C. Deletion guard validation

删除某个 instance 前检查：

- 是否被 `default_provider_instance_id` 引用
- 是否被 `defaults.*` 引用
- 是否被 `subagent_models` 引用

建议策略：

- 要么阻止删除并提示用户先改默认路由
- 要么删除时自动回退并要求确认

我更推荐：

**后端阻止删除 + 前端提前提示**。

这样行为更稳定、可预测。

---

## 9.4 settings API 层

### 当前接口

- `GET /bamboo/settings/provider`
- `POST /bamboo/settings/provider`
- `POST /bamboo/settings/provider/models`
- `GET /bamboo/provider-catalog`
- `POST /bamboo/provider-catalog/fetch-models`

位置：

- `bamboo/crates/bamboo-server/src/routes/bamboo_v1.rs:91`
- `bamboo/crates/bamboo-server/src/routes/bamboo_v1.rs:99`
- `bamboo/crates/bamboo-server/src/routes/bamboo_v1.rs:188`
- `bamboo/crates/bamboo-server/src/routes/bamboo_v1.rs:192`

### 建议新接口

#### 读取

```http
GET /bamboo/settings/provider-instances
```

返回：

```json
{
  "default_provider_instance_id": "openai-main",
  "instances": [...],
  "defaults": {...},
  "features": {...}
}
```

#### 创建实例

```http
POST /bamboo/settings/provider-instances
```

body:

```json
{
  "type": "openai",
  "label": "OpenAI Main",
  "config": { ... }
}
```

#### 更新实例

```http
PUT /bamboo/settings/provider-instances/{instance_id}
```

#### 删除实例

```http
DELETE /bamboo/settings/provider-instances/{instance_id}
```

#### 设置默认实例

```http
POST /bamboo/settings/provider-instances/default
```

body:

```json
{ "instance_id": "openai-main" }
```

#### 拉模型

```http
POST /bamboo/settings/provider-instances/{instance_id}/models/fetch
```

或者 bulk：

```http
POST /bamboo/provider-catalog/fetch-models
{
  "provider_instance_id": "openai-main"
}
```

### 为什么不要继续复用 `/settings/provider`

因为这个接口名和语义都已经强绑定：

- 单 active provider
- 固定 providers 对象

继续复用只会导致：

- payload 越来越扭曲
- 前后端兼容分支越来越多
- 后续测试难维护

建议：

- 新增 instance 化接口
- 旧接口短期兼容，只服务旧前端
- 前端切完后再删旧接口

---

## 10. 前端 UI 重设计建议

## 10.1 从“固定 provider 面板”改成“实例列表”

### 当前 UI

- 全局 active provider select
- 固定五个折叠面板
- 每种 type 一个表单

### 建议新 UI

#### 区块 A：Provider Instances

列表项字段：

- Label，例如 `OpenAI Main`
- Type，例如 `OpenAI`
- Status，例如 `Authenticated / Not Configured / Invalid`
- 是否默认
- 操作按钮：`Edit` / `Delete` / `Fetch Models`

顶部操作：

- `Add Provider`

#### 区块 B：Create / Edit Drawer

用户点击新增时先选：

- OpenAI
- Anthropic
- Gemini
- Copilot
- Bodhi

选定后展示对应表单。

#### 区块 C：Default Routing

不再是 `Active Provider` 下拉，而是：

- Default Chat Model -> `ProviderModelPicker`（按 instance）
- Fast Model -> `ProviderModelPicker`
- Vision Model -> `ProviderModelPicker`
- Sub Agent Model -> `ProviderModelPicker`

这些 picker 选择的 `provider` 字段，直接是 `instance_id`。

## 10.2 provider 列表项应展示 label + type，而不是只展示 type

例如：

- `OpenAI Main` · OpenAI
- `Azure OpenAI` · OpenAI
- `Anthropic Prod` · Anthropic

这样用户才能理解“同类型多个实例”的差异。

## 10.3 删除交互建议

删除时要做前置提示：

### 情况 A：未被引用

直接删。

### 情况 B：被默认路由引用

弹窗：

- 此 provider 正被 `Default Model` / `Fast Model` / `Vision Model` 使用
- 请先重新选择这些默认项，再删除

### 不建议自动 silent fallback

因为这会导致：

- 用户不知道默认模型被偷偷切走了
- 会话行为变化难解释

---

## 11. Catalog / Model Picker 也需要升级为“按实例维度”

### 当前 catalog 结构

- `ProviderDescriptor.id`
- `ProviderModelDescriptor.reference.provider`

位置：

- `bamboo/crates/bamboo-domain/src/provider_catalog.rs:3`
- `bamboo/crates/bamboo-domain/src/provider_catalog.rs:52`
- `bamboo/crates/bamboo-domain/src/provider_catalog.rs:67`

当前 `id` 语义是 provider type。

### 新建议

把 catalog 中 provider descriptor 的 `id` 改成 instance id：

```json
{
  "providers": [
    {
      "id": "openai-main",
      "display_name": "OpenAI Main",
      "enabled": true,
      "authenticated": true,
      "type": "openai"
    }
  ],
  "models": [
    {
      "reference": {
        "provider": "openai-main",
        "model": "gpt-4.1"
      },
      "provider_display_name": "OpenAI Main"
    }
  ]
}
```

注意：

- `provider_display_name` 应该显示 instance label，不再只是 type label
- 最好额外返回 `provider_type`

否则 UI 会丢失“这是哪个类型”的信息。

---

## 12. 迁移策略建议（非常重要）

我建议分三阶段，而不是一次性硬切。

## Phase 1：后端先支持实例数据结构，但兼容旧 UI

### 目标

- 配置层支持 `provider_instances`
- registry 改为按 instance id 建立
- `ProviderModelRef.provider` 语义升级为 instance id
- 旧 `provider/providers` 仍能自动迁移为默认实例集

### 迁移规则

旧配置：

```json
{
  "provider": "openai",
  "providers": {
    "openai": {...},
    "anthropic": {...}
  },
  "defaults": {
    "chat": { "provider": "openai", "model": "gpt-4.1" }
  }
}
```

启动时自动映射成：

```json
{
  "provider_instances": [
    { "id": "openai", "type": "openai", "label": "OpenAI", "enabled": true, "config": {...} },
    { "id": "anthropic", "type": "anthropic", "label": "Anthropic", "enabled": true, "config": {...} }
  ],
  "default_provider_instance_id": "openai",
  "defaults": {
    "chat": { "provider": "openai", "model": "gpt-4.1" }
  }
}
```

这样老用户无感迁移。

## Phase 2：前端切到 instance 列表 UI

### 目标

- `ProviderSettings` 改成实例列表
- 新增 create/edit/delete
- `ProviderModelPicker` 显示 instance label
- `providerSlice` 不再维护 `currentProvider: ProviderType`

建议替换为：

```ts
currentProviderInstanceId?: string
providerConfig: {
  instances: ProviderInstance[]
  default_provider_instance_id?: string
  defaults?: DefaultsConfig
}
```

## Phase 3：删除 legacy provider type-only 结构

### 清理项

- 删除根字段 `provider`
- 删除固定 `providers.openai / anthropic / ...`
- 删除 `providers.{provider}.model` 兼容同步逻辑
- 删除旧 `/bamboo/settings/provider` 旧 payload 依赖

---

## 13. 我建议的最小可落地改造顺序

如果要控风险，推荐按下面顺序做：

### Step 1. 引入 `ProviderInstance` 配置模型

先不改 UI，只改后端 schema / load / save / migration。

### Step 2. registry 改为 instance id key

让以下能力先跑通：

- 同时持有多个 OpenAI instance
- `ProviderModelRef.provider` 指向 instance id
- `ProviderModelRouter` 按 instance id 路由

### Step 3. catalog 改成实例维度

让 model picker 能分辨：

- OpenAI Main
- Azure OpenAI

### Step 4. settings API 改成 instance CRUD

新增：

- list instances
- create instance
- update instance
- delete instance
- set default instance

### Step 5. settings UI 重做

把当前固定五面板替换成：

- 实例列表
- 新建编辑弹窗
- 默认路由配置

### Step 6. session / sendMessage / createSession 全面以 `model_ref` 为准

彻底减少对裸 `model` string 和 `currentProvider` 的依赖。

---

## 14. 关键实现建议

## 14.1 `ProviderModelRef` 不改结构，只改语义

这是整个重构里性价比最高的一点。

保留：

```rust
pub struct ProviderModelRef {
    pub provider: String,
    pub model: String,
}
```

但把 `provider` 的语义改为：

- 过去：provider type
- 未来：provider instance id

## 14.2 不建议把默认 chat/fast/vision 再塞回 instance config 里做主路由

实例 config 里可以允许保留：

- `default_model`
- `fast_model`
- `vision_model`

作为 instance-local fallback

但真正全局路由仍建议放在根 `defaults`：

```json
"defaults": {
  "chat": { "provider": "openai-main", "model": "gpt-4.1" },
  "fast": { "provider": "anthropic-fast", "model": "claude-3-haiku" }
}
```

原因：

- 路由职责清晰
- UI 清晰
- 能显式跨实例组合

## 14.3 删除实例时必须做引用检查

至少检查这些引用：

- `default_provider_instance_id`
- `defaults.chat`
- `defaults.fast`
- `defaults.vision`
- `defaults.memory_background`
- `defaults.planning`
- `defaults.search`
- `defaults.code_review`
- `defaults.sub_agent`
- `defaults.subagent_models[*]`
- 当前活跃 session 的 `model_ref.provider`（可选：删除时只提示，不强阻止）

### 关于 session 的建议

我建议：

- 已存在 session 若引用已删除 instance，执行时返回明确错误
- 不要在后台静默重写 session 的 provider

因为会话应该是可回放、可解释的。

---

## 15. 受影响文件（高优先级）

### 后端

#### 配置模型
- `bamboo/crates/bamboo-infrastructure/src/config/config.rs`

#### provider 构建 / registry / router
- `bamboo/crates/bamboo-infrastructure/src/llm/provider_factory.rs`
- `bamboo/crates/bamboo-infrastructure/src/llm/provider_registry.rs`
- `bamboo/crates/bamboo-infrastructure/src/llm/router.rs`
- `bamboo/crates/bamboo-infrastructure/src/llm/model_catalog.rs`

#### settings API
- `bamboo/crates/bamboo-server/src/handlers/settings/provider/types.rs`
- `bamboo/crates/bamboo-server/src/handlers/settings/provider/endpoints/get.rs`
- `bamboo/crates/bamboo-server/src/handlers/settings/provider/endpoints/update.rs`
- `bamboo/crates/bamboo-server/src/routes/bamboo_v1.rs`

#### app runtime
- `bamboo/crates/bamboo-server/src/app_state/mod.rs`
- `bamboo/crates/bamboo-server/src/app_state/config_runtime.rs`
- `bamboo/crates/bamboo-server/src/app_state/provider_api.rs`
- `bamboo/crates/bamboo-server/src/model_config_helper.rs`
- `bamboo/crates/bamboo-server/src/session_app/provider_model.rs`

### 前端

#### 类型与状态
- `lotus/src/pages/ChatPage/types/providerConfig.ts`
- `lotus/src/pages/ChatPage/types/providerModelRef.ts`
- `lotus/src/pages/ChatPage/store/slices/providerSlice.ts`
- `lotus/src/pages/ChatPage/hooks/useActiveModel.ts`

#### 设置页
- `lotus/src/pages/SettingsPage/components/ProviderSettings/index.tsx`
- `lotus/src/services/config/SettingsService.ts`

#### Model Picker / catalog 消费
- `lotus/src/pages/ChatPage/components/ProviderModelPicker/index.tsx`

---

## 16. 最终建议

### 我给你的明确建议是：

**把这次改造定义为“Provider Instance 化”项目，而不是“允许多个 provider”这种模糊目标。**

最合理的目标模型是：

1. `provider type` 只决定表单/schema/上游协议
2. `provider instance` 才是真正的配置与路由对象
3. `ProviderModelRef.provider` 直接升级为 `provider_instance_id`
4. `defaults.*` 统一引用 instance id + model
5. UI 改成实例列表 + CRUD + 默认路由配置

### 为什么这是最优解

因为它：

- 能真正支持多个 OpenAI / 多个 Anthropic / 多个 Gemini
- 最大化复用已有 `ProviderModelRef` / `ProviderRegistry` / `ProviderModelRouter` 基础设施
- 能平滑兼容老配置
- 不会把复杂度继续堆在旧的 `provider/providers` 结构上

---

## 17. 我建议的实施优先级

### 第一优先级
- 后端 schema 改成 instance 化
- registry key 改成 instance id
- settings API 增加 instance CRUD

### 第二优先级
- 前端 settings UI 重做为实例列表
- model picker / catalog 改为实例显示

### 第三优先级
- 清理 legacy `provider/providers.{type}` 路径
- 清理 `currentProvider` 相关旧状态

---

## 18. 一句话总结

**当前系统已经有“多 provider 路由”的半套基础，但配置模型和设置 UI 仍然是“每种类型一个槽位”。要支持同类型多个 provider 并允许创建/删除，必须把 provider 从“类型配置”升级成“实例对象”，然后让所有路由与默认模型都绑定到 instance id。**
