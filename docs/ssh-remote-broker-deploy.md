# RFC v2: Remote Cluster Fabric — operator-managed clusters, progressive context disclosure, parallel/remote dispatch

- **Status:** Draft / for review (no code yet). Supersedes v1 ("SSH-based remote broker deploy").
- **Date:** 2026-06-29
- **Scope:** `bamboo` (backend deploy engine + config + HTTP API + agent tools) and `lotus` (the antd production frontend, NOT lotus-next)

---

## 0. What changed from v1 (read this first)

Two corrections + two locked decisions reshaped the design:

1. **The SSH deploy machinery already exists.** v1 said "build from scratch." Wrong. `bamboo-broker/src/deploy.rs` already has a `Deployer` trait with `LocalProcessDeployer` / `DockerDeployer` / **`SshDeployer`**, surfaced as a **live agent tool** `deploy_agent` (`action=deploy|list|stop`, `env=local|docker|ssh`) + `ask_agent` (`deploy_agent.rs`; guide `builtin_guides.rs:628`). So this feature is an **operator/fleet layer + agent-context layer on top of existing rails**, not a greenfield build.

2. **The vision is bigger than credentials.** The requester wants: *manage/maintain a cluster + **progressively disclose** it into the agent's context + run **parallel / remote tasks** across it.* So v2 is reframed as a **Remote Cluster Fabric** with three layers.

3. **Locked: dispatch = imperative (agent points at named nodes).** The agent calls `cluster list`, picks a node, and dispatches with `deploy_agent`/`ask_agent`. **Consequence: we do NOT need the unfinished `Schedulable`/registry control-plane (P2) for MVP** — that's only for declarative scheduler-placed fan-out.

4. **Locked: disclosure = tool-pull (lean, cache-friendly).** The stable prompt carries only a one-line capability; all node/health/load detail is pulled on demand via a `cluster` tool. **Nothing volatile enters the cache prefix → zero 1h-cache churn.**

5. **Locked: unify local & remote on the broker.** A node has `placement: Local | Ssh`. **Local = a `localhost` node** deployed via `LocalProcessDeployer` (no SSH/upload/tunnel); **remote = the same + {ssh connect, binary upload, reverse tunnel}**. Everything above (worker id, `ask_agent`, `cluster` tool, lifecycle) is identical — `remote = local + 3 steps`. The fast ephemeral `SubAgent`/Task local-subprocess path (Family A) is **kept as-is** (don't add broker latency to quick in-context delegation).

6. **Locked: deploy the full bamboo BINARY, run it as the `broker-agent` ROLE** — NOT a full `bamboo serve` per node. One artifact everywhere; role chosen at launch; capabilities (MCP via proxy, skills) inherited; `nested_spawn` allows remote fan-out; a node is promotable to `serve` later with no re-artifact.

7. **Locked: nodes are TRUSTED self-owned infra → ship creds to nodes.** Provider keys + MCP creds are synced to the node (reuse docker `mount-home` seeding / capability sync); the node calls LLMs directly. **No LLM-call-proxy-home needed for MVP.** Defense-in-depth retained (encrypt-at-rest, agent-invisible, least-priv SSH user, host-key TOFU, token hygiene). A per-node `trust_level` (default `Trusted`) leaves the proxy-home path open for an `Untrusted` node later with no redesign.

---

## 1. Summary

Give the operator (via Lotus) a way to **register and maintain a cluster of remote machines** (SSH credentials, deploy profile), and give the agent the ability to **discover that cluster progressively and dispatch parallel/remote work onto it** — reusing the existing `Deployer`/`deploy_agent`/`ask_agent` push-broker machinery, upgraded for stored credentials, binary upload, and a durable (survive-restart) lifecycle.

Three layers:
- **L1 Operator (Lotus + bamboo config):** a persistent, encrypted registry of **nodes** (machines) grouped into named **clusters**; CRUD + Test/Deploy/Stop/Health from the UI.
- **L2 Agent context:** a one-line capability in the cached prompt prefix + a `cluster` tool (list/describe/status) for tool-pull disclosure; dispatch via `deploy_agent`/`ask_agent` extended to reference managed nodes **by name** (credentials resolved server-side — the agent never sees them).
- **L3 Backend deploy engine:** the existing `Deployer` trait, with a new **russh-based deployer** for stored password/inline-key creds + **SFTP binary upload** (system arm64 → remote x64, so we upload a configured artifact), keeping the existing system-`ssh` path for "use my ssh-config" nodes; the **reverse-tunnel** broker model (a local 127.0.0.1 broker, workers dial home) and a **durable lifecycle** replacing today's kill-on-drop.

**Hard constraint (unchanged):** Lotus is a *plain browser*; it cannot open SSH. All SSH lives in the bamboo backend; Lotus only manages credentials + triggers actions over HTTP.

---

## 2. What already exists (the rails)

There are **two parallel sub-agent families** in bamboo. The unifying core under both: a worker is a separate process speaking a WS protocol, bootstrapped by a `ProvisionSpec` over stdin (`provision.rs:1-70`) — *"physical location is a configurable temperature, not a baked-in property"* (`docs/remote-actor-plan.md`).

### Family A — PULL / discovery (spawn a Task child)
`SubAgent`/Task child → `ActorChildRunner` → `Placement` (`provision.rs:154-168`):
- `Local` + `LocalSubprocessLauncher` — local subprocess (default; pooled if `reusable`).
- `Remote{endpoint}` + `ConnectLauncher` (`launcher.rs:54-127`) — connect to a resident `bamboo actor serve --bind` worker over `wss://`. Config: `subagents.remote_placements`.
- `Schedulable{pool}` + `RegistryFabric` — registry-resolved pool. Config: `subagents.schedulable_placements`. **Client rails wired; the registry/control-plane SERVER is unfinished P2.**

### Family B — PUSH / broker (deploy a persistent peer, then converse) ← **this RFC builds here**
`deploy_agent` + `ask_agent` (live tools, registered only when a broker is configured):
- Central hub `bamboo broker serve` = durable mailbox bus; workers `bamboo broker-agent serve` **dial home**; addressed by mailbox id.
- `Deployer` trait (`deploy.rs`): `LocalProcessDeployer`, `DockerDeployer`, **`SshDeployer`**.
  - `SshDeployer` (`deploy.rs:271-347`): shells out to system `ssh -tt -o StrictHostKeyChecking=accept-new`, **reverse-tunnels `-R port:127.0.0.1:port`** so the worker reaches a 127.0.0.1-bound broker with **no inbound port on the remote**, token via `BAMBOO_BROKER_TOKEN=` env, **assumes `bamboo` pre-installed**, **kill-on-drop** (dies with the orchestrator).
  - Deployed workers inherit the orchestrator's MCP (via `mcp_proxy → ORCHESTRATOR_ID`) + skills.

**What the fabric adds on top of Family B:** persistent named nodes/clusters + encrypted stored creds + a UI (operator, not AI, drives it) + binary upload (close the pre-installed gap) + durable lifecycle (survive restart) + progressive disclosure into the agent.

---

## 3. Data model: nodes & clusters

A **node** = one remote machine (SSH creds + deploy profile + live state). A **cluster** = a named set of node ids. Imperative dispatch means the agent addresses **nodes by name**; clusters are just the grouping/disclosure unit.

```rust
// bamboo-config: additive, back-compat (absent ⇒ empty)
pub struct ClusterFabricConfig {
    pub clusters: Vec<Cluster>,           // named groups
    pub nodes: Vec<Node>,                 // the machines
}
pub struct Cluster { pub name: String, pub description: Option<String>, pub node_ids: Vec<String> }

pub struct Node {
    pub id: String,                       // uuid
    pub label: String,                    // "gpu-1"
    pub placement: NodePlacement,         // Local (localhost) | Ssh (remote) — the ONLY local/remote difference
    pub trust_level: TrustLevel,          // Trusted (default) | Untrusted — see §7
    pub deploy: DeployProfile,            // what to launch + artifact
    pub state: Option<NodeState>,         // engine-owned: status/endpoint/pid/health
    pub enabled: bool,
}
pub enum NodePlacement {
    Local,                                // localhost → LocalProcessDeployer; no ssh/upload/tunnel
    Ssh(SshTarget),                       // remote → russh/system-ssh deployer + upload + reverse tunnel
}
pub enum TrustLevel { Trusted, Untrusted }  // default Trusted (own infra: ship creds); Untrusted ⇒ proxy home (future)
pub struct SshTarget {
    pub host: String, pub port: u16, pub username: String,
    pub auth: SshAuth,                    // see §7 (encrypted at rest)
    pub host_key_fingerprint: Option<String>,  // TOFU pin
}
pub enum SshAuth {                        // secrets encrypted like env-vars (§7)
    SystemSshConfig,                      // use the host's ssh agent/config (→ system-ssh deployer)
    Password { password, password_encrypted },
    PrivateKey { private_key | private_key_path, passphrase, *_encrypted },
}
pub struct DeployProfile {
    pub artifact_path: String,            // local-on-bamboo-host binary to SFTP-upload (§6)
    pub artifact_sha256: Option<String>,
    pub remote_dir: Option<String>,       // default ~/.bamboo-deploy
    pub default_role: Option<String>,
    pub model: Option<String>,
    pub workspace: Option<String>,
}
pub struct NodeState {
    pub status: NodeStatus,               // NotDeployed|Deploying|Running|Unreachable|Stopped|Failed
    pub worker_id: Option<String>,        // broker mailbox id (the ask_agent target)
    pub token_env: Option<String>,        // encrypted env var holding the broker token
    pub remote_pid: Option<u32>, pub log_path: Option<String>,
    pub deployed_at, pub last_health, pub last_error,
}
```

> The "node has a worker" relationship: deploying a node starts a `broker-agent` on it whose mailbox id (`worker_id`) becomes the `ask_agent` target. A node may be Registered-but-NotDeployed (creds known, no live worker yet).

---

## 4. Layer 1 — Operator / fleet (Lotus + config + HTTP)

Persisted in bamboo `config.json` via `app_state.update_config(...)` (`config_runtime.rs:136-167`: io-lock + atomic write + `.bak` + encrypt-on-save). Secrets follow the env-vars AES-256-GCM pattern exactly (§7).

**HTTP API** (follow the provider-instances CRUD template `provider_instances/mod.rs:320-493`; register in `routes/bamboo_v1.rs:97-216`):
```
GET/POST/PUT/DELETE  /v1/bamboo/settings/nodes[/{id}]         # machine CRUD (redacted secrets)
GET/POST/PUT/DELETE  /v1/bamboo/settings/clusters[/{id}]      # grouping CRUD
POST  /v1/bamboo/settings/nodes/{id}/test                     # CONNECT+PREFLIGHT only
POST  /v1/bamboo/settings/nodes/{id}/deploy                   # run deploy → start worker
POST  /v1/bamboo/settings/nodes/{id}/stop
GET   /v1/bamboo/settings/nodes/{id}/status                   # health re-check + state
GET   /v1/bamboo/settings/nodes/{id}/logs                     # tail remote log
```

**Lotus UI:** a new "Clusters" settings tab (group "Deployment"), following the env-vars/MCP tab conventions (`SystemSettingsEnvVarsTab.tsx`, `settingsViewStore.ts`, `SettingsService.ts`, `api/client.ts`): a table of nodes (label, `user@host:port`, cluster, status `Tag`), Add/Edit modal (SSH creds + deploy profile + cluster membership), per-row **Test/Deploy/Stop/Status/Logs**, masked-secret-aware editing, a Logs drawer with optional poll while `Deploying`/`Running`.

---

## 5. Layer 2 — Agent context: progressive disclosure (tool-pull) + imperative dispatch

The agent's view of the cluster is built as a **ladder**, paying token/cache cost only as it descends:

```
Rung 0  Capability — one tool-guide line in the CACHED prefix (≈free, never busts cache):
        "You have managed clusters. Use `cluster` to inspect nodes and dispatch
         parallel/remote work; drive deployed workers with deploy_agent + ask_agent."
Rung 1  Inventory (tool-pull)   cluster action=list  → compact nodes×clusters + status/health/load
Rung 2  Detail (tool-pull)      cluster action=describe node=<id>  → capabilities (model/tools/workspace)
Rung 2' Liveness (tool-pull)    cluster action=status node=<id>    → on-demand health re-check
Rung 3  Dispatch (reuse)        deploy_agent action=deploy env=cluster node=<id> role=…  → worker id
                                ask_agent id=<worker-id> mode=query|steer …
Rung 4  Observe/manage          cluster action=tasks  / deploy_agent action=list|stop
```

**New `cluster` tool** (read-only inventory/disclosure surface; reads persisted config + a cached health snapshot, NOT a live SSH probe per call): `list` / `describe` / `status` / `tasks`.

**Dispatch reuses Family B**, with one addition: `deploy_agent` gains `env=cluster node=<id>` — it **resolves SSH creds + artifact + broker token server-side from the encrypted store**, so **the agent references nodes by name and never handles credentials**. `ask_agent` is unchanged.

**Parallel tasks = explicit agent fan-out (imperative):** `cluster list` → pick K nodes → `deploy_agent` to each → `ask_agent` each → gather. (A future `cluster action=map`/`broadcast` convenience can wrap the loop; not MVP.)

**Cache invariant (critical):** Rung 0 lives in the stable prefix; **everything volatile (node lists, health, load) is returned by tool calls, never injected into the prompt** → the 1h cache prefix is untouched. If we ever want passive live-state awareness, it must go in the post-conversation volatile slot, never the prefix (see the prompt-cache placement invariant). Default: pure tool-pull.

---

## 6. Layer 3 — Backend deploy engine

Reuse the `Deployer` trait. Pick the implementation by **placement first, then (for Ssh) credential type**:
- **`placement = Local`** → `LocalProcessDeployer` (exists): spawn `bamboo broker-agent serve` locally against the 127.0.0.1 broker. **No SSH, no upload, no tunnel.** This is the unified-model "localhost node".
- **`placement = Ssh`, `auth = SystemSshConfig`** → **`SystemSshDeployer`** = today's `SshDeployer` (system `ssh`, reverse tunnel; agent/disk key). Already works; gains binary upload + durable launch.
- **`placement = Ssh`, `auth = Password|PrivateKey`** → **`RusshDeployer`** (NEW): in-process `russh` connect with the decrypted stored secret + `russh-sftp` upload. Must replicate the **reverse tunnel** (russh remote port-forward / `tcpip-forward`) so the worker dials a 127.0.0.1 broker exactly like the system path.

Both implementations share the same flow:
1. **Connect** (creds) + **host-key TOFU** (pin fingerprint; reject a changed key).
2. **Preflight** `uname -s -m`; validate artifact arch (advisory + force).
3. **Upload binary (SFTP)** to `~/.bamboo-deploy/bamboo-<sha8>`, **skip if the remote hash already matches** (idempotent redeploys); `chmod +x`; atomic rename. *(Closes the "assumes pre-installed" gap.)*
4. **Token**: generate a per-deploy broker token, store it as an **encrypted env var** (`NODE_<id>_TOKEN`), inject via the remote launch env.
5. **Reverse tunnel + launch**: `broker-agent serve --broker ws://127.0.0.1:<port> --token … --id <worker-id>` over the tunnel, **detached** (`setsid nohup … &`, capture PID) so it **survives the SSH session AND a bamboo restart** — replacing today's kill-on-drop. (systemd-run is the hardening upgrade.)
6. **Capture** `worker_id` + **Health** (broker mailbox ping) + **Persist** `NodeState`.

**Broker hub location is settled:** the orchestrator runs a local `bamboo broker serve --bind 127.0.0.1:9600`; every SSH node reverse-tunnels home. No reachable central broker, no inbound port on remotes. (Resolves v1 §19 Q2.)

**Durable lifecycle / reconcile:** node + state persist in `config.json`; the remote worker is independent and survives a bamboo restart; on startup/first poll we **health-reconcile** (re-ping, flip `Running`→`Unreachable` if gone) rather than redeploy. `stop` = `kill <pid>`/`pkill -f <worker-id>` over SSH.

---

## 7. Security

- **Creds at rest:** SSH passwords/keys/passphrases + broker tokens AES-256-GCM encrypted (existing `encryption.rs:381-417`); plaintext cleared before disk (`sanitize_*`), decrypted on load (`hydrate_*`), masked + `*_encrypted` stripped in API responses (`redact_config_for_api`). Mirror env-vars exactly (`config_crypto.rs:345-386`).
- **Agent never sees creds:** the agent dispatches by `node=<id>`; the backend resolves secrets. Creds never enter the prompt, tool args, or tool results.
- **Secret posture = ship-to-trusted-nodes (locked).** Nodes are own infra → provider keys + MCP creds are synced to the node (docker `mount-home` seeding / capability sync) and it calls LLMs directly. Caveat to record: this also copies the orchestrator's `.bamboo_encryption_key` to the node (so it can decrypt the synced config) — acceptable for trusted infra, but it means a node compromise exposes whatever creds were synced. Mitigate by syncing only the creds a node needs, least-priv SSH user, and per-node `trust_level`. **`Untrusted` nodes (future) flip to proxy-home:** point the worker's provider `base_url` at the orchestrator's LLM gateway (`/v1/chat`, `/anthropic`, `/gemini`) over the tunnel with a scoped token, and MCP via `mcp_proxy` — so no secret leaves home.
- **Host-key TOFU:** pin on first connect, reject a changed key (MITM) unless re-pinned. (System path already uses `StrictHostKeyChecking=accept-new`; russh path uses a host-key callback.)
- **This is authenticated RCE:** the deploy endpoints execute remote commands. They must sit behind the same access control as the rest of bamboo settings (and device-token auth on the v2 transport). Shell-quote all remote command construction. Audit (no secrets) every deploy/stop/test.
- **Wart to fix:** `BrokerClientConfig.token` is stored in the clear (`config.rs:400-401`); move it to encrypted/`token_env`.

---

## 8. Crate / module layout

```
bamboo-config/                 + ClusterFabricConfig (clusters/nodes) + crypto methods
bamboo-broker/src/deploy.rs    + RusshDeployer (russh, russh-sftp); SshDeployer → SystemSshDeployer;
                                 add upload + reverse-tunnel-in-russh + detached/durable launch
bamboo-server-tools/           deploy_agent gains env=cluster node=<id> (server-side cred resolve);
                                 NEW cluster tool (list/describe/status/tasks)
bamboo-server/                 handlers/settings/{nodes,clusters}/* + routes; redaction
lotus/                         "Clusters" settings tab + SettingsService methods + types
```
New deps: `russh`, `russh-sftp` (rcgen only if we later add the `actor serve --tls` resident path). Keep the deployer crate off `agent-core`.

---

## 9. Phasing

- **P0 — this doc.** ✅ for review.
- **P1 — Operator foundation (deploy stubbed).** `ClusterFabricConfig` + encryption; nodes/clusters CRUD endpoints; Lotus "Clusters" tab. Verifiable: register a node, creds persist encrypted + round-trip redacted.
- **P2 — Deploy engine.** `RusshDeployer` (connect/host-key + SFTP upload + reverse tunnel + detached launch) and binary-upload for the system path; wire **Test** then **Deploy/Stop/Status/Logs** end-to-end. Acceptance: deploy a worker to a real node from the UI; it dials home; a real sub-agent answers via `ask_agent`.
- **P3 — Agent context.** Rung-0 capability line; `cluster` tool (list/describe/status); `deploy_agent env=cluster node=<id>` server-side cred resolution. Acceptance: an agent runs `cluster list` → deploys to a node → asks it, with no creds in context.
- **P4 — Parallel/observe + hardening.** `cluster tasks`; optional `map`/`broadcast`; startup health-reconcile; systemd-run lifecycle; host-key re-pin UX; `BrokerClientConfig` token encryption; audit logging.
- **(Deferred) Declarative scheduling.** Finish the `Schedulable`/registry control-plane only if/when scheduler-placed fan-out is wanted.

---

## 10. Open decisions

1. **Resolved:** dispatch = imperative (agent-placed, by node name). Disclosure = tool-pull. ⇒ registry control-plane deferred; broker stays local + reverse-tunnel.
2. **`cluster` as a new tool vs. folding into `deploy_agent`?** Recommend a distinct `cluster` (read/disclosure) tool + `deploy_agent env=cluster` (dispatch); keeps inventory and lifecycle verbs separate.
3. **russh reverse-tunnel effort:** replicating `ssh -R` in russh (remote port-forward) is the main new implementation risk — confirm we keep the reverse-tunnel model (vs. requiring a reachable broker) for stored-cred nodes. Recommend keep (NAT-friendly, matches system path).
4. **Auth methods for P1:** password + private-key (path & inline) + SystemSshConfig — confirm MVP set; jump-host later.
5. **Cross-arch artifact:** per-node `artifact_path` (you supply the right-arch binary). Add a `(os,arch)` artifact map + `uname` auto-select later.

## Appendix — source references
| Concept | Path |
|---|---|
| Deployer + Ssh/Docker/Local (the rails) | `bamboo/crates/app/bamboo-broker/src/deploy.rs` |
| deploy_agent / ask_agent live tools | `bamboo/crates/app/bamboo-server-tools/src/deploy_agent.rs`; guide `crates/engine/bamboo-tools/src/guide/builtin_guides.rs:628` |
| ProvisionSpec (unifying bootstrap) | `crates/infra/bamboo-subagent/src/provision.rs:1-168` |
| ConnectLauncher / Placement (Family A) | `crates/infra/bamboo-subagent/src/launcher.rs:54-127`; `provision.rs:154-168` |
| SubagentsConfig / remote_placements | `crates/infra/bamboo-config/src/config.rs:284-402` |
| Secret crypto (mirror this) | `crates/infra/bamboo-config/src/config_crypto.rs:345-386`, `encryption.rs:381-417` |
| update_config + io_lock | `crates/app/bamboo-server/src/app_state/config_runtime.rs:136-167` |
| Settings routes / CRUD template | `crates/app/bamboo-server/src/routes/bamboo_v1.rs:97-216`; `handlers/settings/provider_instances/mod.rs:320-493` |
| Design docs | `bamboo/docs/remote-actor-plan.md`, `remote-mailbox-broker-design.md`, `ask-agent-design.md` |
| Lotus settings pattern | `lotus/src/pages/SettingsPage/components/SystemSettingsPage/SystemSettingsEnvVarsTab.tsx`, `shared/store/settingsViewStore.ts`, `services/config/SettingsService.ts` |
