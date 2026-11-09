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

There are builds for Windows, Linux and macOS avilable at https://ahmedsajid.ca/gateway/ with password "gateway". They are 1.0.0-research and unsigned.

## This repository

This repo is the gateway layer only. The claude code source snapshot it builds against is not redistributed here, so this tree is not buildable on its own.

## Where to go next

The examples are at [examples/README.md](examples/README.md), with the workflow written out in [examples/workflow.md](examples/workflow.md) and the captures in [examples/media/](examples/media/).

For using gateway, start with [human/README.md](human/README.md). To work on the harness, start with [agents/AGENTS.md](agents/AGENTS.md), then read [agents/architecture.md](agents/architecture.md) and [agents/internals.md](agents/internals.md).

Bring your own claude code source snapshot, put this repo on top of it, and have your agent start with agents/AGENTS.md.
