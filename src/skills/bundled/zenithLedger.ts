import { registerBundledSkill } from '../bundledSkills.js'
import { getSessionId } from '../../bootstrap/state.js'

/**
 * `/zenith-ledger` — the orchestration surface over the durable ledger.
 *
 * The ledger exists so ownership is looked up rather than guessed, and a session
 * is a dated history rather than a remembered name. This command is the way a
 * coordinator reads and writes it without reading a task list or inferring from
 * a name, which is exactly the failure the module was built to close.
 *
 * Writes are gated on the Zenith claim (P7): only the session holding the role
 * assigns, reassigns or releases, because an ownership record a stranger can
 * write is not a record. Reads are ungated — anyone may look up who owns what.
 */
export function registerZenithLedgerSkill(): void {
  registerBundledSkill({
    name: 'zenith-ledger',
    description: [
      'The durable cross-session ledger: who owns which work, and the dated history of every observed session.',
      'Ownership here is a lookup, never a guess - `owner <workKey>` answers from the file, without a task list and without inferring anything from a name.',
      'Arguments:',
      'owner <workKey> | assignments | sessions | history <sessionId> | ambiguities | health |',
      'assign <workKey> <summary...> [sessionId] | release <workKey> [reason...] | reassign <workKey> <sessionId> [summary...] |',
      'sweep | claim [purpose...] | step-down.',
      'A session id that is not given is this session. `claim` takes the Zenith role (which is what permits assignment); `step-down` gives it up.',
      'Only the Zenith holder may assign, reassign or release, and the gate is checked on the caller - a coordinator cannot quietly take a lane\'s work, and a lane cannot take another lane\'s.',
      'An owner whose process is gone reads as ORPHANED (someone must release it); a key nobody has taken reads as unowned; a session nobody has observed reads as UNKNOWN rather than assumed idle.',
    ].join(' '),
    userInvocable: true,
    async getPromptForCommand(args) {
      const input = args.trim()
      try {
        const result = await run(input)
        return [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }]
      } catch (error) {
        // The real reason reaches the model. A single "the ledger failed" made a
        // bad argument, a missing session and an unreadable file indistinguishable,
        // which is how a lookup that worked read as the ledger being broken.
        return [{ type: 'text', text: `The ledger command failed: ${error instanceof Error ? error.message : String(error)}` }]
      }
    },
  })
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Resolve a session argument: an explicit id, or this session. */
function sessionArg(value: string | undefined): string {
  if (!value) return getSessionId()
  if (!UUID.test(value)) throw new Error(`"${value}" is not a session id. Address the session by its full id; a name is not an identity here.`)
  return value
}

async function run(input: string): Promise<unknown> {
  const ledger = await import('../../utils/zenithLedger.js')
  const role = await import('../../utils/zenithRole.js')
  const [verb, ...rest] = input.split(/\s+/).filter(Boolean)

  switch (verb) {
    case 'owner': {
      const workKey = rest[0]
      if (!workKey) throw new Error('owner needs a workKey.')
      const found = await ledger.ownerOf(workKey)
      // Say what a person can act on: an unowned key is free to take, an
      // orphaned one needs a release, an owned one names a session and family.
      if (found.state === 'unowned') return `${workKey}: unowned - nobody has taken it.`
      if (found.state === 'orphaned') return `${workKey}: ORPHANED - last held by ${found.sessionId} (family ${found.familyRootSessionId}) since ${found.since}${found.summary ? `: ${found.summary}` : ''}. Its process is gone, so it needs a release before it can be reassigned.`
      return `${workKey}: held by ${found.sessionId} (family ${found.familyRootSessionId}) since ${found.since}${found.summary ? `: ${found.summary}` : ''}. Owner liveness: ${String(found.ownerLive)}.`
    }
    case 'assignments': {
      const rows = await ledger.currentAssignments()
      return rows.length
        ? rows.map(row => row.state === 'unowned'
          ? `${row.workKey} - unowned`
          : row.state === 'orphaned'
            ? `${row.workKey} - ORPHANED (was ${row.sessionId})`
            : `${row.workKey} - ${row.sessionId} (${String(row.ownerLive)})${row.summary ? `: ${row.summary}` : ''}`).join('\n')
        : 'No assignments.'
    }
    case 'sessions': {
      const known = await ledger.knownSessions()
      return known.length
        ? known.map(row => `${row.sessionId} - ${row.name} (family ${row.familyRootSessionId}), last seen ${row.observedAt}${row.buildId ? `, build ${row.buildId}` : ''}`).join('\n')
        : 'No sessions observed. Run `sweep` to ask the live bus who is there.'
    }
    case 'history': {
      const sessionId = sessionArg(rest[0])
      const history = await ledger.sessionHistory(sessionId)
      if (history.state === 'unknown') return `${sessionId}: UNKNOWN - the ledger has never observed this session. That is not "gone"; it is unqueried. Run \`sweep\` if it should be live.`
      return [
        `${sessionId}: family ${history.familyRootSessionId}`,
        `first seen ${history.firstSeen}, last seen ${history.lastSeen}, ${history.observations.length} observation(s)`,
        ...history.observations.map(row => `  ${row.observedAt} - ${row.name}${row.buildId ? ` (build ${row.buildId})` : ''}`),
      ].join('\n')
    }
    case 'ambiguities': {
      const found = await ledger.ambiguities()
      if (found.length === 0) return 'No collisions: every id has one name, every name one id, every workKey one claimant.'
      // Report, do not resolve: picking silently is the defect this exists to expose.
      return found.map(item => item.kind === 'id-multi-name'
        ? `${item.sessionId} answers to ${item.names.length} names: ${item.names.join(', ')}`
        : item.kind === 'name-multi-id'
          ? `"${item.name}" names ${item.sessionIds.length} sessions: ${item.sessionIds.join(', ')}`
          : `${item.workKey} was claimed by ${item.sessionIds.length} sessions: ${item.sessionIds.join(', ')}`).join('\n')
    }
    case 'health': {
      const health = await ledger.ledgerHealth()
      return `sessions: ${health.sessions.records} record(s), ${health.sessions.skipped} unreadable line(s)\nassignments: ${health.assignments.records} record(s), ${health.assignments.skipped} unreadable line(s)`
    }
    case 'assign': {
      const workKey = rest[0]
      if (!workKey) throw new Error('assign needs a workKey.')
      const family = await ledger.familyRootFor(getSessionId())
      const assigned = await ledger.assign(workKey, {
        familyRootSessionId: family,
        ...(rest.length > 1 ? { summary: rest.slice(1).join(' ') } : {}),
      })
      if (assigned.ok === false && assigned.reason === 'not-zenith') {
        return `Refused: this session does not hold Zenith${assigned.holder ? ` (${assigned.holder} does)` : ''}. Assignment is what records who is doing what, so only the holder may write it. Run \`claim\` if the role is free, or ask the user to move it.`
      }
      if (assigned.ok === false) return `Refused: ${workKey} is already ${assigned.ownership.state}${assigned.ownership.state !== 'unowned' ? ` by ${assigned.ownership.sessionId}` : ''}. A live holder is not displaced; reassigning is a decision and needs the user (use reassign with that intent, or release it first).`
      return `Assigned ${workKey} to this session (family ${family}).`
    }
    case 'release': {
      const workKey = rest[0]
      if (!workKey) throw new Error('release needs a workKey.')
      const released = await ledger.release(workKey, { ...(rest.length > 1 ? { reason: rest.slice(1).join(' ') } : {}) })
      return released ? `Released ${workKey}.` : `Refused: ${workKey} is not held by a session you may release - either this session is not the owner and does not hold Zenith, or the key is not currently owned.`
    }
    case 'reassign': {
      const workKey = rest[0]
      const to = rest[1]
      if (!workKey || !to) throw new Error('reassign needs a workKey and a target session id.')
      const family = await ledger.familyRootFor(getSessionId())
      const moved = await ledger.reassign(workKey, { to: sessionArg(to), familyRootSessionId: family, ...(rest.length > 2 ? { summary: rest.slice(2).join(' ') } : {}) })
      if (moved.ok === false && moved.reason === 'not-zenith') return 'Refused: this session does not hold Zenith, so it cannot reassign work.'
      if (moved.ok === false) return `Refused: ${workKey} has a live holder (${moved.ownership.state !== 'unowned' ? moved.ownership.sessionId : 'unknown'}). Displacing live work is a decision - pass it to the user.`
      return `Reassigned ${workKey} to ${sessionArg(to)}.`
    }
    case 'sweep': {
      const result = await ledger.sweepSessions()
      return `Swept: asked ${result.asked} live session(s), ${result.answered} answered, ${result.recorded} recorded. A session that did not answer stays UNKNOWN rather than being recorded as absent.`
    }
    case 'claim': {
      const purpose = rest.join(' ')
      const taken = await role.claimZenith({ ...(purpose ? { purpose } : {}), force: false })
      if (taken.taken) return `This session now holds Zenith${purpose ? `: ${purpose}` : ''}. It may assign, reassign and release work.`
      return `Zenith is held by ${taken.claim.zenithSessionId}${taken.alive ? ', which is still running' : ', whose process is gone'}. Taking it from a live holder is the user's decision; ask them rather than forcing it.`
    }
    case 'step-down': {
      const released = await role.releaseZenith()
      return released ? 'This session no longer holds Zenith.' : 'This session does not hold Zenith, so there is nothing to release.'
    }
    default:
      throw new Error(`Unknown argument "${verb || '(none)'}". Use owner, assignments, sessions, history, ambiguities, health, assign, release, reassign, sweep, claim or step-down.`)
  }
}
