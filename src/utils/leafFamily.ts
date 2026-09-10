import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod/v4'
import { lock } from './lockfile.js'

const memberSchema = z.object({
  sessionId: z.string().uuid(), parentSessionId: z.string().uuid(), number: z.number().int().positive(),
  name: z.string().min(1).max(200), transcriptPath: z.string().min(1),
  forkMessageId: z.string().min(1).nullable(), createdAt: z.string().datetime(),
  status: z.enum(['open', 'closed', 'archived', 'promoted']),
  cwd: z.string().min(1).max(4096).optional(),
  draft: z.string().max(1000000).optional(),
  scrollOffset: z.number().int().nonnegative().optional(),
  model: z.string().min(1).max(200).optional(),
  effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode']).optional(),
}).strict()
const familySchema = z.object({
  version: z.literal(1), rootSessionId: z.string().uuid(), nextNumber: z.number().int().positive(),
  members: z.array(memberSchema),
  returnedContextIds: z.array(z.string().uuid()).default([]),
}).strict()
export type LeafMember = z.infer<typeof memberSchema>
export type LeafFamily = z.infer<typeof familySchema>

export async function readLeafFamily(path: string, rootSessionId: string): Promise<LeafFamily> {
  try {
    const family = familySchema.parse(JSON.parse(await readFile(path, 'utf8')))
    if (family.rootSessionId !== rootSessionId || new Set(family.members.map(m => m.number)).size !== family.members.length || new Set(family.members.map(m => m.sessionId)).size !== family.members.length || family.members.some(m => m.number >= family.nextNumber)) throw new Error('Invalid leaf family identity')
    return family
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, rootSessionId, nextNumber: 1, members: [], returnedContextIds: [] }
    throw error
  }
}

async function mutateFamily<T>(path: string, rootSessionId: string, mutate: (family: LeafFamily) => T | Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const release = await lock(path, { realpath: false, retries: { retries: 20, minTimeout: 10, maxTimeout: 100 } })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const family = await readLeafFamily(path, rootSessionId)
    const result = await mutate(family)
    familySchema.parse(family)
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(family)); await handle.sync() }
    finally { await handle.close() }
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, path); break }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || attempt >= 5) throw error
        await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)))
      }
    }
    return result
  } finally {
    await unlink(temporary).catch(() => {})
    await release()
  }
}

export function addLeafMember(path: string, rootSessionId: string, input: Omit<LeafMember, 'number' | 'createdAt' | 'status'>): Promise<LeafMember> {
  return mutateFamily(path, rootSessionId, family => {
    if (family.members.some(m => m.sessionId === input.sessionId) || input.sessionId === rootSessionId) throw new Error('Leaf session already belongs to this family')
    if (input.parentSessionId !== rootSessionId && !family.members.some(m => m.sessionId === input.parentSessionId)) throw new Error('Unknown leaf parent')
    if (!Number.isSafeInteger(family.nextNumber + 1)) throw new Error('Leaf sequence exhausted')
    const member = memberSchema.parse({ ...input, number: family.nextNumber++, createdAt: new Date().toISOString(), status: 'open' })
    family.members.push(member)
    return member
  })
}

export async function recordLeafContextReturn(path: string, rootSessionId: string, id: string, persist: () => Promise<void>): Promise<boolean> {
  return mutateFamily(path, rootSessionId, async family => {
    if (family.returnedContextIds.includes(id)) return false
    await persist()
    family.returnedContextIds.push(id)
    return true
  })
}

export function updateLeafMember(path: string, rootSessionId: string, sessionId: string, patch: Pick<Partial<LeafMember>, 'name' | 'status' | 'model' | 'effort' | 'draft' | 'scrollOffset'>): Promise<LeafMember> {
  return mutateFamily(path, rootSessionId, family => {
    const index = family.members.findIndex(m => m.sessionId === sessionId)
    if (index < 0) throw new Error('Unknown leaf session')
    const member = memberSchema.parse({ ...family.members[index], name: patch.name ?? family.members[index]!.name, status: patch.status ?? family.members[index]!.status, model: patch.model ?? family.members[index]!.model, effort: patch.effort ?? family.members[index]!.effort, draft: patch.draft ?? family.members[index]!.draft, scrollOffset: patch.scrollOffset ?? family.members[index]!.scrollOffset })
    family.members[index] = member
    return member
  })
}
