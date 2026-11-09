# Internals

How the mechanisms behave, in the order they matter. Where something is subtle
the test that pins it is named in the sentence, and the test is the authority -
read it before trusting the prose.

## A turn boundary is where everything meets

Anything that arrives from outside a session - a peer message, a question
answer - is a queued command with an origin, not a user prompt. That distinction
is load-bearing: a prompt would jump the composer queue, spend one of the four
prompt slots, and could be pulled into the input box by Escape. A command with
an origin does none of that.

Two mechanisms share the work and between them cover the space. The queue wakes
a session that is idle, which is how a message reaches one nobody is typing
into. A Stop hook claims the queue at the turn boundary, which is how a message
reaches one that is busy but still has its context loaded. The original of this
shape is `src/utils/gatewayPeerInjection.ts`, and the rail reuses it. The
registration lives in `gatewayPeerStopHook.ts` and uses a stable hook id, so
registering twice does not double-deliver.

There are two origins today, `gateway-peer` and `question-rail`. `messages.ts`
renders both without the "the user sent a message while you were working"
framing, and `sessionStorage.ts` keeps them as loggable attachments so a
resumed session still has them. `scripts/question-rail.test.mjs` pins the rail
half, including that the hook blocks once and then allows.

## Families and leaves

A family is a session plus the leaves it opened. The record is in
`leafFamily.ts`, the append-only history of what happened is in
`headLedger.ts` and `zenithLedger.ts`.

A leaf is a full session process, not a thread. Forking copies the parent's
conversation at the moment the leaf opens, so it starts with the parent's
context and diverges from there. A checkpoint freezes a conversation at a point
and can be branched from repeatedly - taking the same conversation twice is one
checkpoint, not two. Driving a leaf means sending it a message and reading its
turns, and `leafBreakaway.ts` keeps that child out of the parent's Windows job
object so it survives the parent exiting.

Liveness is observed, not assumed. A member is enumerable while closed, and
"unknown" is not "closed" - the distinction is what lets a family reopen a
member instead of declaring it dead. The tests that matter here are
`leaf-family.test.ts`, `leaf-merge.test.ts`, `leaf-checkpoint.test.ts`,
`leaf-pointer-succession.test.ts` and `leaf-owner-containment.test.ts`.

Designations - driver, heir, elder, matriarch, head - are organizational. They
change who the family listens to and never the transcript or a number.

## Sending a message to another session

`gatewayPeerSend.ts` builds the envelope from `gatewaySessionProtocol.ts`, the
transport delivers it, and `gatewaySessionDelivery.ts` retries. Durability and
ownership decide where it waits when the target is not running: a mailbox on
disk, claimed once, rather than a race between two senders.

The receiver does not poll. It is woken by the queue or claimed by the Stop hook
above, which is why a peer message can arrive mid-turn and still land in the
right place. And a message from a peer cannot authorize a secret read or a
credential write - that is a rule about who is allowed to ask, and no code path
overrides it.

## Model routing

The harness talks to one endpoint, the local gateway, and the gateway owns
everything provider-shaped: request format, auth header, streaming, retries.
Keys are numbered and held as a pool per provider in `gatewayCredentials.ts`. A
key that reports a quota refusal is not marked dead; the next attempt just uses
a different record, which is what `providerQuota.ts` and
`quota-cache.mjs` are keeping track of.

Model choice resolves through the catalogue in `src/utils/model/`, with effort
support per model in `gatewayEffortCapabilities.ts` and
`gatewayEffortDefaults.ts`. Failover is visible rather than silent - the route
comes from `MODEL_GATEWAY_DEFAULT` or `gatewayDefaultModel.ts`, and a failure
surfaces in the provider's own words.
`scripts/model-gateway.test.mjs` is the place to look when routing surprises
you.

## The question rail

`questionRail.ts` is a module store read through `useSyncExternalStore`, so
every component sees the same list without prop drilling. An item is open or
answered, can carry a thread of notes, and persists to a JSONL file beside the
session.

An answer is recorded in the store and carried by the queued command. A note is
different: `addQuestionNote` appends it to the item's thread and injects it
straight into the queued question as context, without answering it - that is
how you say "about that one, also consider X" without closing it.

Clearing finished questions writes a tombstone (`cleared: true`) instead of
rewriting history, and hydration still walks the tombstones when advancing the
numbering, so an id is never reused. In the UI, `QuestionRailBar.tsx` registers
an overlay while the chat box is open, which is what keeps exactly one input
owning the keyboard.

## The vault

The vault turns a transcript into obligations: who owes what, on what evidence,
in what state. `capture.ts` and `transcriptCapture.ts` read the turns,
`eligibleActions.ts` decides what counts, `obligations.ts` and `projection.ts`
are the model, `journal.ts` and `vault-journal-worker.ts` make the writes
durable, and `recall.ts` answers "what did we decide".

Credentials are deliberately not in the same store. The keysafe injects vault
records into a child process's environment at launch, so a key is never an
argument, never a file the agent reads, and never printed - which is the whole
reason `scripts/gateway-keysafe.mjs` exists in this shape.

## Packaging proves itself

`scripts/release/package-release.mjs` embeds a pinned bun runtime and then
proves it: it runs the launcher with a PATH that cannot contain bun.
`install-manifest.json` and `package-report.json` record `runtime.present`, the
digest of the embedded runtime, and `proof: {bun, loginStatus,
pathWithoutBun}`. A report without that proof does not describe a bundled
artifact, whatever is inside the archive.

`gateway login --status` is the independent version of the same check, which is
why the installers run it too.
