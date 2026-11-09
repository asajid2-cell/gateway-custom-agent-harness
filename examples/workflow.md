# The workflow, step by step

Four short walkthroughs. Each one is a real shape of work, written out in the
order it happens, with a note on what the capture for that step should show.
Quoted terminal text is shortened - the real thing is wordier.

## Before you start

You need Gateway installed (`human/README.md` has that) and a folder to work
in. Something with a failing test is the easiest start, because the agent can
check its own work.

Open a terminal in that folder and run `gateway`. A new terminal window is
better than your existing one; PATH changes do not reach windows that were
already open.

---

## 1. A first session

Say what is wrong, not what to type.

```
> the queue test keeps timing out on the second run

● Reading src/api/queue.test.ts, src/api/queue.ts
● The test awaits a promise that is only resolved by the watcher started in
  the first test. The second run reuses the module, so the watcher is already
  running and the promise never settles.
● Editing src/api/queue.ts
```

The agent proposes the change and shows the diff before writing:

```
  src/api/queue.ts
  - let watcher: Watcher | undefined
  + let watcher: Watcher | undefined
  + export function resetWatcher() { watcher?.close(); watcher = undefined }
```

You accept, it runs the test, and it reports honestly - including when it
still fails. That last part is the whole reason to prefer a session to a patch:
it can check itself, and it does.

*Capture: `01-plan.gif` - the read, the diagnosis and the edit, ending on the
diff.*

*Capture: `02-test.png` - the test run after the edit, one pass.*

---

## 2. A family review

The interesting case is when a session is confident and wrong. That is what the
family is for.

From the same session:

```
> /leaf ask a stronger model to find the flaw in the fix above

● Opened leaf 2 (gateway-claude-opus) with this session's context
```

The leaf starts with the parent's context, so it does not need the story
repeated. You ask it for the thing you actually want:

```
> leaf 2: what did the parent miss?

● The resetWatcher export is a new public API for a test-only concern, and
  nothing calls it in production. The parent also restarted the watcher on
  every run, which is why it looked fixed.
```

Back in the parent, that arrives as a peer message, not as something you had to
copy and paste:

```
> accept leaf 2's point and hide the reset behind the test helper
```

What you end up with is two sessions that read the same problem and disagree,
and the disagreement is visible in the family rather than in your head.

*Capture: `03-leaf.gif` - the fork, the leaf's answer, the parent amending.*

---

## 3. The rail

When the agent needs a decision it does not guess, and it does not block the
session on a modal either. Questions collect in a bar at the bottom.

```
> add retries to the fetch call

● Question: which failures should retry?
  a) connection errors only
  b) connection errors and 5xx
  c) everything except 4xx

● Question: should the backoff be capped?
  a) yes, at 30s
  b) no cap
```

You answer the first with `b`, and the second is not obvious yet, so you use
**Chat** instead of answering:

```
> about the cap: we already have a deadline at the call site, so the backoff
  only needs to outlast a blip

● Question: should the backoff be capped?
  a) yes, at 30s
  b) no cap
  answered: b - the caller already has a deadline
```

The note reaches the model as context for that question. The question stays
open until it is actually answered, and answered ones can be cleared from the
bar once the session has moved on.

*Capture: `04-rail.gif` - the two questions, the chat note, the answer.*

---

## 4. A second provider

Nothing stops a family from being mixed. `/openmodels` lists what the gateway
can route to, `/limit` shows what the current provider says about quota, and a
leaf can run somewhere else entirely while the parent stays put - which is how
you get a second opinion that is not the same model agreeing with itself.

```
> /limit
  gateway-gpt-6-sol   quota ok, resets in 2h
> /leaf open a leaf on gateway-claude-sonnet-5 and ask it to review the plan
```

That is also the cheapest way to find out whether a model is worth its price on
your actual work: give it one review, not a whole project.

*Capture: `05-providers.png` - `/openmodels` and one mixed-family leaf.*

---

## What to watch for

Three things show up in every one of these and are the reason the harness looks
the way it does. The agent reads before it writes, and the diff is yours to
reject. The checks it runs are its own, not yours - a session that reports a
passing test has usually run it. And a second session, given the same context,
is the cheapest error detector there is.

If you want the long version with video, the download site will have it. The
captures in `media/` are the short ones.
