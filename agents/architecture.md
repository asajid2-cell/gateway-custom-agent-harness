# Architecture

Where the Gateway parts live and how they fit. For how each one works, read
`internals.md`.

## The shape of the program

Gateway is a terminal REPL. One process owns the terminal, the conversation and
the turn loop:

```
entrypoint -> app shell -> message loop -> model call -> tool calls -> render
                                |                              |
                          session storage                  permissions
```

Upstream supplies that skeleton. The fork replaces four things inside it:

1. **Which model a turn goes to.** A local HTTP gateway (`scripts/model-gateway.mjs`)
   fronts every provider; the harness speaks one protocol to it.
2. **Who a session is.** Sessions are members of a *family*, and families
   exchange messages on a *peer bus*.
3. **Where a decision comes from.** Questions are queued and answered from a
   rail instead of blocking the turn.
4. **What is remembered.** A vault records obligations and decisions from the
   transcript; a keysafe holds credentials per install.

## Module map

### Model routing

| Path | Role |
|---|---|
| `scripts/model-gateway.mjs` | the local gateway: provider adapters, retries, quota |
| `scripts/opencode-zen.mjs`, `scripts/opencode-go.mjs`, `scripts/commandcode.mjs`, `scripts/mistral.mjs` | provider adapters |
| `scripts/quota-cache.mjs`, `scripts/codex-quota.mjs` | rate-limit and quota state |
| `src/utils/model/gatewayBackend.ts` | harness side of the gateway connection |
| `src/utils/model/gatewayModelIds.ts`, `gatewayModelOptions.ts`, `gatewayModelOrder.ts` | model catalogue and ordering |
| `src/utils/model/gatewayEffort*.ts` | reasoning-effort support per model |
| `src/utils/model/gatewayWebSearch.ts` | web search through the gateway |
| `src/utils/providerQuota.ts`, `src/utils/commandCodeUsage.ts`, `mistralUsage.ts`, `opencodeUsage.ts`, `deepseek.ts` | per-provider limits and usage |

### Sessions, families, leaves

| Path | Role |
|---|---|
| `src/utils/leafFamily.ts` | the family record: members, designations, lineage |
| `src/utils/leafProcess.ts` | spawning, reaping, liveness |
| `src/utils/leafTerminal.ts`, `leafTerminalHost.ts` | the terminal a leaf runs in |
| `src/utils/leafChannel.ts`, `leafWorkspace.ts`, `leafAliases.ts` | addressing and workspace isolation |
| `src/utils/leafCheckpoints.ts` | frozen copies of a conversation a leaf can branch from |
| `src/utils/partnerLeaf.ts` | headless partner sessions owned by one session |
| `src/utils/leafBreakaway.ts` | keeping leaves out of the parent's job object |
| `src/utils/sessionReaper.ts`, `sessionIdentity.ts`, `sessionTitles.ts` | session lifecycle |
| `src/utils/headLedger.ts`, `zenithLedger.ts`, `zenithRole.ts` | the family's own record of who did what |
| `src/components/LeafWorkspaceDialog.tsx`, `GatewaySessionsDialog.tsx`, `SessionMetadataDialog.tsx` | the UI |

### The peer bus

| Path | Role |
|---|---|
| `src/utils/gatewaySessionProtocol.ts` | message shapes and envelopes |
| `src/utils/gatewaySessionTransport.ts` | how a message reaches another session |
| `src/utils/gatewaySessionRuntime.ts`, `gatewaySessionDelivery.ts` | delivery and retry |
| `src/utils/gatewaySessionDurability.ts`, `gatewaySessionOwnership.ts` | mailbox, locks, ownership |
| `src/utils/gatewayPeerSend.ts`, `gatewayPeerInjection.ts`, `gatewayPeerStopHook.ts` | sending, and turning a received message into a turn |
| `src/skills/bundled/gatewayPeers.ts` | the peer skill the agent is given |
| `src/tools/ListPeersTool/` | discovery |
| `src/components/messages/UserPeerMessage.tsx`, `UserCrossSessionMessage.js` | rendering |

### Question rail

| Path | Role |
|---|---|
| `src/utils/questionRail.ts` | the store: items, answers, threads, persistence |
| `src/utils/questionRailInjection.ts` | takes rail traffic out of the command queue |
| `src/utils/questionRailStopHook.ts` | claims rail traffic at the turn boundary |
| `src/components/QuestionRailBar.tsx` | the bar, the options and the per-question chat |

### Vault and keysafe

| Path | Role |
|---|---|
| `src/utils/vault/*.ts` | obligations, eligibility, capture, projection, recall, journal |
| `scripts/vault-cli.ts`, `scripts/vault-journal-worker.ts` | command line and journal worker |
| `scripts/gateway-keysafe.mjs`, `scripts/keysafe-vault.mjs` | credential store and injection |
| `src/utils/keysafe/index.ts` | harness side |
| `src/utils/gatewayCredentials.ts` | the credentials a run is allowed to see |

### Terminal contracts and quality

| Path | Role |
|---|---|
| `contracts/element-map-21338/` | the OSC 21338 element-map contract and its vectors |
| `scripts/element-map-vectors.ts` | regenerates the vectors from the real codec |
| `scripts/quality/cli.ts` | the quality gate (`scripts/quality/**`) |
| `.quality/policy/` | what the gate considers source, and which roots may execute |

### Release

| Path | Role |
|---|---|
| `scripts/stage-artifact.mjs`, `scripts/stage-codex.mjs` | stage a runnable tree and the pinned Codex binary |
| `scripts/release/package-release.mjs` | embed the runtime, prove it, write the archives |
| `scripts/release/build-msi.mjs`, `build-deb.mjs`, `package-macos.sh` | native installers |
| `scripts/release/windows/` | Inno Setup wizard (`gateway.iss`, `GatewayManager.cs`) |
| `scripts/release/install.sh`, `uninstall.sh` | portable install path |
| `scripts/cc`, `scripts/cc.ps1`, `scripts/cc.cmd` | the launcher |

## What is upstream, and not here

`upstream-touched.txt` lists the snapshot files this fork edits. If you are
reconstructing, that list is the integration surface: the entrypoint, the
command table, the tool registry, session storage, and the render hooks.
