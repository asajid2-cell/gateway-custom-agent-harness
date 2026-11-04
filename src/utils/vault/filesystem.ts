import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * What the authoritative vault store needs from its filesystem.
 *
 * The journal's guarantees are only as good as the directory it lives in: an
 * exclusive create must be a lock, a rename must be atomic within the
 * directory, and a written line must be able to reach the device. Network
 * shares and some FUSE mounts provide none of those, so the writer proves them
 * before it adopts a directory rather than discovering it under load.
 */
export type VaultFilesystemProbe =
  | { ok: true; warnings: string[] }
  | { ok: false; reasons: string[]; warnings: string[] }

function isNetworkPath(dir: string): boolean {
  // Windows UNC (`\\server\share`) and POSIX network-style double slashes.
  return dir.startsWith('\\\\') || dir.startsWith('//')
}

/**
 * Prove the directory can host the authoritative store. Everything here is
 * behavioural: no heuristic decides safety while the operations themselves can
 * answer. A probe never leaves files behind, and a rejected directory is not
 * modified beyond the empty directories it had to create to be tested.
 */
export async function probeVaultFilesystem(dir: string): Promise<VaultFilesystemProbe> {
  const reasons: string[] = []
  const warnings: string[] = []

  if (isNetworkPath(dir)) {
    // Answer before touching it: probing a share would mount it and stall.
    return {
      ok: false,
      reasons: ['a network path cannot provide the locking, atomic-rename and durability semantics the journal requires'],
      warnings,
    }
  }

  // Check the path's own nature before creating anything: mkdir on a regular
  // file answers EEXIST, which would hide the real reason.
  const existing = await stat(dir).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    reasons.push(`cannot stat ${dir}: ${(error as Error).message}`)
    return undefined
  })
  if (existing === undefined) return { ok: false, reasons, warnings }
  if (existing && !existing.isDirectory()) {
    return { ok: false, reasons: [...reasons, `${dir} exists and is not a directory`], warnings }
  }
  if (!existing) {
    try {
      await mkdir(dir, { recursive: true })
    } catch (error) {
      reasons.push(`cannot create ${dir}: ${(error as Error).message}`)
      return { ok: false, reasons, warnings }
    }
  }

  const tag = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const lockPath = join(dir, `.vault-probe-lock-${tag}`)
  const renameFrom = join(dir, `.vault-probe-a-${tag}`)
  const renameTo = join(dir, `.vault-probe-b-${tag}`)
  const syncPath = join(dir, `.vault-probe-sync-${tag}`)

  // 1. Exclusive create must be a lock: the second opener must lose.
  try {
    const first = await open(lockPath, 'wx')
    await first.close()
    let secondAcquired = false
    try {
      const second = await open(lockPath, 'wx')
      secondAcquired = true
      await second.close()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        reasons.push(`exclusive create failed with ${(error as NodeJS.ErrnoException).code ?? 'an unknown error'} instead of EEXIST`)
      }
    }
    if (secondAcquired) reasons.push('exclusive create is not exclusive: two writers could hold the lock at once')
  } catch (error) {
    reasons.push(`exclusive create is unavailable: ${(error as Error).message}`)
  }

  // 2. Rename must be atomic within the directory (the commit swap relies on it).
  try {
    const handle = await open(renameFrom, 'w')
    await handle.writeFile('probe\n')
    await handle.close()
    await rename(renameFrom, renameTo)
  } catch (error) {
    reasons.push(`atomic rename failed: ${(error as Error).message}`)
  }

  // 3. A written line must be able to reach the device.
  try {
    const handle = await open(syncPath, 'w')
    await handle.writeFile('probe\n')
    await handle.sync()
    await handle.close()
  } catch (error) {
    reasons.push(`fsync is unavailable: ${(error as Error).message}`)
  }

  // A directory fsync is required on POSIX for a rename to be durable; Windows
  // cannot open a directory handle at all, so its absence there is expected.
  if (process.platform !== 'win32') {
    try {
      const handle = await open(dir, 'r')
      await handle.sync()
      await handle.close()
    } catch (error) {
      reasons.push(`directory fsync is unavailable: ${(error as Error).message}`)
    }
  }

  for (const path of [lockPath, renameFrom, renameTo, syncPath]) {
    await rm(path, { force: true }).catch(() => undefined)
  }

  return reasons.length > 0 ? { ok: false, reasons, warnings } : { ok: true, warnings }
}

export async function assertVaultFilesystem(dir: string): Promise<void> {
  const probe = await probeVaultFilesystem(dir)
  if (!probe.ok) {
    throw new Error(
      `the vault directory ${dir} cannot host the authoritative store: ${probe.reasons.join('; ')}`,
    )
  }
}
