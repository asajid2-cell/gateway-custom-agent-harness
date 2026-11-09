# Gateway — Custom Agent Harness

Originally built as a Claude Code fork intended to add OpenAI models to the
harness, Gateway has evolved into a robust custom harness with a unique
workflow that allows for robust, scalable and, most importantly, efficient
work.

The main features of the Gateway harness include:

- **A wide range of model options** — everything from OpenCode, CommandCode,
  OpenAI, Anthropic, Mistral and DeepSeek APIs, with more added whenever
  something intrigues me.
- **Peer-aware session communication** between your agents and sessions,
  allowing for interactive teamwork that amortizes context over families of
  agents, so their reasoning can catch each other's blind spots.
- **A robust session family system** — any individual session can fork its
  context instantly into a leaf it can immediately drive as a peer, or open a
  brand-new leaf on a stronger session for a quick adversarial review, without
  losing any local context. Knowledge spreads across the family, catching the
  occasional derailment and hallucination.

The family keeps itself accountable, which helps reduce errors and confusion
during the occasional compaction boundary.

## Download

Builds for Windows, Linux and macOS, 1.0.0-research, unsigned:
https://ahmedsajid.ca/gateway/

## This repository

This tree is the Gateway layer: the model gateway, session family and peer
bus, the question rail, the vault, and the release tooling. The Claude Code
source snapshot it builds against is not redistributed here, so the tree is
not buildable on its own.

## Where to go next

- **For humans** — [`human/README.md`](human/README.md): what Gateway is, how
  to install it, and how to use it. Short, no internals.
- **For agents** — [`agents/AGENTS.md`](agents/AGENTS.md): how to reassemble
  this tree onto a Claude Code snapshot, build it, run it, and answer
  questions about it. [`agents/architecture.md`](agents/architecture.md) and
  [`agents/internals.md`](agents/internals.md) go deeper.

Want to build it yourself? Clone this repo, bring your own Claude Code source
snapshot, and point your agent at [`agents/AGENTS.md`](agents/AGENTS.md) to
start.
