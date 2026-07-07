# Lotus → Lotus-Next 迁移体检与落地计划

> 状态:**功能补齐大批次已落地** · 最后更新:2026-07-07
>
> **2026-07-07 大批次(用户拍板:除 i18n 全部同步;传输只要 WSS 不要 SSE):**
> 1. **传输 WSS-only 完成**:删除两条 legacy SSE 路径 + WS→SSE 回退机制 + `bodhi_api_v2_ws` 开关(净 −541 行);v2Stream 即唯一传输,初连失败与断线同走有界退避重连;msgpack 保持 opt-in。§2.2 的 "v2 WebSocket 传输 🟡" 行已过时 → ✅ 且比 lotus 更进一步(lotus 还保留回退)。
> 2. **运行期可见性完成**(审计发现的最大洞):useChat 接上 tool_start/token/complete、task_list_*、token_budget、compression 事件 → live 工具卡(分段时间线,修多轮文本堆积)、Inspector 任务清单实时 + 评估横幅、用量环实时、状态行。
> 3. **流式韧性完成**:被动观察引擎(他端/定时任务驱动的 run 自动订阅)、搁浅终态回收、visibilitychange 回收、WS 重连即时 reconcile(WSS-only 后这些是必需品,不再有 SSE 兜底)。
> 4. **Settings 深度(9 路并行实现)**:定时任务全触发类型+策略+run-now+历史(修复 P0:cron 字段 `expression`→`expr`,创建从未生效)、Providers 深度(enabled 开关/类型变更/defaults.*/overrides/OAuth 打磨)、MCP 深度(编辑/env/cwd/headers/工具列表)、技能启停+搜索、通知后端偏好、系统面板(代理/记忆/子代理/工具/访问密码/模型限额/会话维护)、集群 tab + MachineTag(#33/#34 数据层已逐字移植)、指标仪表盘(纯 SVG)、提示词 + 工作流 tab + CommandService、导出 PDF 改渲染管线(CJK 安全)。
> 5. **聊天集成**:enhance_prompt 管线恢复(此前静默缺失)、新会话系统提示词预设 chip、SlashMenu 合并工作流(/v1/commands + 发送展开)、键盘导航(↑↓/Enter/Tab/Esc)、每会话草稿、待答问题会话打开恢复、AI 生成标题、主题跟随系统、Root 启动顺序修复(密码门先于 setup 探测)+ 有界重试、preloadError 自动重载、根 ErrorBoundary。
> **仍未做**:FileChangeViewer/Diffs 区、HomeDashboard + 模板启动器、单 pane 多会话并发流式(useChat per-session buffer Map)、侧栏过滤/内容搜索/批量删除、命令面板深度、mermaid 缩放/主题、消息上下文操作、输入历史、Run Project Dream、引导 tour、传输测试套件;生产切换(选项 B)仍按 dev-first 分期推迟。
>
> **已拍板的方向决策:**
> 1. **产品定位 = next 渐进取代 lotus**(最终走选项 B:打包脚本改服 lotus-next;lotus 在 next 达到功能水位后退役)。
> 2. **优先抽取 `@bigduu/lotus-core` 共享层**(两端共享后端/服务/状态层)。
>
> **修订后的分期(2026-06-28):先不并入 bamboo。** 当前阶段 = **dev-first**:bamboo 继续只服务 lotus(embed 管线一行不改),next 用 vite dev(`:9563` proxy → `:9562`)迭代开发,等功能达到水位后再做选项 B 的生产切换。选项 B / `--static-dir` 部署 = 已验证可行但**推迟**。
>
> **终局定调(2026-06-28):next = 桌面+移动统一的单一 UI,antd 整体退役。** 真正驱动力是 antd 定制化能力低(改 UI 处处受制),不只是移动。所以 next 要长成**响应式**(窄屏单栏 ↔ 宽屏多栏)以最终接管桌面,lotus 退役。**当前最高杠杆 = 补 next 的组件地基**(见 §9),否则 next 会从"antd 改不动"换成"内联 Tailwind 散落、改 10 处"的新泥潭。i18n 暂缓(工作量大、非核心)。

本文档是一次全面体检(5 路并行代码审计)的结论沉淀,供团队留存与跟踪迁移进度。

---

## 0. 一句话结论

> **后端/服务/状态层已经几乎 100% 迁移完成。真正的 gap 在三处:UI 功能补全、共享层去重、生产部署与发布链路。**
> 这不是"重做一遍",而是"把已搬好的引擎装上移动端车壳 + 接上生产油路"。

三个支撑数字:

1. **service + shared 层 103 个运行时文件,99 个字节级完全相同(96.1%)**;仅 4 个微小漂移,且 4 个全是 **lotus-next 更新更对**(bypass 权威性、通知分支、模型回退、类型 cast)。lotus 没有任何 next 缺失的后端逻辑。
2. **lotus-next 在仓库里除自身目录外零引用** —— 未进 bamboo 打包、未进 bodhi、未进 CI/release、无版本号。今天只能靠手动开 `:9563` vite dev server 才能被手机访问。
3. **lotus 有 152 个文件 import antd(+84 个 import 图标)** —— 这是唯一真正"不该迁"的大块;next 已 0 antd。

---

## 1. 现状全景

| | lotus(电脑端) | lotus-next(移动端) |
|---|---|---|
| 文件量 | 544 ts/tsx | 149 ts/tsx |
| UI 栈 | antd 5 + 自定义 CSS(App.css 38KB) | shadcn/Tailwind v4 + lucide + radix-slot + cva/clsx |
| 状态 | Zustand(应用) + **Jotai 原子机**(高频流式) | Zustand + 单个 `useChat` hook(P0 简化版) |
| 路由 | 状态机(无 react-router)+ `pages/` 分页 | 状态机,**整个 App 是一个 ~1100 行组件**,无 `pages/` |
| 工具链 | React 18 / Vite 6 / TS 5.6 / eslint / vitest + e2e | React 19 / Vite 8 / TS 6 / oxlint / **无测试** |
| 语言 | i18next 多语(en/zh/fr/hi)+ 切换器 | **硬编码中文**,i18n 基建已在但 UI 一句没接 |
| 生产部署 | 编译进 bamboo 二进制 → 运行时解压到 `bamboo_home/frontend/` → 单挂载 `/` | **无生产路径**,仅 dev proxy(`:9563` → `:9562`) |

**关键架构事实**

- bamboo 每个 App 工厂只挂载 **一个** `actix_files::Files::new("/", static_dir)` + SPA fallback(`bamboo/crates/app/bamboo-server/src/server/entrypoints.rs` 两个工厂 + `web_service.rs`)。
- 前端在 **编译期** embed 进 bamboo 二进制(`build.rs` 的 `include_bytes!`),**运行期**比对 manifest 后解压到 `bamboo_home/frontend/`。zip 由 `bamboo/scripts/frontend-package.cjs` 在构建期从 `../lotus/dist` 生成,`frontend_name:"lotus"` 是唯一硬编码。
- bodhi 是 Tauri **v2.5** 外壳,跑 `bamboo serve` 当 sidecar;release 里 webview `navigate("http://127.0.0.1:9562")`。即 **bodhi 显示的就是 bamboo 服务的东西**(今天 = lotus)。指向 next 只需改一个 URL,前提是 bamboo 先服务 next。
- 路径坑:打包写到 workspace 根,embed 从 crate 目录读;`bodhi/scripts/build-sidecar.cjs` 用一次镜像 copy 兜底。

---

## 2. 细致功能对比矩阵

状态:✅DONE · 🟡PARTIAL · 🔴MISSING/STUB。移动判定:📱适配良好 · ⚠️需重设计 · 🖥️桌面专属可丢。

### 2.1 已对齐(可放心)

| 功能 | next | 备注 |
|---|---|---|
| 聊天 / SSE 流式 | ✅ | `useChat` + `AgentService`;RAF 合帧、停止、重试、编辑、fork |
| Markdown / 代码 / Mermaid / Reasoning 渲染 | ✅ | 全部 lazy 拆分 |
| 工具调用渲染 | ✅ | 分组折叠 + 内置工具块 |
| 子代理 + 点进子会话 transcript | ✅ | 含"返回父会话" |
| 文件引用 / 附件 / 图片 paste-drop | ✅ | `@`FileMenu + ReferencePane(桌面 split 已标注 deferred) |
| 模型 / Reasoning / Workspace 选择器 | ✅ | |
| 会话列表 / 分组 / 置顶 / 搜索 | ✅ | `lib/groupChats.ts` |
| 导出 MD / PDF | ✅ | 浏览器 blob + Tauri 双路径,均守卫 |
| 子代理审批 / 提问对话框 | ✅ | |
| 8 个设置子面板 | ✅ | Env / Masking / Mcp / Notifications / Permissions / Providers / Schedules / Skills 全在 |
| 密码门 | ✅ | |
| 多设备被动同步 | ✅ | accountFeed → refreshChats(next 的 bypass 权威性更对) |

### 2.2 有缺口(迁移要补)

| 功能 | next | 缺口 & 移动判定 |
|---|---|---|
| **i18n 多语 UI** | 🔴 | **最大退化**:组件全硬编码中文,无切换器;基建/resources 在但没接 `useTranslation`。📱必补 |
| **首次 Setup 向导** | 🟡 | 只是"去后端/桌面配好再回来"占位卡(`setup-wizard` 浏览器被禁)。📱浏览器期需远程配置流 |
| **v2 WebSocket 传输** | 🟡 | 客户端(含 msgpack)已写全,但 flag 默认 OFF,实跑 SSE。📱开关 + 验证即可 |
| **主题** | 🟡 | 仅 light/dark,无跟随系统。📱小补 |
| **流式状态机** | 🟡 | P0 简化版(非桌面 Jotai 机);child-live-preview 等富 UX 未对齐。⚠️按需补,别照搬 Jotai |
| TodoList / Skills / ReferencePane | 🟡 | 均**只读**;无 skill 编辑、无多 pane 编辑器。📱只读对移动多数够用 |
| **System Prompt 选择 / 增强** | 🔴 | 桌面有完整 prompt 管理 + enhancement,next 未见。📱按需 |
| **Workflows 选择 / 运行 / 结果卡** | 🔴 | 桌面有 `/workflow` 选择器 + WorkflowResultCard,next 未见。📱按需 |
| **消息反馈(赞/踩 → 变体重试)** | 🔴 | 桌面 MessageFeedback,next 无。📱可选 |
| **Plan 卡(Execute/Refine)** | 🔴 | 桌面 PlanMessageCard,next 未见。📱按需 |
| Home 仪表盘 / 快速启动模板 | 🔴 | 桌面 HomeDashboard + 模板,next 无。📱可选 |
| Provider 多实例深度 | 🟡 | next SettingsProviders 在,但桌面是 1670 行多实例巨表 + Copilot device-code OAuth,需核对深度 |

### 2.3 桌面专属(不迁,这是对的)

多 pane / ResizableSplit、⌘K 命令面板(next 已改 sheet)、recharts 指标仪表盘、mermaid zoom/pan、拖拽、native 文件对话框、Jotai 原子机、13-tab 密集设置 —— 全部桌面专属或已被 next 重设计,**不照搬**。

---

## 3. 过时 / 应丢弃清单(迁移中顺手清掉)

**确认死代码 / 应丢(高置信):**

- `lotus/src/pages/ChatPage/hooks/useChatManager/openAiStreamingRunner.ts` —— **零引用**,直连 OpenAI 的旧绕行链路,死的。
- `lotus/src/compat/antd/` —— 一行 no-op stub,全仓零引用,孤儿。
- `lotus/dist.lotus-bak/` —— 提交进仓的陈旧构建产物(minified jspdf/vendor)。
- `lotus/src/.../useChatManager.ts` —— 向后兼容 re-export 垫片。
- `lotus/scripts/rebrand.cjs` + `rebrand:*` —— 脚本自注"legacy name kept",现仅写一个 env 变量;移动端不需要。
- 一次性 localStorage 迁移助手(SystemPromptService 的 DEPRECATED keys、taskEnhancementUtils 的 LEGACY key、providerSlice/modelSlice 的"Legacy 兼容"双形态)—— 全新移动构建不必带。
- 重依赖(next 已全丢):`antd / @ant-design/icons / recharts / react-zoom-pan-pinch / html2canvas / jotai / jotai-family / openai`。

**lotus 内部重复实现,重建应合并:**

- **两个 Todo 组件**:`components/TodoList/TodoList.tsx`(507 行,inspector)vs `pages/ChatPage/components/TodoListDisplay/index.tsx`(168 行,message)—— 同源两渲染,合一。
- **三层通知**:desktopNotification(OS)/ preferencesApi / notificationCopy + 设置 tab。按既有架构,通知已 frontend→backend(bamboo-notification crate + SSE relay),桌面 OS 通知层基本 legacy,统一走后端 relay。
- **传输三路**:保留 v2Stream(WS)+ AgentService(SSE 自动回退),**丢掉 OpenAI 直连绕行**(只剩一个 mermaid-autofix 在用,可折进正常后端调用)。

---

## 4. 重构:抽取 `@bigduu/lotus-core` 共享层 ✅已决策

体检最有价值的发现:**96% 字节相同 + antd 零泄漏到 shared 层 + 零 next-only 文件 → 共享 core 极易抽取。**

**抽取范围**:`services/*` + `shared/store` + `shared/types` + `shared/utils` + `shared/i18n(resources)` + `shared/services`。

**4 个障碍(全机械活):**

1. antd 耦合文件(`shared/components/**` 24 个、`theme/tokens.ts`、`i18n/antdLocale.ts`)本就 lotus-only,**别拉进 core** 即可。
2. **唯一跨别名耦合**:next 的 `accountFeed.ts` import `@/lib/notify`;core 不能依赖 `@/lib` → 用 `notify` 适配器/回调注入。
3. i18n resources 字节相同、无 antd → 直接共享。
4. Jotai-vs-useChat 分歧住在 `pages/`/`hooks/`,**不进 core**;各 app 留各自流式展现层。

**抽取前置**:先把 4 个漂移统一采用 **next 版本**(它都是更对的一侧),再把 lotus 那 ~50 个层测试搬进 core(next 当前这层零测试)。

**收益**:消除"每个后端协议改动手动镜像两份"的长期痛(per-session bypass 已是两边各写一遍的活证据)。

---

## 5. 部署:next 取代 lotus(选项 B) ✅已决策

> 既然 next 渐进取代 lotus,选 **B = 参数化 `frontend-package.cjs` 改服 lotus-next**,复用整条 embed→extract→serve 管线,bodhi 零 Rust 改动。

**B 的改动面(最小)**:`bamboo/scripts/frontend-package.cjs` —— 已是 env 驱动(`LOTUS_SOURCE` / `LOTUS_LOCAL_PATH` / `LOTUS_PACKAGE_NAME`),唯一需改的硬编码是 manifest 里的 `frontend_name:"lotus"`,以及把源指向 `../lotus-next`(或发布的 `@bigduu/lotus-next`)。bodhi 仍 `navigate(:9562)`,显示的就变成 next。

**4 个服务选项(留档对比,已选 B):**

| 选项 | 做法 | 改动面 | 成本 | 取舍 |
|---|---|---|---|---|
| ~~D 独立 artifact + 端口/tunnel~~ | `--static-dir` 已有 | 仅 ops | 低 | 今天可上;但第二进程。**适合 P0 临时验证** |
| **B 打包脚本改服 next** ✅ | 参数化 `frontend-package.cjs` | 1 个 JS | 低 | 最干净的"next 即产品"切换;替换非共存 ← **选它** |
| ~~A 第二静态挂载 /m~~ | 加 `Files::new("/m",…)` + 第二 embed | 3 Rust + JS | 中高 | 一源共服双 UI;改 embed 管线 |
| ~~C UA/视口路由~~ | default_handler 按 UA 选 bundle | 最多 | 高 | 单 URL 自动分流;UA 嗅探脆 + 资源命名空间冲突 |

> 注:**P0 阶段仍可先用 D**(`bamboo serve --static-dir lotus-next/dist --port 9563` + tunnel)快速拿到一个可用移动 URL,再过渡到 B 作为正式切换。

---

## 6. 移动端路线图:浏览器 → tauri-mobile →(tauri 作容器)

### 阶段 0(今天就能上):浏览器 + cloudflared

next 已 browser-first(`isTauriEnvironment` 全守卫,tauri plugin 懒加载,HTTP 同源连 bamboo)。最快 = 选项 D 把 `lotus-next/dist` 用 `--static-dir` 服起来 + tunnel。
- **唯一需打通**:远程访问鉴权(loopback 绕过密码,tunnel 是远程)→ 走已建好的 v2 设备 token `/v2/pair` + Bearer。

### 阶段 1:tauri-mobile —— **需新外壳,不是改 bodhi**

- Tauri v2.5 本身支持移动(GA),bodhi `lib.rs` 已有 `#[cfg_attr(mobile, tauri::mobile_entry_point)]`。
- **但 bodhi 未初始化移动**:`gen/` 只有 schemas,无 `gen/android`、`gen/apple`,无 `bundle.iOS/android` 配置。
- **致命点**:bodhi 是 **sidecar 架构**(ship `bamboo` 二进制本地跑)。iOS/Android **不允许 ship/spawn 任意原生 sidecar** → 移动 app **不能本地跑 bamboo,必须连远程 bamboo**(即阶段 0 的 tunnel)。
- 所以移动外壳是 **根本不同的形态**:无 sidecar、`frontendDist=lotus-next`、连远程后端 + 设备 token 鉴权。这正呼应"**tauri 最终是容器**"——壳在前,后端在远端。

→ 结论:**新建/重分支一个 mobile Tauri 壳**,复用 lotus-next 当 frontendDist + mobile_entry_point + 已声明的 plugin-dialog/fs;丢掉 sidecar/桌面窗口/macOS 签名;加 `tauri ios/android init` + 远程后端配置。**前置 = 阶段 0 的远程鉴权先稳。**

---

## 7. 发布链路缺口清单(lotus-next 当一等公民)

1. `release-train.config.json` + `nightly-release.yml` 的 jq 加 `versions.lotus_next`(package.json 留 `0.0.0`,发布时打日期版本)。
2. 建 publish workflow(镜像 lotus 的 `publish-npm.yml` 发 `@bigduu/lotus-next`)**或**走静态 artifact。
3. `release-train.yml` 加 dispatch + wait 步骤。
4. 按选项 B 接 bamboo 打包(改 `frontend-package.cjs` 消费 `@bigduu/lotus-next` + `frontend_name`,bodhi `release.yml` 传 `lotus_next_version`)。
5. submodule 指针机制已被 `submodule-guard.yml` 覆盖(next 已在 `.gitmodules`);推 zenith main 注意 nightly auto-commit 冲突,fetch + rebase 即可。

---

## 8. 分阶段迁移路线(总,2026-06-28 修订:dev-first)

> 修订要点:**不急着并入 bamboo**。当前停留在 dev 开发,把功能做齐 + 共享层去重,部署切换后移。

- **当前阶段 = dev-first 开发**:bamboo 只服务 lotus(不动);next 用 vite dev(`:9563` proxy → `:9562`)迭代。手机调试走局域网(`host:true` 已开,`http://<Mac-LAN-IP>:9563`)或为 :9563 单开一条 tunnel。
- **P1 去重固本(可立即并行)**:抽 `@bigduu/lotus-core`,统一 4 个漂移,搬测试进 core;清掉第 3 节死代码(死代码已于 2026-06-28 清理:openAiStreamingRunner / compat/ / dist.lotus-bak)。dev 模式下双份同步痛持续,此项价值不降反升。
- **P2 功能补全**(按移动价值排序):i18n UI 多语 + 切换器(最大退化)→ 远程 Setup 流 → System Prompt / Workflows / Plan 按需 → 主题跟随系统 → Provider 多实例深度核对。
- **P3 部署切换(达到功能水位后再做)**:选项 B 正式让 bamboo/bodhi 服务 next;接 CI/release(第 7 节)。**已验证**:`bamboo serve --static-dir lotus-next/dist` 可作为生产 SPA+API 单 origin 服务(6 项 curl 验证通过),随时可切。
- **P4 容器化**:新 mobile Tauri 壳,连远程 bamboo。

> **P0 临时点亮(已验证、暂不启用)**:`bamboo serve --port 9562 --bind 127.0.0.1 --data-dir ~/.bamboo --static-dir <lotus-next/dist>` + 现有 :9562 tunnel,即可让手机看到带真实 provider/会话的 lotus-next。需先停 bodhi/常规 :9562;回退 = 杀进程重启 bodhi。按修订分期暂缓。

---

## 9. 组件地基重构(进行中,2026-06-28 启动)

**背景**:next 地基好(`index.css @theme` token 齐)、骨架弱(只有 button/textarea 2 个原语,App.tsx 1098 行巨石,106 处内联 className)。不补会从"antd 改不动"变成"内联 Tailwind 散落、改 10 处"的新泥潭。**采用 radix headless**(只给行为/a11y,样式 100% 归我们,不是 antd 锁死)。

**审计产出的关键数字(去重证据)**:手搓 dropdown ×4、modal/dialog ×8、anchored popover ×2、bottom-sheet⇄rail ×2、toast ×2、native select ×5、card 区块 ~24、input 类字面量 12 文件、switch 临时实现 ×3。

**已完成(Phase 0-1 + Phase 2 大部)**:
- 装 radix 无头依赖 9 个(dropdown-menu/dialog/popover/select/tabs/switch/tooltip/scroll-area/label)。
- 建 17 个原语(`src/components/ui/`):展示型 `card · input · label · badge(warning/success)· separator · skeleton`;radix 交互 `dropdown-menu · dialog · sheet · popover · select · tabs · switch · tooltip`;**`responsive-dialog`**(移动底部 sheet ⇄ 桌面居中卡片,收口 ~8 处手搓 overlay 的 `md:items-center`+`rounded-t-2xl`+safe-area;`dismissable` 控制必答 modal)。
- **已迁 11 个 leaf**(`tsc -b` 0 + 生产构建 ✓ + lint 仅良性 cva-export):
  - dropdown:`OverflowMenu · ModelPicker · ReasoningPicker · SessionRow ⋯`(全删 click-outside useEffect,白赚焦点/键盘/Esc,API 不变)
  - modal:`Dialogs(Question/Approval,必答不可点外关)· Onboarding · WorkspacePicker · Settings(大尺寸,保留响应式 tab 轨)`→ ResponsiveDialog
  - 表单原语:`Settings/SettingsMasking` native select→Select、`SettingsNotifications/Env/Masking` checkbox/按钮开关→Switch、多处 `const input` 字面量→Input、预览 textarea→Textarea
- diff:11 文件 +337/−357(净更少),含删除 4 个手搓 dropdown + ~6 个手搓 overlay 的重复逻辑。

**有意保留为定制**(radix 收益低、改了易破坏输入流):`CommandPalette · SlashMenu · FileMenu`——输入驱动、自带键盘导航 + Esc + 点外关闭。

**Phase 3 拆 App.tsx 巨石 — 完成(2026-06-28)**:**1098 → 487 行(−56%)**,tsc 0 + build ✓ + lint 仅预存 `no-children-prop`(SubAgents children= API)。抽出:
- `hooks/useStickyScroll.ts`(59 行)—— 滚动锚定 3 ref + ResizeObserver + open-session 重锚 + `pinToBottom()` 整体内聚,正是审计点名的"不能拆散"的 seam。
- `components/app/`:`Sidebar`(自持 search+groups+backdrop)、`ChatHeader`(整合 usage 环/双 picker/bypass/overflow)、`MessageList`(自持 editing + renderItems/spawnItemIdx + 渲染辅助函数)、`Composer`(自持 fileInputRef)、`ContextUsageRing`、`BypassToggle`、`Toasts`、`ImageLightbox`、`DeleteSessionDialog`。App 内联的 delete-confirm 并入 ResponsiveDialog;image-lightbox/toast 抽成组件。
- App 现为纯编排根:持 useChat bundle + 跨切状态(draft/attachments/pickedWorkspace/preview/forking…)+ 协调逻辑(submit/addFiles/toggleBypass/@-file effect),子组件收 props。state 未跨组件乱挪,行为按原样保留(JSX verbatim + prop 替换)。

**Form 原语扫尾 — 完成(2026-06-28)**:全仓**已无** native `<select>` 与 `const input` 字面量。迁移:`SettingsProviders`(类型/推理强度 select→Select、Field input→Input)、`SettingsMcp`(4 input)、`SettingsPermissions`(1 input)、`SettingsSchedules`(2 input + textarea)、`ReferencePane`(会话对比 select→Select)、`PasswordGate`(密码 input→Input,保留 `!text-base` 防 iOS 聚焦缩放)。另:`SubAgents` 的数据 prop `children`(撞 React 保留字)改名 `agents` → 消除 2 个 `no-children-prop` warning。全程 tsc 0 + build ✓ + lint 净减 warning。

**仍 HELD(需用户在场验证,不宜盲做)**:
- **Card 扫尾**:shadcn `Card` 默认 `rounded-xl py-6 gap-6 shadow-sm` 比现有紧凑 `rounded-lg border p-3` 重,盲换改观感 → 等用户能验收时再定(或引入紧凑变体)。
- **prop-drilling 下沉 store/context**:架构性改动、改状态归属,盲做风险高。
- **`@bigduu/lotus-core` 抽取**(决策 2,未动):跨仓重构,且要把 4 个漂移并入 lotus 桌面端(改了用户当下看不到)→ 等用户在场。
- **用户最终自行验证**(dev 跑通流式/滚动/弹层/设置/表单)。
- 响应式(桌面终局):做 `ResponsiveDialog`(桌面居中 Dialog / 移动 bottom-Sheet)收口重复的 `md:items-center`+`rounded-t-2xl` 逻辑;Sidebar 移动抽屉→宽屏可折叠 rail;Inspector→宽屏第三栏(3-pane grid,`ReferencePane` 已是 `md:flex` 桌面专属,多栏 seam 已存在)。

---

## 10. 响应式宽屏布局(进行中,2026-06-28 启动)

**目标**:让 next 从"移动 app"长成"桌面也能用"——这是 next 取代 lotus 桌面端的关键一步。

**已完成(第一批,dev 实测通过)**:
- `useIsWide()`(`min-width:1280px`)加入 `shared/hooks/useMediaQuery.ts`。
- **Inspector 响应式停靠**:加 `docked` prop。宽屏(≥1280)时作为 **in-flow 第三栏**并排(会话|聊天|检查器,**无遮罩**,聊天与检查器同时可见,桌面 IDE 式);窄屏/移动回退为原底部 sheet / 右栏 overlay。App 按 `isWide` 分别渲染 in-flow 版与 overlay 版。
- **桌面侧栏折叠**:Sidebar 加 `collapsed`(`md:hidden`,不影响移动抽屉)+ 头部收起按钮(`PanelLeftClose`,桌面专属);折叠后聊天拓宽,ChatHeader 的汉堡按钮在折叠态于桌面显示(`sidebarCollapsed && md:inline-flex`)用于恢复。`onOpenSidebar` 同时开移动抽屉 + 取消桌面折叠。
- 全程 tsc 0 + build ✓ + lint clean;dev 在 1280 视口实测:3 栏停靠正常、折叠/恢复正常、真实任务清单数据正确渲染。

**第二批 — 可拖拽分栏(完成,2026-06-28,dev 实测拖拽通过)**:
- `hooks/useResizableWidth.ts`(指针拖拽 + localStorage 持久化 + min/max 钳制 + `edge:"left"|"right"`)+ `components/ui/resize-handle.tsx`(1px 分隔条 + 宽命中区 + hover 高亮,`hidden md:block` 桌面专属)。
- 应用到 **Sidebar**(右缘 handle,288↔420;**实测**拖 288→400 生效 + 持久化;坑:`max-w-xs` 卡桌面宽 → 加 `md:max-w-none`)、**docked Inspector**(左缘,280↔640)、**ReferencePane**(左缘,300↔720)。各栏 width 经 props 注入(Inspector/Reference 用 `style={{width}}`,Sidebar 用 `--sidebar-w` CSS 变量保移动抽屉不受影响)。
- 多 pane:**ReferencePane 现为可拖拽的 2-pane 并排**(主聊天可交互 + 参考栏只读对比另一会话)。**完整 N-交互-pane 需 `useChat` per-session 重构**(目前全局单 current-session:streaming 本地缓冲、所有操作打 currentSessionId)—— 高风险核心改动,标为独立后续(不盲做)。

**待办(后续批次)**:
- N-交互-pane:把 `useChat()` 重构成 `useChat(sessionId?)`(per-session streaming/选择/操作)+ store 选择器按 sid。需逐步 dev 验证,单独排期。
- 折叠状态持久化(localStorage)。
- 桌面键鼠细节:hover 动作、快捷键。
- 桌面专属功能补齐(指标仪表盘 / System Prompt 管理 / Workflows)按价值用 shadcn 重做。

---

## 附:体检方法

本结论由 5 路并行只读代码审计交叉得出:lotus 功能清单(general-purpose)、lotus-next 成熟度盘点、service/shared 层 `diff -q`/`wc`/`comm` 实测漂移、过时/死代码 grep 盘点、build/serve/release 架构通读。所有数字均为实测(非估计)。
</content>
</invoke>
