# The workflow

The first session below is real. It fixes a small RetryQueue in a scratch repo, and the captures show what happened. The family review, question rail, and mixed-provider family are written out too, but I have not recorded them yet.

---

## 1. A first session

I started with the failure and left the agent to work out why it happened.

```
> the second run of the retry test times out. find out why and fix it properly - dont touch the test.
```

![The session diagnosing shared state](media/01-plan.png)

The agent listed the folder, searched, and read two files. It found that `backoff` was declared at module scope, so it doubled across every queue and job. The first test's four retries push it to 80 ms, then the second test inherits that and breaks its own 100 ms bound.

It made two edits, first adding `const BASE_BACKOFF = 10`, then using `let backoff = BASE_BACKOFF` inside `attempt()`.

![The two edits](media/02-fix.png)

Then it ran the suite. Both tests passed, and the test file stayed untouched.

![The passing tests and summary](media/03-pass.png)

The summary names the change and the tests it ran. The full session, from the first tool call to the passing suite, is [media/01-session.gif](media/01-session.gif).

---

## 2. A family review

A leaf can start with the parent's context, so it can go straight at the fix without me repeating the whole story.

```
> /leaf ask a stronger model to find the flaw in the fix above

● Opened leaf 2 (gateway-claude-opus-5-5) with this session's context
```

Then I ask what it found.

```
> leaf 2: what did the parent miss?

● The reset is right, but the loop still sleeps after the final failure, so a
  job that never succeeds waits an extra backoff before it throws.
```

The leaf's answer arrives as a peer message in the parent session. I can ask the parent to fix that too, and cap the delay at a second.

```
> fix that too, and cap the delay at a second
```

This is the other session's job: read the fix with the same context and look for what it missed.

---

## 3. The question rail

When the agent needs a decision, it can ask instead of guessing. Questions collect in the rail at the bottom of the session.

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

I answer the first question with `b`. I am not ready to answer the second, so I use **Chat** to add a note without closing the question.

```
> about the cap: we already have a deadline at the call site, so the backoff
  only needs to outlast a blip
```

The note gives the model more context for that question. It stays open until I answer it, and I can clear answered questions from the rail after the session has moved on.

---

## 4. A mixed-provider family

A family can use more than one provider. `/openmodels` lists what gateway can route to, `/limit` shows the current provider's quota, and a leaf can run on another provider while the parent stays where it is.

```
> /limit
  gateway-gpt-6-sol   quota ok, resets in 2h
> /leaf open a leaf on gateway-claude-sonnet-5-5 and ask it to review the plan
```

That gives me another provider's review of the same plan, while the parent keeps its context and work.
