export const DESCRIPTION = 'See, talk to, and drive the leaf sessions in this family.'

export function getPrompt(): string {
  return `Leaf sessions are one family of independent conversations. Each runs in its own process with its own transcript, so work continues in parallel without leaving this session. Every member is an entry point in its own right: \`cc --resume <session id>\` opens any of them directly, and from there it can reopen the rest, open new leaves and reopen existing ones. No member, the parent included, is the only way in, so a family can run deep without ever going back to where it started.

Everyone in the family sees everyone else. A leaf you forked can list and message its siblings, \`roster\` shows it its parent, and \`notify\` sends a report back here. Awareness is symmetric, so a leaf that needs something can ask for it instead of working blind.

Actions:
- list: show every leaf with its number, name, live state, session ID, model and effort.
- status: alias of list.
- roster: the family view. It names the family id and marks the parent row \`[parent]\`. \`list\` shows the same members without the family line. The family id is the session the family was created from; it identifies the family and never changes, and it is not necessarily the parent.
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

Address a leaf by session ID, number (\`2\`), numbered name (\`2:api\`), or name. \`original\` names the member the family was created from; \`parent\` and \`root\` name the member designated as its parent, which \`reparent\` can change. Ambiguous references are rejected rather than guessed.`
}
