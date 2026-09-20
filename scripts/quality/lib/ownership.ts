import type { SourceUniverse } from './sourceUniverse';

/**
 * WHO OWNS AN ACCEPTED FINDING.
 *
 * The failure this closes, stated as it was measured: all three accepted
 * baselines - 8,001 entries across 219 + 5,038 + 2,744 - had
 * `acceptance.owner === null`. Every one of them. The engine recorded who
 * *accepted* the tolerance (`acceptedBy: "session-review"`) and never recorded
 * who was answerable for it, so "accepted legacy, owned by nobody" described the
 * entire backlog. That is permanent invisible debt: it can only ever be paid down
 * by someone who decides, unprompted, to go looking for it.
 *
 * The fix is NOT to hand-assign 8,001 owners. An owner assigned by hand is a
 * list that goes stale the moment a file moves, and it carries no reason a
 * reviewer can check. Ownership is instead INHERITED from a decision that already
 * exists and is already enforced elsewhere:
 *
 *   finding.subject  ->  source-universe role  ->  that role's declared owner
 *
 * The source-universe manifest already assigns every file to exactly one role,
 * every role already declares an `owner`, and the manifest's own rationale
 * already states that reassigning a role is a policy change. So the owner of a
 * finding is the owner of the code the finding is about - derived, current by
 * construction, and impossible to drift from the file it describes.
 *
 * Two things this deliberately does NOT do:
 *
 *  - It does not invent an owner for a finding whose subject is unclassifiable.
 *    `subject === ''` is real (a repository-level finding has no file), and a
 *    subject outside the universe means the subject is itself a reportable
 *    condition. Those resolve to null with a REASON, and the reason is what a
 *    reader acts on. A plausible fallback owner would be worse than null: it
 *    would make an unattributable finding look routed.
 *
 *  - It does not change `acceptedBy`. Authority and accountability are different
 *    questions and only one of them can be inherited. Who accepted the tolerance
 *    is a historical fact about a review; who is answerable for the debt is a
 *    property of the code. Deriving the first from the second would erase the
 *    audit trail that says a human approved it.
 */

/** How a finding's owner was arrived at. Recorded so the derivation is auditable. */
export type OwnerSource = 'inherited' | 'explicit' | 'unattributable';

export interface Attribution {
  owner: string | null;
  source: OwnerSource;
  /**
   * The source-universe role the subject belongs to, when it has one. This is the
   * *scope* of the acceptance: it says which part of the repository the tolerance
   * covers, which is the property a reviewer needs in order to judge whether the
   * finding is still in the right place.
   */
  role: string | null;
  /** Why the owner is what it is. Never empty. */
  reason: string;
}

/**
 * Resolve the answerable owner for a finding's subject.
 *
 * Total by construction over a well-formed manifest: `loadSourceUniverse`
 * guarantees every role declares an owner, so any subject that resolves to a role
 * resolves to an owner. A subject that resolves to nothing is reported as
 * unattributable rather than assigned a default.
 */
export function attributeSubject(
  universe: SourceUniverse,
  subject: string
): Attribution {
  if (subject === '') {
    return {
      owner: null,
      source: 'unattributable',
      role: null,
      reason:
        'this finding has no file subject (it is about the repository as a ' +
        'whole), so no role owns it. Routing it to a default owner would make an ' +
        'unattributable finding look assigned; it is recorded as unattributable ' +
        'so it appears in the unowned count rather than disappearing into one.',
    };
  }

  const roleName = universe.roleOf(subject);
  if (roleName === null) {
    return {
      owner: null,
      source: 'unattributable',
      role: null,
      reason:
        `"${subject}" matches no source-universe role, so ownership cannot be ` +
        'inherited for it. The unclassifiable subject is itself the condition to ' +
        'resolve: a file no role claims is a file nobody has decided how to ' +
        'measure.',
    };
  }

  const role = universe.roles.find((candidate) => candidate.name === roleName);
  // `roleName` came from the universe's own index, so this cannot be undefined
  // for a universe built by `loadSourceUniverse`. Guarded rather than asserted
  // because an owner is the thing being produced: a throwing accessor here would
  // turn a manifest problem into a run failure at the one place least able to
  // explain it.
  if (role === undefined || role.owner.trim() === '') {
    return {
      owner: null,
      source: 'unattributable',
      role: roleName,
      reason:
        `role "${roleName}" declares no owner, so findings in "${subject}" have ` +
        'nobody answerable for them. That is a manifest defect, not a finding ' +
        'property: fix the role so the debt routes.',
    };
  }

  return {
    owner: role.owner,
    source: 'inherited',
    role: roleName,
    reason: `inherited from source-universe role "${roleName}" for ${subject}`,
  };
}

/**
 * The unowned residue of a baseline, grouped by why it is unowned.
 *
 * Reported rather than counted, because the remedy differs per reason and a bare
 * "17 unowned" would hide that half of them may have an obvious fix and the
 * other half may not.
 */
export function unattributedReasons(
  entries: Array<{ acceptance: { owner: string | null; ownerReason?: string } }>
): Map<string, number> {
  const byReason = new Map<string, number>();
  for (const entry of entries) {
    if (entry.acceptance.owner !== null) continue;
    const reason = entry.acceptance.ownerReason ?? 'no reason recorded';
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }
  return byReason;
}

export interface OwnershipDrift {
  id: string;
  subject: string;
  recordedOwner: string | null;
  recordedRole: string | null;
  currentOwner: string | null;
  currentRole: string | null;
}

/**
 * Accepted findings whose derived owner no longer matches what was recorded.
 *
 * Derived ownership has one weakness that a hand-written list does not: it
 * changes when someone edits the manifest, and that edit is a legitimate policy
 * action. The debt does not disappear when a file changes hands - only the name
 * attached to it does - so a reassignment that nobody sees is a bundle of
 * findings silently transferred to a team that never agreed to them.
 *
 * This makes the transfer visible without invalidating anything. It is reported
 * and never blocks, because a role change is a decision that was already made in
 * a policy file; the only new information is *which findings moved with it*, and
 * that is what a reviewer needs in order to ask whether they should have.
 */
export function ownershipDrift(
  universe: SourceUniverse,
  entries: Array<{
    id: string;
    subject: string;
    acceptance: {
      owner: string | null;
      ownerSource?: OwnerSource;
      ownerRole?: string | null;
    };
  }>
): OwnershipDrift[] {
  const drift: OwnershipDrift[] = [];
  for (const entry of entries) {
    // Only entries whose owner was DERIVED are checked. An explicitly named owner
    // is a human decision about this acceptance, and a manifest edit does not
    // overturn it - reporting it would be noise, and noise is how a real transfer
    // gets ignored.
    if (entry.acceptance.ownerSource !== 'inherited') continue;

    const current = attributeSubject(universe, entry.subject);
    const recordedRole = entry.acceptance.ownerRole ?? null;
    const recordedOwner = entry.acceptance.owner;

    if (current.role === recordedRole && current.owner === recordedOwner) continue;

    drift.push({
      id: entry.id,
      subject: entry.subject,
      recordedOwner,
      recordedRole,
      currentOwner: current.owner,
      currentRole: current.role,
    });
  }
  return drift;
}

