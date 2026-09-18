import { sha256Hex } from './hash';
import { maskComments } from './sourceText';
import { normalizeAnchor } from './anchor';

/**
 * What a clone IS, and what a copy of it is.
 *
 * Every other analyzer in this engine reports a defect that lives at a place: an
 * unresolved import in this file, a function too complex in that one. A clone is
 * not at a place. It is a RELATION between two or more regions, and the number of
 * regions is the quantity that matters - three copies of a block is worse than
 * two, and consolidating two copies into one is a resolution while adding a third
 * is new debt.
 *
 * So the unit is a FAMILY:
 *
 *   family      = one normalized clone shape, however many regions exhibit it
 *   members     = the regions it currently appears at
 *   occurrences = members.length at the finding level
 *
 * ---------------------------------------------------------------------------
 * THE FINGERPRINT IS A SHAPE, AND THAT IS A DELIBERATE TRADE
 *
 * A family is keyed by the region's SHAPE: comments removed, whitespace
 * collapsed, identifiers and literals replaced by a placeholder, operators and
 * keywords preserved. That is what makes renaming a variable in every copy
 * (`total` -> `acc`, DUP-6) a non-event, which is required - a rename is not a
 * new clone, and a fingerprint over raw text would report every occurrence of it
 * as one family vanishing and another appearing.
 *
 * The price is that two regions which are isomorphic but unrelated - same
 * statement shapes, different names and different literals - share a fingerprint
 * and land in one family. This is accepted, and it is accepted in the direction
 * that fails safe: a spurious merge does not hide debt, it RAISES the occurrence
 * count and the gate blocks. The members list is carried into the finding's
 * evidence, so a reviewer who sees an implausible family can read exactly which
 * regions were grouped and why. The opposite trade - a fingerprint over raw text
 * - would dissolve genuine families on every rename, and dissolving a family is
 * how debt disappears.
 *
 * jscpd already made this judgement before we see the pair: `kind: renamed`
 * means the matcher only reached this match by ignoring identifiers. The
 * fingerprint here does the same thing to the grouping, so a family's members are
 * grouped consistently whether the tool called the individual pair exact or
 * renamed.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * COPY VERSUS MOVE
 *
 * A family whose members changed is not automatically new debt. A file rename or
 * a code move relocates a copy without creating one, and reporting that as a new
 * clone is a false positive that trains people to route around the gate.
 *
 * The two are distinguished by the ENGINE, from evidence this module preserves,
 * and it is worth writing down which evidence does which:
 *
 *   - a copy ADDED produces the same id with a higher `occurrences`, and
 *     `compare` reports `occurrences-increased` as a worsening. Blocking.
 *   - a copy REMOVED produces the same id with a lower `occurrences`, or removes
 *     the family entirely when only one region is left (a single region is not a
 *     clone). Reported as movement, never as a new finding.
 *   - a MOVE relocates the whole family. The subject moves with the smallest
 *     member, so the old id vacates and a new one arrives carrying the same
 *     `anchor` - which is the shape digest and therefore survives the move
 *     intact; `compare`'s relocation pass matches them on
 *     `rule::anchor::subjectDigest`, which is satisfied by a file rename because
 *     the content moved verbatim.
 *
 * That is why the member LIST is preserved in the finding's evidence rather than
 * summarized into a count: the count cannot show which regions moved, and a move
 * is a statement about which regions are where.
 *
 * KNOWN LIMITATION, recorded rather than glossed: when a family's SMALLEST member
 * path is deleted while other copies survive, the subject changes and the
 * relocation pass cannot fire, because the old subject file is gone and its
 * `subjectDigest` no longer resolves. The family then reads as one id resolving
 * and another arriving. It errs toward blocking rather than toward excusing, and
 * the anchor is unchanged in the report, so the two entries are recognizable as
 * the same shape. A member-independent subject is not expressible in this
 * engine's identity model, where the subject is always a repo-relative path.
 * ---------------------------------------------------------------------------
 */

/**
 * Clone kinds that block.
 *
 * Type-3 "similar" detection is deliberately absent. It reports pairs whose ASTs
 * are merely alike, and a gate that blocks on "these two functions are 85%
 * similar" is a gate people learn to route around; when fuzzy detection is added
 * it needs its own rule id and its own acceptance argument.
 */
export const BLOCKING_KINDS = new Set(['exact', 'renamed']);

/** A region of source: one member of a clone family. */
export interface CloneRegion {
  /** Repo-relative, posix separators. The adapter's job to normalize. */
  path: string;
  startLine: number;
  endLine: number;
}

export type CloneOccurrence = CloneRegion;

/**
 * One reported pair, already translated into repo-relative paths.
 *
 * `fragment` is a property of the PAIR, not of either region, because that is
 * what the detector reports: for a `renamed` match the two regions differ
 * textually (by their identifiers) and the tool hands over one representative
 * fragment with `kind: renamed` saying so. Giving each region its own fragment
 * would imply a per-region text this pipeline does not have.
 */
export interface ClonePair {
  first: CloneRegion;
  second: CloneRegion;
  fragment: string;
  kind: string;
  tokens: number;
  lines: number;
}

export interface CloneFamily {
  /**
   * The family's identity: the digest of the region's SHAPE.
   *
   * The grouping key and the finding's identity component are the same value on
   * purpose. They answer the same question - "is this the same clone" - and
   * giving them separate names is how they would come to disagree.
   *
   * A shape and not raw text, because the engine's own definition of `anchor` is
   * "what the finding is, independent of where it sits", and a clone family IS
   * its shape. Two pairs belong to one family only when their shape texts are
   * byte-identical, so this is a function of the family rather than of whichever
   * pair a report happened to list first. An anchor over raw source would change
   * the moment every copy of a block had a variable renamed, so renaming `total`
   * to `acc` throughout a codebase would read as every clone being replaced by a
   * new one, and the ratchet could not be advanced while the replacements exist.
   *
   * ---------------------------------------------------------------------------
   * A DIGEST, NOT A READABLE PREFIX OF THE SHAPE
   *
   * This was a 200-character prefix of the shape first, and the prefix is not an
   * identity because it is not injective. Two regions where one is a strict
   * superset of the other share their entire opening, so they share the prefix
   * while being different families; measured on this repository under that
   * scheme, six finding ids collided - each a pair of families in one file, one
   * region extending the other. They were separated by a position-ordered
   * ordinal, which is a fix that reads as a fix only until a third such family
   * appears between them and renumbers both.
   *
   * The digest is exact by construction - the grouping cannot put two shapes in
   * one family or one shape in two - so identity here needs no disambiguation
   * pass and no assumption about how much of a shape is distinctive.
   *
   * Nothing a reviewer needs is lost by it being unreadable, because no human
   * surface ever showed the anchor: the gate report prints rule, subject,
   * locator and `detail`. `regionStart` and the finding's `detail` carry the
   * readable line, and `evidence.members` carries where the copies are.
   * ---------------------------------------------------------------------------
   */
  fingerprint: string;
  /** First informative line of the region, verbatim. Evidence, not identity. */
  regionStart: string;
  members: CloneOccurrence[];
  tokens: number;
  lines: number;
  /**
   * `renamed` unless every contributing pair was `exact`. The weaker claim wins:
   * if any copy only matched with identifiers ignored, the family as a whole is
   * an identifier-renamed clone, and reporting it as exact would overstate what
   * was observed.
   */
  kind: 'exact' | 'renamed';
}

/**
 * Tokens kept as themselves by the shape normalization.
 *
 * Keywords and operators are what distinguish one construct from another; it is
 * the NAMES that a rename changes and a shape must ignore. `true`/`false`/`null`
 * are here rather than treated as literals because they change the meaning of a
 * region (a guard that returns `null` is not a guard that returns `true`).
 *
 * ---------------------------------------------------------------------------
 * THE LIST IS FOR RESERVED WORDS, AND `out` IS NOT ONE
 *
 * Every entry has to be a token that CANNOT be an ordinary identifier, because
 * the two ways of being wrong are not symmetric. A reserved word omitted from
 * this list lets two different constructs collapse into one shape, which raises
 * an occurrence count and blocks - noisy, but it does not hide debt. A contextual
 * keyword INCLUDED in the list does the opposite: `const out = []` is the most
 * ordinary line of code there is, and treating `out` as a keyword means renaming
 * that variable changes the shape, so the family dissolves, its two members are
 * no longer grouped, and the duplication is reported as resolved. That is the
 * one failure this module exists to make impossible.
 *
 * `out` was in this list as TypeScript's variance modifier (`<out T>`) and was
 * removed after a fixture caught the consequence: two copies of the same block
 * that differed only in `out` versus `result` produced two different shapes and
 * two identities. Dropping it costs almost nothing, because `in` stays and so
 * `Foo<out T>` still differs from `Foo<in T>`; the modifier only collapses
 * against no modifier at all.
 *
 * The rest of the contextual keywords - `as`, `from`, `get`, `is`, `of`, `set`,
 * `type` and the like - are kept, and that is a deliberate deferral rather than
 * an oversight. They really can be identifiers, so they carry the same hazard,
 * but removing them is not free in the other direction either: `get x() {}` and
 * `set x() {}` would normalize to one shape and an adjacent accessor pair would
 * be reported as a duplicated block. Which way each one goes needs evidence from
 * this repository, not a guess at which is worse.
 * ---------------------------------------------------------------------------
 */
const KEYWORDS = new Set([
  'abstract', 'as', 'asserts', 'async', 'await', 'break', 'case', 'catch',
  'class', 'const', 'constructor', 'continue', 'declare', 'default', 'delete',
  'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from',
  'function', 'get', 'if', 'implements', 'import', 'in', 'infer', 'instanceof',
  'interface', 'is', 'keyof', 'let', 'namespace', 'new', 'null', 'of',
  'override', 'package', 'private', 'protected', 'public', 'readonly', 'return',
  'satisfies', 'set', 'static', 'super', 'switch', 'this', 'throw', 'true',
  'try', 'type', 'typeof', 'undefined', 'unique', 'var', 'void', 'while',
  'with', 'yield',
]);

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;
/** Numeric literals, including hex, exponents and separators. */
const NUMBER = /\b(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?)\b/g;
/** Single-line string literals, quote-aware about escapes. */
const STRING = /(['"`])(?:\\.|(?!\1)[^\\\n])*\1/g;

/**
 * Comment-free, whitespace-collapsed lines of a region.
 *
 * Blank lines are dropped rather than kept, so a copy that gains or loses a blank
 * line - or a block comment spanning lines, which masks to whitespace - keeps the
 * same normalization. Comments are removed through `maskComments`, the same
 * function source integrity uses, because a comment edited in one copy of a block
 * must not split it into two families.
 */
export function normalizeRegion(fragment: string): string {
  const lines = maskComments(fragment).split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const collapsed = line.replace(/\s+/g, ' ').trim();
    if (collapsed.length > 0) out.push(collapsed);
  }
  return out.join('\n');
}

/**
 * The SHAPE of a region: normalized, then names and literals replaced.
 *
 * Both the family's grouping key and its identity are derived from this one
 * string, so they cannot disagree about what "the same clone" means. Empty for a
 * region with no code in it - an all-comment or whitespace region has no shape
 * to compare, and the caller must skip it rather than group every such region
 * into one family at the empty key.
 *
 * Exported because the module's argument rests on a property of this string that
 * is worth being able to state as a test - that its first 200 characters are NOT
 * an identity, which is why the family's identity is a digest of the whole thing.
 */
export function shapeOf(fragment: string): string {
  const normalized = normalizeRegion(fragment);
  if (normalized.length === 0) return '';
  return (
    normalized
      // Identifiers first, so `a1` becomes a placeholder before the numeric pass
      // sees its digit and a rename cannot change the shape.
      .replace(IDENTIFIER, (token) => (KEYWORDS.has(token) ? token : '_'))
      .replace(STRING, "''")
      .replace(NUMBER, '0')
  );
}

/**
 * The fingerprint of a region: its shape, digested.
 *
 * Returns the empty string for a region with no code in it, which the caller
 * must read as "not a member of any family" rather than as its own family.
 */
export function familyFingerprint(fragment: string): string {
  const shape = shapeOf(fragment);
  if (shape.length === 0) return '';
  return sha256Hex(shape);
}

/**
 * Lines that carry no information on their own: a lone closing brace, bracket,
 * parenthesis or semicolon.
 *
 * They matter because a detected region frequently BEGINS at one. jscpd reports
 * the token run, and a run that starts where a preceding block ends starts at
 * `}`. Measured on this repository: of 2,740 families, 197 had `}` as their first
 * normalized line, and a reviewer handed `}` as the region's opening line has
 * been told nothing about which block this is.
 */
const STRUCTURAL_CLOSER = /^[)\]};,]+;?$/;

/**
 * The first line of the region that says something, verbatim.
 *
 * Evidence rather than identity: a reviewer looking at a family of
 * placeholders needs the real source to recognize it, and this is the one part
 * of a family that a rename IS allowed to change.
 *
 * A region frequently BEGINS on a lone closing brace - jscpd reports the token
 * run, and a run that starts where a preceding block ends starts at `}` - so
 * `STRUCTURAL_CLOSER` skips to the first line carrying information. Deterministic,
 * and so still stable across runs.
 */
export function regionStartFor(fragment: string): string {
  const normalized = normalizeRegion(fragment);
  if (normalized.length === 0) return '';
  const lines = normalized.split('\n');
  const informative = lines.find((line) => !STRUCTURAL_CLOSER.test(line));
  return normalizeAnchor(informative ?? lines[0] ?? '');
}

/**
 * Group report pairs into families.
 *
 * jscpd reports PAIRS. Three identical copies produce three pairs, not one family
 * of three, so without grouping the occurrence count is meaningless - and a
 * ratchet that cannot count copies cannot tell consolidation from duplication.
 *
 * Members are de-duplicated by LOCATION rather than by fingerprint. That is what
 * keeps an intra-file clone (one file, two regions) from collapsing into a single
 * member and reporting a two-copy clone as a single occurrence.
 */
export function familiesFromPairs(pairs: ClonePair[]): CloneFamily[] {
  interface Draft {
    members: CloneOccurrence[];
    tokens: number;
    lines: number;
    regionStart: string;
    allExact: boolean;
  }

  const drafts = new Map<string, Draft>();

  for (const pair of pairs) {
    const kind = pair.kind.length > 0 ? pair.kind : 'exact';
    if (!BLOCKING_KINDS.has(kind)) continue;

    const fingerprint = familyFingerprint(pair.fragment);
    if (fingerprint.length === 0) continue;

    const regionStart = regionStartFor(pair.fragment);
    let draft = drafts.get(fingerprint);
    if (draft === undefined) {
      draft = {
        members: [],
        tokens: pair.tokens,
        lines: pair.lines,
        regionStart,
        allExact: kind === 'exact',
      };
      drafts.set(fingerprint, draft);
    } else {
      draft.allExact = draft.allExact && kind === 'exact';
      // Unlike the identity, this DOES differ between a family's pairs - it is
      // raw source, and a `renamed` pair matched with its names ignored. The
      // smallest is kept so the evidence does not depend on the order the report
      // listed the pairs in; it is therefore not necessarily the smallest
      // member's own line, and the members list is what says which region is
      // which.
      if (
        regionStart.length > 0 &&
        (draft.regionStart.length === 0 || regionStart < draft.regionStart)
      ) {
        draft.regionStart = regionStart;
      }
      // The largest region is the family's size: a pair covering a superset of
      // another pair's region is the more informative description of the copy.
      if (pair.tokens > draft.tokens) {
        draft.tokens = pair.tokens;
        draft.lines = pair.lines;
      }
    }

    for (const region of [pair.first, pair.second]) {
      addMember(draft.members, {
        path: region.path,
        startLine: region.startLine,
        endLine: region.endLine,
      });
    }
  }

  const families: CloneFamily[] = [];
  for (const [fingerprint, draft] of drafts) {
    draft.members.sort(compareMembers);
    // A single region is not a clone, and this is enforced here rather than
    // trusted from the tool. jscpd's accounting counts files participating in
    // clones, not copies, and a family reduced to one member by a deletion is a
    // block appearing once - which is the definition of not being duplicated.
    if (draft.members.length < 2) continue;
    families.push({
      fingerprint,
      regionStart: draft.regionStart,
      members: draft.members,
      tokens: draft.tokens,
      lines: draft.lines,
      kind: draft.allExact ? 'exact' : 'renamed',
    });
  }
  families.sort((a, b) =>
    compareMembers(a.members[0] as CloneOccurrence, b.members[0] as CloneOccurrence)
  );
  return families;
}

function addMember(members: CloneOccurrence[], candidate: CloneOccurrence): void {
  const found = members.some(
    (member) =>
      member.path === candidate.path &&
      member.startLine === candidate.startLine &&
      member.endLine === candidate.endLine
  );
  if (!found) members.push(candidate);
}

/** Path, then position. The same order every run over the same tree. */
export function compareMembers(a: CloneOccurrence, b: CloneOccurrence): number {
  return (
    a.path.localeCompare(b.path) ||
    a.startLine - b.startLine ||
    a.endLine - b.endLine
  );
}

/** `path:start-end|path:start-end`, the member list a reviewer reads. */
export function membersKey(members: CloneOccurrence[]): string {
  return members
    .map((member) => `${member.path}:${member.startLine}-${member.endLine}`)
    .join('|');
}
