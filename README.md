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

Builds for Windows, Linux and macOS are at https://ahmedsajid.ca/gateway/.
They're 1.0.0-research and unsigned.

## Where to go next

Worked examples of the workflow - a first session, a family review, the rail,
and a family running on more than one provider - are written out step by step,
with captures, in [examples/](examples/README.md).

If you just want to use it, read [human/README.md](human/README.md) - installing
it, starting it, and the things that come up in the first week.

If you want to understand it, take it apart or rebuild it, start at
[agents/AGENTS.md](agents/AGENTS.md); [architecture](agents/architecture.md)
says what the parts are and [internals](agents/internals.md) says how they work.

Want to build it yourself? Bring your own claude code source snapshot, drop
this repo on top, and let your agent read agents/AGENTS.md to start.
