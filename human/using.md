# Using Gateway

## Ask for work

Start `gateway` in the folder you want it to work in and describe the task. It
reads files, edits them and runs commands, and it shows you a diff before
anything is written. It asks before anything destructive or outside that
folder - answer yes or no, or tell it to do something different.

Being specific pays: "make the failing test in `src/api/queue.test.ts` pass"
beats "fix the tests".

## Sessions

Each session keeps its own context. Starting Gateway again in the same folder
gives you a new session; older ones stay on disk in `~/.claude`, and
`/gateway-sessions` lists and reopens them.

Compact a long session with `/compact` when the context fills up. Gateway
compacts on its own at the boundary; the summary keeps the recent decisions
and the open work.

## Models and providers

- `/model` - pick a model for this session.
- `/openmodels` - list the models the gateway can route to.
- `/limit` - show what the current provider says about its rate limit and
  quota.
- `/toggle-thinking` - turn extended reasoning on or off where the model
  supports it.

Different providers answer differently: Claude and ChatGPT/Codex sign in with
your account, the rest take API keys. You can mix them - one session can hand
work to a leaf on another provider.

## Leaves, families, peers

A **family** is a session plus the leaves it has opened. `/leaf` opens one:
either a fork of this session that keeps its context, or a fresh leaf on a
stronger model for a second opinion.

- A leaf is a real session. You can type into it, or the parent can drive it.
- `/peers` lists the members of the family and the sessions they can message.
- `/fork` branches this session's context into a new leaf.
- `/gateway-sessions` shows every session, not just this family.

The point is adversarial review: ask a leaf to find the flaw in the plan, and
the family keeps both answers in view.

## Questions

When Gateway needs a decision it does not guess. Questions collect in a small
bar at the bottom instead of blocking the session:

- answer one with a click or a number,
- **Chat** adds detail to a question without answering it,
- answered questions can be cleared once you are done with them.

## Keys and accounts

`/gateway-login` shows which accounts this install holds and lets you add
another. Keys live in the install's own keysafe folder, not in the repo and
not in `~/.claude`, so two installs never share credentials by accident.

## When something does not start

1. Open a new terminal - PATH changes do not reach windows that were already
   open.
2. Run `gateway login --status`. If it does not print `"mode": "bundled"`,
   the install is incomplete; reinstall from the download page.
3. If the window flashes and closes, run `scripts/cc.cmd` (Windows) or
   `scripts/cc` (Linux, macOS) from the install folder to see the error text.
4. The launcher's log is `launcher.jsonl` in the install's data folder.

Builds are unsigned. If Windows or macOS blocks the download, that is why;
verify the file against `SHA256SUMS` on the download page rather than trusting
the warning.
