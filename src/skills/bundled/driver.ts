import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { registerBundledSkill } from '../bundledSkills.js'
import SKILL_MD from './driver/SKILL.md'

/**
 * `/driver` — the contract for the session that owns a family's work.
 *
 * It ships inside the CLI rather than only in a config-home directory, so an
 * installed gateway has the contract the activation gate assumes: the harness
 * authorizes the role, the skill only describes it. Shipping the prompt with
 * the gate is the point — a family whose driver learned the role from a file
 * the install never placed is a family that will improvise the gate.
 */

const { frontmatter, content: SKILL_BODY } = parseFrontmatter(SKILL_MD)

const DESCRIPTION =
  typeof frontmatter.description === 'string'
    ? frontmatter.description
    : 'Act as the driver of a leaf family: request harness authorization, read the vault before asking, and checkpoint settled decisions.'

export function registerDriverSkill(): void {
  registerBundledSkill({
    name: 'driver',
    description: DESCRIPTION,
    userInvocable: true,
    async getPromptForCommand(args) {
      const body = SKILL_BODY.trimStart()
      const instruction = args.trim()
      return [{ type: 'text', text: instruction ? `${body}\n\n## Driver instruction\n\n${instruction}` : body }]
    },
  })
}
