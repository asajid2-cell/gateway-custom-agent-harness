/**
 * The words every surface accepts for the family's head conversation.
 *
 * `head` is the name. `root` has named the same member since before the title
 * could move, and `patriarch` is kept as a deprecated alias for one release - so
 * a reference written before the rename still resolves: a script, a person's
 * habit, a model's memory of the old prompt. `original` is deliberately NOT
 * here: it names the family's creator, its ancestral beginning, which never
 * moves, while these name the member the family designates as its head now.
 *
 * The list has one home because it was duplicated - in the command grammar
 * (`leaf.tsx`), the reference resolver, the source resolver and the prompt - and
 * several copies of the same alias set drift the moment one of them is edited.
 */
export const LEAF_HEAD_ALIASES: readonly string[] = ['head', 'root', 'patriarch']

/** The one name for the family's creator, which never moves. */
export const LEAF_CREATOR_ALIASES: readonly string[] = ['original']

/** Whether a reference names the member the family designates as its head. */
export function isLeafHeadReference(reference: string): boolean {
  return LEAF_HEAD_ALIASES.includes(reference.trim().toLowerCase())
}

/** Whether a reference names either end of the family: its head, or its creator. */
export function isLeafRootReference(reference: string): boolean {
  const ref = reference.trim().toLowerCase()
  return ref === 'original' || isLeafHeadReference(ref)
}
