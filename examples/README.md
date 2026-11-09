# Examples

I wanted a few real sessions here, so the first one is a small RetryQueue bug from a scratch repo, recorded from the first tool call through the passing test suite. The other examples are written out in [workflow.md](workflow.md), and I have not captured those yet.

The first test makes four retries and pushes the shared `backoff` to 80 ms. Since `backoff` was declared at module scope, the second test inherits it and breaks its own 100 ms bound. The agent listed the folder, searched, read two files, made two edits, and ran the suite without touching the test file.

| | |
|---|---|
| ![Diagnosis of the shared backoff](media/01-plan.png) | ![The two edits](media/02-fix.png) |

![Both tests passing](media/03-pass.png)

The full session is in [media/01-session.gif](media/01-session.gif) (28 seconds, 4.0 MB). The stills show the diagnosis, the edits, and the passing suite.

The other three examples are a family review where a leaf attacks the fix, the question rail where the agent asks instead of guessing and you can chat a note onto a question without answering it, and a mixed-provider family using `/openmodels`, `/limit`, and a leaf on another provider. Those captures are still to come.
