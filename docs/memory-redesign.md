# RFC: bamboo-memory 记忆系统重设计

- 状态:Draft（L0 已落地）
- 日期:2026-07-06
- 范围:`bamboo-memory` crate + engine 的 `auto_dream` / `gardener`
- 关联:PR #241（L0，已开）· issue #240 · [[memory-hitrate-root-cause]]

## 摘要

现状的核心矛盾不是「库太大需要合并」,而是三件事:**召回弱**(纯词法、且中文被整段丢弃)、**合并有损且过度**(写入即 blob 追加 + dream 叙事重写)、**无界且默认不整理**(记忆永不删除,三个整理器默认全关)。

因此重设计的主线是:**别让重复进来(写入去重) + 搜得准(检索质量) + 到量把冷记忆挪出索引(归档,而非揉合并)**。合并只用于「去真重复」,保守且可逆;容量靠「移出索引」封顶,永不删除。整个方案对现有 `memory/v1/` 纯文件存储**加法式兼容**,且 **embedding 可选**(没有 embedding 模型也能拿到大部分收益)。

---

## 1. 现状(对照代码核实)

### 1.1 存储 / 文档模型
- 纯**文件存储**(无 sqlite):每条记忆 = 一个 markdown 文件 + YAML frontmatter,原子写到 `memory/v1/scopes/{global|projects/<key>}/topics/<id>.md`。id = `mem_<ts>_<hash>`。
- frontmatter:`type`(user|feedback|project|reference)、`scope`、`status`、`granularity`、`relations{supersedes/contradicted_by/related}`、`retrieval{keywords,entities,embedding_ready}`。
- **scope = Session | Project | Global**(没有 user/tenant scope;`user` 只是 type)。
- body **硬上限 4000 字符**;多事实用 `\n\n---\n\n` 分段。
- 每次写入触发 `refresh_scope_artifacts`,原子批量重建全部派生索引:`lexical.json`(每文档 keywords/entities/tags/summary)、`recent.json`、`graph.json`、`stale_candidates.json`、`taxonomy.json` + `MEMORY.md/RECENT.md/STALE.md` 视图。

### 1.2 召回(recall.rs `select_relevant_memories`)
- 读 `lexical.json`,**100% 词法**打分:每 query token 命中 title 3.0 / keyword 2.5 / tag 2.0 / entity 1.5 / summary 1.0 求和;只有 Active/Stale 参与(Stale 降权),Superseded/Contradicted/Archived 过滤。
- project scope 优先,global 兜底。若配了 rerank 模型且候选 >1,做一次可选 LLM rerank(空 `{ids:[]}` 尊重,解析失败→词法兜底)。
- **`embedding_ready` 立了 flag,但没有任何向量路径接线。**

### 1.3 合并 / 整理(四套机制,均确定性;LLM 只提供决策/合并稿)
1. **写入即合并** `write_memory(allow_merge_if_similar=true)`:同 scope+同 type+Active 里 `find_similar_memory`(词/实体/标题启发式,**分数≥4**)→ 把新内容 `---` **追加**进旧文档(投影 >4000 字则改为另建新记忆)。纯词法,**过度合并根源**。
2. **`merge_memory`**(agent 工具,手动):追加一段到目标、并 union tags、源标 Superseded;投影 >4000 字**报错**。
3. **`consolidate_memories`**(真正 N→1):≥2 源 + LLM 合并稿 → 新 canonical(`supersedes` 全部源),源翻 Superseded(留血缘、不召回)。由 dedup gardener + agent 动作调用。
4. **`split_memory`**(逆操作):把 blob 拆成 ≥2 原子,各自 supersede 源。

### 1.4 auto-dream(engine/auto_dream.rs)
- **纯时间 ticker**,`auto_dream_interval_secs` 默认 **1800s(30min)**,**默认关**。全局 scope;项目 scope 仅手动 HTTP 触发。**无会话结束触发、无计数触发**。
- 每轮对最近 ≤12 个 root 会话做两件事:①**SUMMARIZE** 一次 LLM 生成滚动「Dream Notebook」叙事**视图**(5 固定段;模式 Rebuild(每30天)/Refine/Incremental);②**EXTRACT** 第二次 LLM 抽取 ≤8 条原子候选,各自 `write_memory(allow_merge_if_similar=FALSE)` 写成**新**记忆。
- 即 dream = 抽新 + 重生成摘要视图,**不合并**已有记忆;去重全甩给 gardener。空闲(无候选会话/无 background 模型)时零 LLM。

### 1.5 gardener(engine/gardener.rs)
- **每天 ticker(86400s),默认关**。零 LLM 确定性预筛 → 工作表 → 每项一次 background LLM。
- **BLOB 段**:doc 有 ≥5 个 `---` 段 **或** body >4000 字 → split(≤8/run)。
- **DEDUP 段**:Active 文档按 **keyword-Jaccard ≥0.6** 贪心聚簇(簇 ≤5 成员)→ LLM 判 same_fact → consolidate(≤8/run)。

### 1.6 触发汇总 + 「到量合并?」的确定答案

> **没有任何按库容量/条数触发的合并。** 触发全是**时间**(后台 ticker),门槛全是**逐文档 size/相似度**,且三个整理器**默认全关** → 所以库只增不减(499 条堆积)。

| | 触发 | 默认 |
|---|---|---|
| auto-dream | 每 1800s(30min)+ 每 30 天强制 Rebuild | **关** |
| gardener(blob+dedup) | 每 86400s(24h) | **关** |
| 写入即合并 | 每次写入,`find_similar` 分数≥4,投影>4000 则改建新 | — |
| BLOB split 门槛 | 单文档 ≥5 段 **或** >4000 字 | — |
| DEDUP merge 门槛 | 一对 keyword-Jaccard ≥0.6 | — |

唯一「计数样」的数字是:单文档段数 5、逐对相似度 0.6、body 4000 字上限 —— 都是**逐条质量/尺寸门槛**,不是库容量。

---

## 2. 痛点(排序)

1. **中文召回坏了**:query 分词器 `extract_keywords` 用 `is_ascii_alphanumeric`,中文字符全被当分隔符 → 中文 query 零 token → **一条也召不回**。(库是中英混排。)→ 已由 **L0** 修。
2. **词法检索弱**(真瓶颈,不是库大):纯 token 求和,无 IDF/长度归一;dedup 用 keyword-Jaccard;`find_similar` 用启发式。语义/换句话搜不到。
3. **refine 过度合并**(recall 病根):dream Refine 每轮**重写整篇叙事**,把跨会话不同事实糊平。见 [[memory-hitrate-root-cause]]。
4. **无界 / 无淘汰**:记忆永不删除(只翻状态,永久留血缘);`purge` 手动且只软翻状态。dream 每轮还 `allow_merge=false` 造 ≤8 条新记忆 → 单调增长。
5. **默认全关**:gardener/dedup/auto_dream 默认 false → stock 部署零自动整理。
6. **cadence 错配 / churn**:dream(30min)造记忆无去重 → 写入即合并累积 `---` 段 → gardener(每天)再来 split + dedup;三个子系统不同节奏、互为反向力,dedup 滞后写入最多一天。
7. **写入即过度合并**:`allow_merge=true` 分数≥4 把「词法相近但不同」的事实塞进一个标题 + 长出 blob。
8. **贪心 dedup 过度聚簇**:Jaccard 预筛把「相近但不同」聚一起;贪心 + 5 成员上限使大模糊簇每天只部分合并;对错合的把关全靠 LLM 的 same_fact 否决一个可能过宽的簇。
9. **blob 检测只看结构**:只数 `---` 段/字数 → 单段但混主题(<4000 字)漏切;长但原子的被误切浪费一次 LLM。
10. **并发**:同 id 的 read-before-lock 会丢一个并发更新(store.rs:128)。

---

## 3. 设计原则

1. **写入去重,而不是造完再清**(消 churn)。
2. **检索偏召回、合并偏精确**:多召一条便宜;合错一条难撤且对 recall 隐藏源。
3. **靠「移出索引」封顶容量,不靠揉合并**;**永不删除**,supersede/archive = 可逆血缘。
4. **触发 = 事件 + 到量,而不只是时间**;全部 enqueue-only / 异步(照抄 bash-completion 事件驱动先例),写路径不阻塞。
5. **embedding 可选**:没模型就退化到 BM25 + LLM rerank;有本地/hosted 再加 cosine 加分项。
6. **保 #61 缓存前缀**:向量只做**加分项**,不重排稳定前缀;等分 tiebreak 仍粗粒度优先。

---

## 4. 分层方案(L0–L5)

### L0 —— CJK 分词 + BM25(F)【已落地,PR #241】
- 病根:`extract_keywords` 的 `is_ascii_alphanumeric` 丢掉所有中文。
- 新 `lexical_bm25` 模块(**纯读路径**,零 reindex / 零 write 改动 / embedding-free):
  - **CJK-aware 分词**:拉丁/数字段 → 一个小写 token;每段中文 → 相邻字符 **bigram**(单字→unigram)。doc 字段与 query 同法分词。
  - **BM25(F)**:每 scope 算一次 df/avgdl,每文档 O(query 词) 打分;字段权重折进词频,补 IDF + 长度归一。Stale 降权;非活跃过滤。
- 保留:Active-only、project→global、#61 tiebreak、可选 rerank。107 tests 绿。

### L1 —— 检索质量:三档 backend(embedding 可选)
统一 hybrid 分数 `α·BM25 + β·cosine`(β=0 当无向量;词法项永远在,保 tiebreak):
- **档0**:BM25 + CJK(= L0,已做)+ 保留 LLM shortlist rerank。**零新模型。**
- **档1**:进程内**本地 ONNX 小 embedder**(`fastembed`/`model2vec`,多语 bge-m3/e5,~384 维,CPU 几 ms/条,离线、provider 无关,模型文件几十 MB)。写入异步 embed → `indexes/vectors` sidecar。**不需要 embedding API。**
- **档2**(optional):某已配 provider 的 embedding 端点(OpenAI text-embedding-3-small / 智谱 GLM embedding),`memory.embedding_provider` 开关,缺省降级。
- 同一份向量顺手把 dedup 的 `Jaccard≥0.6` 换成 `cosine≥阈值`。

### L2 —— 写入即语义 upsert(消 churn 的核心)
退役脆弱的「分数≥4 追加」;dream 抽取与 agent 写入走**同一条幂等 upsert**:
- `sim≥高` 且 LLM `same_fact` → **supersede-consolidate**(新 canonical + 源留血缘);
- `sim 中段` → 只建 `relations.related` 链接;
- 否则 → **新原子记忆**。
重复**进不来**,而非「今天造、明天清」。(`sim` = 档0 BM25 或档1 cosine。)

### L3 —— 合并 = 保质,保守且可逆
- 门槛:**同时**要相似度高 + LLM `same_fact` + 实体一致;LLM 返回**逐源 keep/fold**,非整簇一刀切。
- 永远保留源为 Superseded + `supersedes` 血缘 → 合错可 `split` 回滚。
- **弃用 dream Refine 叙事重写做默认**:durable 层是 source of truth,Notebook 只当派生视图 → 召回永不依赖被重写的叙事。(直接消痛点 #3。)

### L4 —— 触发:事件 + 到量(即「到量做点事」,但不是强制 merge)
- **会话结束** → debounce 入队抽取(别等 30min)。
- **到量触发**:某 scope `net-new-since-last-maintenance > M`(用 `last_reindex.json` 已有计数比对 `config.new_dedup_after_writes`)→ 入队一次**维护 pass**。
- **关键**:到量触发的是 **dedup + 归档 pass,不是强制合并** —— 满足「到量整理」且不过度合并。
- 全部 enqueue-only / 异步。三个整理器**改默认开**(安全:零 LLM 预筛让空闲免费;成本随实际累积量而非定时空转)。

### L5 —— 容量 / 淘汰(现在缺的那道界)
- 按访问年龄自动翻 Stale(`last_accessed_at` 超 K 天 + 低置信)。
- scope 超硬上限时,按**价值**(recency × access_count × confidence)把最低价值 Active **归档出索引**(留盘做血缘,退出 lexical/vector index)→ 热路径索引与召回规模**有界**。
- 冷数据搬 `scopes/.../archive/`。**永不删除**;pinned/`reference` 豁免;归档可逆。**靠移出索引封顶,不靠合并。**

### L6(次要)
- blob 检测加「主题内聚」信号(段间 embedding 方差),避免漏切/误切。
- 修 store.rs:128 read-before-lock 并发丢更新。

---

## 5. 专题:「我们没有 embedding 模型怎么办?」

**向量不是必需的。** 见 L1 三档:
- **档0(已做)**:BM25 + CJK + LLM rerank。够用,因为**写入侧 LLM 已经把 keywords/entities 打进每条记忆** —— 语义 lifting 在写入侧做过,召回只差 BM25。
- **档1**:本地 ONNX embedder,进程内、离线、provider 无关 —— 这是 bamboo 自带的一个本地能力,**不依赖任何 embedding API**,最符合 local-first。
- **档2**:纯 optional。

**合并也不依赖 embedding**:精度闸是**已有的 chat 模型做 `same_fact` 判定**,embedding 只让候选聚簇更准。

**中英混排坑**:不管哪档都要 CJK-aware 分词(档0 已修)/ 多语 embedder(档1),否则中文召回极差。

---

## 6. 专题:「到量就 merge?」

现状**没有**库容量触发的 merge。正确答案不是「按条数强制合并」(那会过度合并),而是 **L4:到量触发一次维护 pass(dedup + 归档)**。合并只用于「去真重复」(L3,保守可逆);容量靠 L5「移出索引」封顶。

---

## 7. 排序 + 权衡

**L0(已发)→ L1 档1 本地向量 → L2 写入去重 → L4 事件/到量触发 + 默认开 → L5 归档封顶 → L3 精化 → L6。**

- **精确 vs 召回**:合并/supersede 难撤且对 recall 隐藏源 → 偏保守(相似度 AND same_fact AND 实体一致);检索偏召回(hybrid)。
- **缓存稳定 vs 相关性**:召回按粗粒度排以稳前缀(#61);向量只做加分项,别重排前缀,否则砸掉团队争来的 1h system-field 缓存。
- **事件/到量触发 vs 写延迟**:触发 enqueue-only/异步,写路径不阻塞。
- **默认开 vs LLM 成本**:安全,因确定性预筛让空闲免费;成本杠杆是把定时空转换成事件+到量。
- **淘汰 vs 血缘**:永不删除;归档出索引在封顶热路径的同时保血缘;价值评分可能丢罕见但关键的事实 → 豁免 pinned/reference/高置信,归档可逆。

---

## 8. 迁移 / 兼容

全部对 `memory/v1/` 纯文件存储**加法式**:向量走 sidecar,新 frontmatter 字段走 `embedding_ready` 不破格式;既有 **supersede-not-delete** 使错合可 `split` 回滚。L0 已是纯读路径、无迁移。

---

## 附录:核实到的关键常量 / 符号

- `MAX_DURABLE_MEMORY_BODY_CHARS = 4000`
- 写入即合并相似度门槛 = 4;`gardener_min_sections = 5`;`dedup_gardener_min_score = 0.6`(keyword-Jaccard)
- `gardener_max_splits_per_run = 8`;`dedup_gardener_max_merges_per_run = 8`;`DREAM_MAX_SESSIONS = 12`;`EXTRACTION_MAX_CANDIDATES = 8`
- `auto_dream_interval_secs = 1800`(默认关);gardener 每 86400s(默认关);`DREAM_FULL_REBUILD_INTERVAL_SECS`(30 天)
- 召回词法权重:title 3.0 / keyword 2.5 / tag 2.0 / entity 1.5 / summary 1.0(L0 折成 BM25 字段权重)
- 关键文件:`memory_store/{store.rs,recall.rs,lexical_bm25.rs,mod.rs}`、`engine/{auto_dream.rs,gardener.rs}`、`budget/mod.rs`
