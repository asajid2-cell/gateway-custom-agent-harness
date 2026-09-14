export const DESCRIPTION = 'See, talk to, and drive the leaf sessions forked from this session.'

export function getPrompt(): string {
  return `Leaf sessions are independent conversations forked from this one. Each runs in its own process with its own transcript, so work continues in parallel without leaving this session.

Actions:
- list: show every leaf with its number, name, live state, session ID, model and effort.
- status: alias of list.
- fork: fork the current session (or an existing leaf/session named by \`leaf\`) into a new leaf. This is how you extend the current work into a parallel branch.
- new: start a leaf with no copied context.
- send: hand a leaf a message. It runs as that leaf's next turn in its own REPL; it is not added to this conversation.
- interrupt: stop the leaf's current turn.
- checkpoint: save the leaf's transcript.
- close / reopen: stop or resume a leaf.
- model / effort: set a leaf's settings for its next turn.
- return: pull the leaf's selected context into this session's transcript.

Address a leaf by session ID, number (\`2\`), numbered name (\`2:api\`), or name. Ambiguous references are rejected rather than guessed.`
}
