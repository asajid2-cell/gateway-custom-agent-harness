# Using Gateway

## Asking for work

Start `gateway` in the folder you want it to work in and say what you want. It
reads the files it needs, edits them, runs commands, and asks before doing
something it cannot undo. Being specific pays - "make the failing test in
`src/api/queue.test.ts` pass" gets further than "fix the tests".

## Sessions

Every session keeps its own context, and they all live on disk. Starting
Gateway again gives you a new session; `/gateway-sessions` lists the old ones
and reopens them.

When a session gets long, `/compact` folds it down. It also happens on its own
at the limit - the summary keeps the recent decisions and whatever was still
being worked on, and the family is what usually catches it if something gets
lost in that fold.

## Models and providers

`/model` picks a model for the session and `/openmodels` lists what the gateway
can route to. `/limit` shows what the current provider says about its quota,
and `/toggle-thinking` turns extended reasoning on or off where the model
supports it.

Claude and chatgpt/codex sign in with an account; the others take keys. You can
mix them - one session can hand work to a leaf running on another provider,
which is often the point.

## Leaves and families

A family is a session and the leaves it has opened. `/leaf` opens one: either a
fork of this session that keeps its context, or a fresh leaf on a stronger
model when you want a real second opinion. `/fork` does the fork directly,
`/peers` lists who is in the family and what they can reach, and
`/gateway-sessions` shows every session on the machine.

A leaf is a real session, so you can type into it yourself, and the parent can
drive it as a peer. Ask one to find the flaw in the plan and the family keeps
both answers in view.

## Questions

When Gateway needs a decision it asks instead of guessing. Questions collect in
a bar at the bottom rather than blocking the session: answer one with a click
or a number, use **Chat** to add detail to a question without answering it yet,
and clear the answered ones when you are done with them.

## Keys and accounts

`/gateway-login` shows the accounts this install holds and lets you add more.
Keys stay in the install's own keysafe folder, not in the repo and not in
`~/.claude`.

## When nothing starts

Open a new terminal first - PATH changes do not reach windows that were already
open. If it still fails, `gateway login --status` will tell you whether the
install is intact. If a window flashes and closes, run `scripts\cc.cmd` on
Windows or `scripts/cc` on Linux and macOS from the install folder and you will
see the error instead of a flash.

The downloads are unsigned, so Windows and macOS will complain. That is what
`SHA256SUMS` on the download page is for - check the file rather than the
warning.
