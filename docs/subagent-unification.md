# RFC: Sub-Agent Unification — Actor + Mailbox over WebSocket (Tier 3)

- **Status:** Draft / for review (no code yet).
- **Date:** 2026-06-30
- **Scope:** `bamboo` — `bamboo-subagent`, `bamboo-broker`, `bamboo-engine` (actor runner), `bamboo-server-tools`, `bamboo-server`, `bamboo-config`.
- **Prereq:** the drift audit + cleanup landed (`refactor(subagent): remove drift` — deleted dead `WorkerLauncher`/Tier-2 `Registry`, namespaced the shared registry, fixed false docs).

---

## 0. The decision (locked)

**There is ONE model: every sub-agent is an actor with a mailbox, and ALL cross-process communication is mailbox messages over the existing WebSocket transport** (`ws://` loopback for local, `wss://` TLS for remote). No new wire — reuse what the broker / v2 transport already ships.

No exceptions, no second path:
- The current **direct-WS + file-discovery** local-actor path is **removed** — local children also become mailbox actors, dialing the (in-process) bus over **`ws://` loopback**.
- The **broker push** path stays as the *general* case — remote actors reach the mailbox bus over **`wss://`** (TLS), dialing home (NAT-friendly, no inbound port; reverse-tunneled for the cluster-fabric case).
- The resident `actor serve` / `Placement::Remote` / `Schedulable` variants all collapse into "an actor connected to the bus."

The only thing that varies is **TLS or not** on the same WebSocket transport: plain `ws://` for same-host loopback (no cert/TLS overhead), `wss://` for remote. No separate transport implementation.

Everything else — addressing (mailbox id), bootstrap (`ProvisionSpec`), the live-worker "registry" (the bus's mailbox table), the handle, the lifecycle — is **one** of each.

### Why this is the single path (and direct-only isn't)

A NAT'd / firewalled worker (docker, cloud, SSH remote) cannot accept an inbound connection, so a *direct-connect* model can't be universal without per-host tunnels. The mailbox-bus model is universal because **everyone dials in** — the bus is the rendezvous. Making it the *only* model (local included) is what collapses the two families into one.

---

## 1. What this collapses (vs the audited drift)

| Audited drift | Under actor+mailbox-over-TCP/WSS |
|---|---|
| Two families (PULL direct vs PUSH broker), no shared type | **One**: every actor dials the bus; the runner only ever talks to a mailbox |
| `ProvisionSpec` vs `AgentDeployment` (two bootstraps) | **One**: `ProvisionSpec`, shipped over the launch channel; `AgentDeployment` becomes a derived view |
| `SpawnedChild` vs `DeployedAgent` (two handles) | **One**: `ActorHandle` (mailbox id + launch-kill + transport) |
| 3+ live-worker registries (DeployedRegistry / FileFabric / RegistryFabric / AgentRegistry) | **One**: the bus's mailbox/subscriber table is the registry — "ask the bus who's alive" |
| 4 kill / lifecycle semantics | **One**: lease + idle-timeout + explicit-stop, on the bus |
| inline `PlacementKind` dispatch + dead `WorkerLauncher` | **One** `ActorLauncher` seam: how the actor is *brought up* (local spawn / ssh-deploy / connect-resident), all returning "an actor on the bus" |
| 5 model rules / 2 MCP mechanisms | **One** resolver each (Phase 0, unchanged from prior plan) |
| local actors lack durability/survive-restart | **Free**: the bus mailbox is durable (or tiered) |

---

## 2. The model

### 2.1 Actor

A sub-agent worker is an **actor process** (`bamboo actor serve`, unifying today's `subagent-worker` + `broker-agent`):
1. reads its `ProvisionSpec` from the launch channel (stdin),
2. **dials the mailbox bus** at `spec.bus.endpoint` (TCP or WSS) presenting `spec.bus.token`,
3. registers its **mailbox id** (`spec.identity.child_id`),
4. serves `Run` / `Steer` / `Cancel` frames from its mailbox, posting `Result` / events back to the **parent's** mailbox.

The actor never listens for inbound connections — it only dials out. (Removes the resident-`actor serve`-listens variant; a "resident" actor is just one that dials the bus and stays connected, reused by fingerprint.)

### 2.2 Mailbox bus (generalized broker)

- Hosts per-actor mailboxes; **tiered durability** — in-memory for local/ephemeral (fast), disk-maildir for durable/deployed (survive-restart, at-least-once).
- Listens on **both** a **TCP** endpoint (loopback, for local actors) and a **WSS** endpoint (TLS, for remote actors). Transport is per-connection; the mailbox protocol is identical over either.
- **Embeddable in the server process** — `bamboo serve` starts an in-process bus by default (no mandatory separate `bamboo broker serve`); the standalone broker remains for multi-host / shared-bus topologies.
- Its connection + lease table **is** the registry: who's connected, role/labels, lease, idle-since.

### 2.3 Transport (WebSocket, ws:// or wss://)

```
local actor   --ws:// loopback-->  [ mailbox bus (in server) ]  <--wss:// TLS--  remote actor
                                            ^
                                       parent runner
```
- One transport: the existing WebSocket mailbox protocol (broker / v2 transport, bearer token at upgrade).
- **`ws://`** for same-host loopback (no TLS handshake/cert).
- **`wss://`** for remote actors (TLS, direct or reverse-tunneled).
- The only difference is whether TLS wraps the socket; the framing, auth, and handlers are identical. Selection is a property of the actor's bus endpoint in the spec, not a code branch in the runner. **No new transport implementation is added.**

### 2.4 Bootstrap — one `ProvisionSpec`, parent decides

The parent resolves the full spec (model via the single resolver, scoped least-privilege creds, capabilities, MCP decision, **and the bus endpoint + token + transport**) and ships it over the launch channel:
- local spawn → stdin,
- ssh/russh deploy → exec stdin,
- (no more worker-side `build_spec` from local `Config` — the actor uses the spec it was handed).

`AgentDeployment` is deleted as a source of truth; where a thin projection is still needed (e.g. argv), it is derived from `ProvisionSpec`.

### 2.5 One handle + one launcher seam

```rust
pub struct ActorHandle {
    pub mailbox_id: String,        // how the parent addresses it (via the bus)
    kill: KillHandle,              // owned local Child / remote exec-kill / no-op resident
}

#[async_trait]
pub trait ActorLauncher: Send + Sync {        // the ONLY place bring-up is dispatched
    async fn launch(&self, spec: &ProvisionSpec, wait: Duration) -> Result<ActorHandle>;
}
```
Impls = how the actor is *started* (it always ends up on the bus):
- `LocalSpawnLauncher` — spawn `bamboo actor serve`, spec over stdin, dials bus over TCP loopback.
- `SshDeployLauncher` / `RusshDeployLauncher` — upload + exec `bamboo actor serve`, spec over exec stdin, dials bus over WSS (reverse-tunneled for the fabric).
- `DockerDeployLauncher` — same, in a container.
- `ConnectLauncher` — for an already-running resident actor: no spawn, just verify it's on the bus.

The runner: `let h = launcher.launch(&spec).await?; bus.send(h.mailbox_id, Run{...}).await`. **One path**, no `PlacementKind` match, no direct-vs-broker branch.

### 2.6 Registry & lifecycle = the bus

- The bus tracks every connected actor (mailbox id → {role, labels, lease, idle_since, transport}).
- "List workers" / "is it alive" / "find an idle actor of role X" all query the bus. **Delete** `DeployedRegistry`, `FileFabric`, `RegistryFabric`, `AgentRegistry` — they become views over the bus table.
- Reclaim: idle actors self-exit after `idle_timeout` and drop off the bus; explicit `stop` sends a shutdown frame (and/or kills the launch handle); a crashed actor's lease expires and the bus reaps its mailbox. **One** policy.
- Warm reuse: idle actors stay connected; the parent (or the bus) hands out an idle one matching the fingerprint (role/provider/model/workspace/tools).

---

## 3. Phasing (each phase shippable + green)

- **Phase 0 — shared resolvers (no transport change).** Extract `resolve_child_model` + `resolve_child_mcp` (+ the `mcp_proxy` XOR `mcp` guard); route all spawn paths through them. Kills the 5-rule / 2-mechanism drift first so later phases are behavior-preserving.
- **Phase 1 — bus in-process + local actors onto the bus (over `ws://` loopback).** Embed the mailbox bus in `bamboo serve` (default-on; standalone broker stays for multi-host); switch the **local** actor path from direct-WS+FileFabric to **dial-the-in-process-bus over `ws://` loopback** — reusing the existing WS transport, no new wire. This is the central move — it removes the direct/file-discovery path. *Acceptance: local sub-agents run via the bus; latency parity for coarse run/steer/result frames; warm-pool reuse intact.*
- **Phase 2 — one bootstrap + one handle + one launcher.** Ship full `ProvisionSpec` to every actor (incl. deployed); delete worker-side `build_spec`-from-local-config; introduce `ActorHandle` + `ActorLauncher`; fold the `Deployer` family in as launchers; delete the inline `PlacementKind` match and `AgentDeployment`-as-source. *Acceptance: deployed actors are parent-resolved (least-privilege); cluster-fabric UX unchanged; deploy_agent/cluster produce `ActorHandle`s.*
- **Phase 3 — bus is the registry.** Replace `DeployedRegistry`/`FileFabric`/`RegistryFabric`/`AgentRegistry` with queries over the bus table; uniform lease+idle+stop lifecycle; generalized boot-reconcile. *Acceptance: list/stop/reuse uniform; no double-bookkeeping; orphan records gone.*
- **Phase 4 — optional security/durability.** Per-actor mailbox tokens (scoped, replacing the shared bus token for least-privilege); approval-delegation over the bus (unblocks uniform `enforce_permissions`); mailbox purge on stop; tiered-durability tuning. *Acceptance: deployed actors can enforce permissions with off-loop review; no orphan mailboxes.*

Phase 0 is pure refactor. Phase 1 is the architectural pivot (validate local latency early). Phases 2–4 land the rest.

---

## 4. Honest tradeoffs (decide with eyes open)

- **T1 — the bus is now in every local sub-agent's hot path.** Today local actors bypass it (direct WS). Mitigations: in-process bus (no extra process), `ws://` loopback (no TLS overhead), an **in-memory mailbox tier** for local (no fsync), and parent↔child frames are *coarse* (run/steer/result — a handful per child run, not per-token). Net latency expected ≈ today's direct-WS; **durability is gained**, not lost.
- **T2 — the bus is a single rendezvous for all sub-agent traffic.** It's designed for it (mailbox-per-session, the v2 multiplexed transport). For extreme fan-out it can shard, or a standalone broker scales it out. Acceptable for the realistic N (tens of children).
- **T3 — bigger migration than "share types".** Phase 1 genuinely retires the direct/file-discovery path rather than abstracting over it. That's the point (one path), but it's the riskiest phase — gate it behind the existing actor e2e suites staying green.
- **T4 — trust model for shipping the full spec to remote actors** (creds on the wire). Aligns with the cluster-fabric "trusted infra → ship creds" decision; untrusted nodes use the proxy-home path. Gate Phase 2 on `trust_level`.

---

## 5b. Implementation plan — mapped from code (2026-06-30)

Status of the pivot: **Phase 1 is DONE** (local children run over the in-process bus; direct-WS + warm pool + first-frame watchdog; steer + approval carried over the bus). **Phase 3's base landed** (`BrokerCore.subscribers` now keeps the `Hello` role and exposes `connected()` / `connected_by_role()` — the bus is the live-actor registry). The rest, mapped to exact sites:

### Phase 0 — shared resolvers (the 5-rule / 2-mechanism drift)
- **Two model families today:** the actor-child path resolves model *parent-side* and ships it (`actor_adapter.rs` `build_spec` ≈ L464: `session.model_ref` → `job.model` + `default_provider`), while the deployed broker-agent resolves *worker-side* from local `Config` (`src/broker_agent.rs` ≈ L97: `--model` → `defaults.sub_agent` → `defaults.chat`). Both sit on the canonical config layer (`model_config_helper.rs::resolve_subagent_model_ref` L485; `config.rs` get_model L1587). Upstream feeders: tool arg + per-type routing (`sub_agent.rs` L678/685), session inherit (`child_session/actions.rs` L32), enqueue (`child_session_adapter.rs` L521).
- **Do:** one `resolve_child_model(config, requested, default_provider) -> ModelRefSpec` in `model_config_helper`; route both `build_spec` sites through it. NOTE: unifying the deployed fallback onto the canonical chain is a *behavior change* to that path — gate on tests.
- **MCP:** the decision exists only at `broker_agent.rs` L117-130 (`mcp_proxy` XOR portable `mcp`); the actor path sets nothing (builtin-only). XOR guard already in `provision.rs::validate` L299. `resolve_child_mcp` extracts L117-130; granting actor children MCP is a *deliberate* later flip, not silent.

### Phase 2 — one handle + one launcher (the riskiest)
- **Two handles:** `SpawnedChild` (`fleet.rs:31`, owned `Child` | remote) vs `DeployedAgent` (`deploy.rs:78`, `Process{child,cleanup}` | `Remote(dyn RemoteDeployment)`). Merge → `ActorHandle{ mailbox_id, kill }` (both already encode local-process-vs-process-less internally).
- **Two launchers → one `ActorLauncher` seam:** fold the `Deployer` family (`deploy.rs` Local/Docker/Ssh + `deploy_russh.rs` Russh) AND the runner's `PlacementKind` arms (`actor_adapter.rs` Local=bus-spawn / Remote=connect-wss / Schedulable=registry-resolve) into launcher impls — all return "an actor on the bus."
- **The one real divergence:** deployed workers self-resolve from local `Config::new()` (`broker_agent.rs::build_spec` L66); local workers get a parent-built `ProvisionSpec` over stdin. Phase 2 ships the full `ProvisionSpec` to deployed actors too (deleting worker-side `build_spec`), so `AgentDeployment` (`deploy.rs:20`, argv+env) becomes a derived argv view, not a source of truth. **Gate on `trust_level`** (creds on the wire — T4) and keep cluster-fabric UX identical.

### Phase 3 — bus is the registry (cutover + deletions)
- **Done:** role capture + `connected_by_role` (`core.rs`).
- **Cutover:** `resolve_schedulable_worker` (`actor_adapter.rs:637`, the only live registry *read*) → query the bus (`connected_by_role(pool)`) instead of `RegistryFabric.discover` + lease + 3-try failover. Requires schedulable workers to share the queried bus (depends on Phase 2's "everyone dials the bus"). For a *remote* bus add a `ClientFrame::ListConnected{role}` frame.
- **Delete:** `FileFabric`/`Fabric` (`discovery.rs`) is already off every production path post-Phase-1 — drop the vestigial `fabric_dir` from `ProvisionSpec` + the test-only `spawn_worker` rendezvous; retire `RegistryFabric` + server `AgentRegistry` (`agents.rs`) after the cutover. KEEP `DeployedRegistry`'s kill-ownership (the bus knows connection, not which OS handle this process must reap) — source only its *list/liveness* from the bus.

### Phase 4 — security/durability
- **Done:** approval-delegation over the bus (steer + approval landed in Phase 1's tail).
- **Per-actor mailbox tokens:** replace the single shared bus token with scoped per-actor tokens (least-privilege) — touches the `Hello` auth (`server.rs:64`) + `spec.bus.token`. Mailbox purge on stop; tiered in-memory vs maildir durability tuning.

Sequencing: 0 → 2 → 3-cutover → 4. Each is shippable behind the actor e2e suites; 2 is the pivot (ship full spec to deployed) that 3-cutover depends on.

---

## 5. Out of scope

- The schedule pipeline being a root in-process run that drops Guardian — a separate schedule-RFC.
- The cluster-fabric operator API/UI — unchanged.
- Multi-tenant / multi-bus federation — future.
