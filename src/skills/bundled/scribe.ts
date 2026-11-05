import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { registerBundledSkill } from '../bundledSkills.js'
import SKILL_MD from './scribe/SKILL.md'

/**
 * `/scribe` — the contract for a family's disposable extractor.
 *
 * Bundled for the same reason as `/driver`: the writer enforces what the scribe
 * may do, and the instructions that describe that boundary travel with the
 * binary instead of depending on a file someone remembered to install. A
 * scribe that never saw the contract is the one that edits the journal.
 */

const { frontmatter, content: SKILL_BODY } = parseFrontmatter(SKILL_MD)

const DESCRIPTION =
  typeof frontmatter.description === 'string'
    ? frontmatter.description
    : "Act as a family's scribe: propose evidence-backed, topic-tagged events for the vault writer, never decide, never write the journal."

export function registerScribeSkill(): void {
  registerBundledSkill({
    name: 'scribe',
    description: DESCRIPTION,
    userInvocable: true,
    async getPromptForCommand(args) {
      const body = SKILL_BODY.trimStart()
      const instruction = args.trim()
      return [{ type: 'text', text: instruction ? `${body}\n\n## Scribe instruction\n\n${instruction}` : body }]
    },
  })
}
