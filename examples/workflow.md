# The workflow, step by step

Four shapes of work, written out in the order it happens. The first one is
captured end to end; the others are the same workflow with a second session in
the middle, and their captures are still to come.

The session in the first example is real - a small `RetryQueue` with a test that
fails on the second run, and the transcript below is what it actually did.

---

## 1. A first session

Say what is wrong, not what to type.

```
> the second run of the retry test times out. find out why and fix it properly - dont touch the test.
```

![The session reading the repo and finding the shared state](media/01-plan.png)

It lists the folder, searches, reads two files, and names the cause: `backoff`
is module-scoped, so it is shared by every queue and every job. The first
test's four retries push it to 80 ms, and the second test inherits that and
blows its own 100 ms bound. It also notices the loop sleeps after the last
failed attempt, which is a second, smaller bug.

The fix is two lines, and it shows them before writing:

![The two edits, and the test run that follows](media/02-fix.png)

Then it runs the suite and reports what it saw:

![The summary: what was wrong, what changed, both tests passing](media/03-pass.png)

The test file is untouched, and the summary names the file and line it changed.
That is the whole point of running the session rather than taking a patch: it
found the bug, checked its own work, and left a record of both.

*The full loop, from the prompt to the passing suite, is
[`media/01-session.gif`](media/01-session.gif).*

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

● The reset is right, but the loop still sleeps after the final failure, so a
  job that never succeeds waits an extra backoff before it throws.
```

Back in the parent, that arrives as a peer message, not as something you had to
copy and paste:

```
> fix that too, and cap the delay at a second
```

Two sessions, one problem, and the disagreement is visible in the family
instead of living in your head.

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

You answer the first with `b`. The second is not obvious yet, so you use
**Chat** instead of answering:

```
> about the cap: we already have a deadline at the call site, so the backoff
  only needs to outlast a blip
```

The note reaches the model as context for that question. The question stays
open until it is actually answered, and answered ones can be cleared from the
bar once the session has moved on.

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

---

## What to watch for

Three things show up in all of these and are the reason the harness looks the
way it does. The agent reads before it writes, and the diff is yours to reject.
The checks it runs are its own, not yours - a session that reports a passing
test has run it. And a second session, given the same context, is the cheapest
error detector there is.
