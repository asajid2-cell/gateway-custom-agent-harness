# Internals

How the Gateway mechanisms work, in the order they matter. Where behaviour is
subtle, the test named beside it is the authority - read it before trusting
this prose.

## 1. A turn boundary is the unit of coordination

Everything that arrives from outside a session - a peer message, a question
answer - is a *queued command* with an origin, not a user prompt. A prompt
would jump the composer queue, consume the prompt budget, and be pullable into
the input box; a queued command with an origin does none of those.

Two mechanisms share the work, and they partition the space:

- **The queue** wakes a session that is idle (`enqueue({mode:'prompt',
  priority:'next', isMeta:true, origin:{kind:...}})`).
- **A Stop hook** claims the queue at a turn boundary, while the session is
  still alive and its context is current.

`src/utils/gatewayPeerInjection.ts` is the original of this shape; the question
rail copies it. `src/utils/gatewayPeerStopHook.ts` shows the registration:
`addFunctionHook(state, sessionId, 'Stop', ...)` with a stable hook id, so
registering twice does not double-deliver.

Two origins exist today: `gateway-peer` (a message from another session) and
`question-rail` (an answer or note). `src/utils/messages.ts` renders them
without the "the user sent a message while you were working" framing, and
`src/utils/sessionStorage.ts` keeps them as loggable attachments so a resumed
session still has them.

Tests: `scripts/gateway-peer-*`, `scripts/question-rail.test.mjs`.

## 2. Families and leaves

A family is a session plus the leaves it opened. The family record
(`src/utils/leafFamily.ts`) holds members, their designations and who drives
whom; the ledger (`headLedger.ts`, `zenithLedger.ts`) holds what happened,
append-only.

A leaf is a full session process, not a thread:

- **Fork** copies the parent's conversation into the new leaf at the moment it
  opens, so the leaf starts with the parent's context and then diverges.
- **Checkpoint** freezes a conversation at a point; forks can branch from it
  repeatedly. Taking the same conversation twice is one checkpoint.
- **Driving** a leaf means sending it a message and reading its turns -
  `leafChannel.ts` carries it, `leafProcess.ts` owns lifecycle, `leafBreakaway.ts`
  keeps the child out of the parent's Windows job object so it survives the
  parent's exit.
- **Liveness** is observable, not assumed: a family member is enumerable while
  closed, and "unknown" is not "closed".

Designations (`driver`, `heir`, `elder`, `matriarch`, `head`) are organizational
only - they change who a family listens to, never the transcript or a number.

Tests: `scripts/leaf-family.test.ts`, `leaf-merge.test.ts`,
`leaf-checkpoint.test.ts`, `leaf-pointer-succession.test.ts`,
`leaf-owner-containment.test.ts`.

## 3. Sending a message to another session

`gatewayPeerSend.ts` builds the envelope (`gatewaySessionProtocol.ts`), the
transport delivers it (`gatewaySessionTransport.ts`), and
`gatewaySessionDelivery.ts` retries. Durability and ownership
(`gatewaySessionDurability.ts`, `gatewaySessionOwnership.ts`) decide where a
message waits when the target is not running: a mailbox on disk, claimed once.

The receiving side does not poll: it is woken by the queue or claimed by the
Stop hook (section 1). A peer message cannot authorize a secret read or a
credential write - that is a rule about authorship, not a code path.

## 4. Model routing

The harness talks to one endpoint: the local gateway
(`scripts/model-gateway.mjs`). It owns provider differences - request shape,
auth header, streaming format, retry - so a new provider is an adapter, not a
new code path in the conversation loop.

- **Model choice** is resolved from the catalogue
  (`gatewayModelIds.ts`, `gatewayModelOptions.ts`, `gatewayModelOrder.ts`),
  with per-model effort support in `gatewayEffortCapabilities.ts` and
  `gatewayEffortDefaults.ts`.
- **Keys are numbered.** A session holds a pool per provider
  (`gatewayCredentials.ts`); a key that reports a quota refusal is not marked
  dead, but the next attempt uses a different record
  (`src/utils/providerQuota.ts`, `scripts/quota-cache.mjs`).
- **Failover is visible**, not silent: `gatewayDefaultModel.ts` and the
  launcher's `MODEL_GATEWAY_DEFAULT` set the route; a failure surfaces with the
  provider's own words.

Tests: `scripts/model-gateway.test.mjs`, `gateway-model-options.test.mjs`,
`gateway-effort-defaults.test.mjs`, `provider-quota-control.test.ts`.

## 5. The question rail

`questionRail.ts` is a module store read through `useSyncExternalStore`, so any
component sees the same list. An item moves through open -> answered, may carry
a `thread` of notes, and persists to a JSONL file next to the session.

Two ways a rail item reaches the model:

- **Answer**: recorded in the store; the queued command carries the answer.
- **Note** (`addQuestionNote`): appended to the item's `thread` and injected
  immediately as context for the queued question, without answering it.

Clearing finished questions writes tombstones (`cleared: true`) rather than
rewriting history, and hydration still advances the numbering over tombstones,
so an id is never reused. The UI (`QuestionRailBar.tsx`) registers an overlay
while the chat box is open - exactly one input owns the keyboard - and shows
the count of finished items next to *Clear finished*.

Test: `scripts/question-rail.test.mjs`.

## 6. The vault

The vault turns a transcript into obligations: who owes what, with what
evidence, in what state. `capture.ts` and `transcriptCapture.ts` read turns;
`eligibleActions.ts` decides what counts; `obligations.ts` and
`projection.ts` are the model; `journal.ts` (with `vault-journal-worker.ts`)
makes the writes durable; `recall.ts` answers "what did we decide".

Credentials are separate and deliberately not in the same store: the keysafe
(`scripts/gateway-keysafe.mjs`) injects vault records into a child process's
environment at launch, so a key is never an argument, never a file the agent
reads, and never printed.

Tests: `scripts/vault-*.test.ts`, `scripts/keysafe-vault.test.mjs`.

## 7. Packaging proves itself

`scripts/release/package-release.mjs` embeds a pinned bun runtime, then proves
the artifact: it runs the launcher with a `PATH` that cannot contain bun.
`install-manifest.json` and `package-report.json` record `runtime.present`,
the embedded runtime digest, and `proof: {bun, loginStatus,
pathWithoutBun}`. A report without that proof does not describe a bundled
artifact, whatever the archive contains.

The `gateway login --status` command is the cheapest independent check, which
is why the installers run it too.
