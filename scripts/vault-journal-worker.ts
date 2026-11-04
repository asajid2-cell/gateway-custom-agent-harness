/**
 * Test worker: appends N events from a separate process so the journal lock is
 * exercised across processes, not just across async calls in one.
 *
 * usage: bun scripts/vault-journal-worker.ts <vaultRoot> <familyId> <tag> <count>
 */
import { appendEvents } from '../src/utils/vault/journal.js'

const [vaultRoot, familyId, tag, count] = process.argv.slice(2)
if (!vaultRoot || !familyId || !tag || !count) {
  console.error('usage: vault-journal-worker.ts <vaultRoot> <familyId> <tag> <count>')
  process.exit(2)
}
const total = Number(count)
for (let index = 0; index < total; index += 1) {
  const result = await appendEvents(vaultRoot, familyId, [
    { event_id: `${tag}-${index}`, generation_id: 'gen-1', kind: 'finding', body: `${tag} ${index}` },
  ])
  if (result.committed.length !== 1) {
    console.error(JSON.stringify(result))
    process.exit(1)
  }
}
