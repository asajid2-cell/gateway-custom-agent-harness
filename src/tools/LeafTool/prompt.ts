export const DESCRIPTION = 'See, talk to, and drive the leaf sessions forked from this session.'

export function getPrompt(): string {
  return `Leaf sessions are independent conversations forked from this one. Each runs in its own process with its own transcript, so work continues in parallel without leaving this session.

Everyone in the family sees everyone else. A leaf you forked can list and message its siblings, \`roster\` shows it its parent, and \`notify\` sends a report back here. Awareness is symmetric, so a leaf that needs something can ask for it instead of working blind.

Actions:
- list: show every leaf with its number, name, live state, session ID, model and effort.
- status: alias of list.
- roster: the family view. It names the family id and marks the parent row \`[parent]\`, which is how you get the session ID that \`original\`/\`parent\`/\`root\` resolve to. \`list\` shows the same members without the family line.
- reparent: make another member the family's parent. The family then takes that member's name, and the member that was the parent becomes an ordinary leaf. Organizational only: no conversation, transcript or number changes.
- fork: fork the current session (or an existing leaf/session named by \`leaf\`) into a new leaf. This is how you extend the current work into a parallel branch.
- new: start a leaf with no copied context.
- send: hand a leaf a message. A leaf that is running takes it at its next step boundary and answers from there, so a question comes back without waiting for the leaf to finish its whole turn; a leaf that is idle starts a turn with it. Either way it is not added to this conversation.
- interrupt: stop the leaf's current turn.
- checkpoint: save the leaf's transcript.
- close / reopen: stop or resume a leaf.
- model / effort: set a leaf's settings for its next turn.
- return: pull the leaf's selected context into this session's transcript.
- notify: available inside a leaf only - send a message up to the parent session.

Address a leaf by session ID, number (\`2\`), numbered name (\`2:api\`), or name. Inside a leaf, \`original\`, \`root\` and \`parent\` all name the conversation the family was forked from. Ambiguous references are rejected rather than guessed.`
}
