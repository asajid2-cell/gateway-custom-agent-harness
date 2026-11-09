# Examples

One recorded session, on a small worker pool with a job that gets processed
twice and another that never runs, and the part that matters after the fix: a
leaf on a stronger model reads it and says what it missed.

| | |
|---|---|
| ![The fix: shift before the await](media/01-fix.png) | ![The leaf reading the fix on opus](media/02-leaf.png) |

![The review arriving in the parent session](media/03-review.png)

The first still is the parent finding and fixing a real concurrency bug. The
second is the leaf that opened on claude opus 5.5 while the parent stayed on
deepseek, through the session message that handed it the context. The third is
its review coming back into the parent, in the same conversation.

Two minutes of that, start to finish, is
[`media/01-session.gif`](media/01-session.gif) (3.5 MB). [workflow.md](workflow.md)
writes the steps out and covers the question rail and mixed-provider families
too; those are not recorded yet.
