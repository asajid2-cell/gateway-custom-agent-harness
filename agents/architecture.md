# Architecture

What the parts are and where they live. For how they work, read
[internals](internals.md).

## The shape of the program

Gateway is a terminal REPL. One process owns the terminal, the conversation and
the turn loop:

```
entrypoint -> app shell -> message loop -> model call -> tool calls -> render
                                |                              |
                          session storage                  permissions
```

The snapshot supplies that skeleton. The fork changes four things inside it:
which model a turn goes to, who a session is, where a decision comes from, and
what gets remembered.

## Model routing

Every provider sits behind one local HTTP gateway, `scripts/model-gateway.mjs`,
so the harness speaks a single protocol to it and a new provider is an adapter
rather than a new code path in the conversation loop. The adapters are
`scripts/opencode-zen.mjs`, `scripts/opencode-go.mjs`,
`scripts/commandcode.mjs` and `scripts/mistral.mjs`; quota and rate-limit state
is in `scripts/quota-cache.mjs` and `scripts/codex-quota.mjs`.

On the harness side, `src/utils/model/gatewayBackend.ts` is the connection
itself, `gatewayModelIds.ts`, `gatewayModelOptions.ts` and
`gatewayModelOrder.ts` are the catalogue, and `gatewayEffort*.ts` is what each
model can do with reasoning effort. Usage and limits per provider live in
`src/utils/providerQuota.ts` with friends - `commandCodeUsage.ts`,
`mistralUsage.ts`, `opencodeUsage.ts`, `deepseek.ts`.

## Families and leaves

`src/utils/leafFamily.ts` is the family record: who is in it, what they are
designated, who came from whom. The rest hangs off it - `leafProcess.ts` for
spawning and reaping, `leafTerminal.ts` and `leafTerminalHost.ts` for the
terminal a leaf runs in, `leafChannel.ts` for talking to it, `leafWorkspace.ts`
and `leafAliases.ts` for addressing, `leafCheckpoints.ts` for the frozen copies
a leaf can branch from, and `leafBreakaway.ts` to keep a child out of the
parent's job object. `partnerLeaf.ts` is the headless variant a session owns
outright.

`headLedger.ts`, `zenithLedger.ts` and `zenithRole.ts` are the family's own
record of who did what. In the UI, `LeafWorkspaceDialog.tsx`,
`GatewaySessionsDialog.tsx` and `SessionMetadataDialog.tsx` are the visible
parts.

## The peer bus

`gatewaySessionProtocol.ts` defines the envelopes and `gatewaySessionTransport.ts`
carries them; `gatewaySessionDelivery.ts` retries and
`gatewaySessionDurability.ts` and `gatewaySessionOwnership.ts` decide where a
message waits when the target is not running. On the receiving side,
`gatewayPeerSend.ts`, `gatewayPeerInjection.ts` and `gatewayPeerStopHook.ts` turn
a message into a turn, and `src/skills/bundled/gatewayPeers.ts` is what the
agent is told about the bus. `src/tools/ListPeersTool` is discovery;
`src/components/messages/UserPeerMessage.tsx` and `UserCrossSessionMessage.js`
are how it looks.

## The question rail

`src/utils/questionRail.ts` is the store - items, answers, threads,
persistence. `questionRailInjection.ts` takes rail traffic out of the command
queue and `questionRailStopHook.ts` claims it at the turn boundary.
`src/components/QuestionRailBar.tsx` is the bar, the options and the
per-question chat.

## Vault and keysafe

The vault is `src/utils/vault/` - obligations, eligibility, capture,
projection, recall, journal - with `scripts/vault-cli.ts` and
`scripts/vault-journal-worker.ts` behind it. Credentials are a separate thing
on purpose: `scripts/gateway-keysafe.mjs` and `scripts/keysafe-vault.mjs` are
the store and the injection, `src/utils/keysafe/index.ts` and
`gatewayCredentials.ts` are the harness side.

## Contracts and quality

`contracts/element-map-21338/` is the OSC 21338 element-map contract and its
vectors, kept honest by `scripts/element-map-vectors.ts`, which regenerates them
from the real codec so the fixture cannot drift. `scripts/quality/cli.ts` is the
quality gate, and `.quality/policy/` says what counts as source and which roots
may execute.

## Release

`scripts/stage-artifact.mjs` and `scripts/stage-codex.mjs` build the tree that
will ship; `scripts/release/package-release.mjs` embeds the runtime and writes
the archives. The installers are `build-msi.mjs`, `build-deb.mjs`,
`package-macos.sh` and the Inno wizard under `scripts/release/windows/`. The
launchers are `scripts/cc`, `cc.ps1` and `cc.cmd`.

## What is not here

`upstream-touched.txt` is the list of snapshot files the fork edits. If you are
rebuilding, that list is the integration surface - the entrypoint, the command
table, the tool registry, session storage and the render hooks.
