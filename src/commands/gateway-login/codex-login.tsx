import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Box, Text } from '../../ink.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { resolveBundledCodex } from '../../../scripts/codex-resource.mjs'
import { codexAccounts, readCodexAuth } from '../../../scripts/codex-accounts.mjs'

/**
 * In-session ChatGPT device-auth for a Codex account home.
 *
 * `codex login --device-auth` prints a URL and a one-time code and then polls;
 * it does not need a terminal, so the dialog can show the pair and leave the
 * browser step to the human. Nothing but the URL and the code is displayed -
 * the CLI never prints the token, and the result is the auth.json it writes.
 *
 * The device code expires after 15 minutes, which is the timeout.
 */

const ANSI = /\u001b\[[0-9;]*m/g
const DEVICE_URL = /https:\/\/\S+/
const DEVICE_CODE = /\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/
const DEVICE_TIMEOUT_MS = 16 * 60_000

function codexCommand(): { command: string; shell: boolean } {
  const bundled = resolveBundledCodex()
  if (bundled) return { command: bundled, shell: false }
  if (process.platform === 'win32') {
    const npm = join(
      process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
      'npm',
      'codex.cmd',
    )
    return { command: existsSync(npm) ? npm : 'codex', shell: true }
  }
  return { command: 'codex', shell: false }
}

/**
 * The URL and one-time code from the CLI's device-auth banner. Only those two
 * fields are ever rendered; the rest of the output stays out of the UI.
 */
export function parseDevicePrompt(text: string): { url: string | null; code: string | null } {
  const clean = text.replace(ANSI, '')
  const url = clean.match(DEVICE_URL)?.[0]?.replace(/[.,)]+$/, '') ?? null
  const code = clean.match(DEVICE_CODE)?.[0] ?? null
  return { url, code }
}

function killTree(child: ReturnType<typeof spawn> | null): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch {}
    return
  }
  child.kill()
}

export function CodexDeviceLogin(props: {
  name: string
  home: string
  onDone: (result?: string) => void
}): ReactNode {
  const [url, setUrl] = useState<string | null>(null)
  const [code, setCode] = useState<string | null>(null)
  const [status, setStatus] = useState('Starting ChatGPT device sign-in...')
  const [error, setError] = useState<string | null>(null)
  const childRef = useRef<ReturnType<typeof spawn> | null>(null)
  const finished = useRef(false)

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      killTree(childRef.current)
      if (!cancelled) setError('The device code expired. Run /login codex new again.')
    }, DEVICE_TIMEOUT_MS)

    void (async () => {
      await mkdir(props.home, { recursive: true }).catch(() => {})
      const spec = codexCommand()
      const child = spawn(spec.command, ['login', '--device-auth'], {
        env: { ...process.env, CODEX_HOME: props.home },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: spec.shell,
        windowsHide: true,
      })
      childRef.current = child
      let buffer = ''
      const absorb = (chunk: Buffer) => {
        buffer += chunk.toString()
        const parsed = parseDevicePrompt(buffer)
        if (parsed.url) setUrl(parsed.url)
        if (parsed.code) setCode(parsed.code)
        if (parsed.url && !parsed.code) setStatus('Waiting for the sign-in page...')
        else if (parsed.url) setStatus('Waiting for you to finish in the browser...')
      }
      child.stdout?.on('data', absorb)
      child.stderr?.on('data', absorb)

      child.on('error', finishError => {
        clearTimeout(timer)
        if (cancelled) return
        setError(`Could not start the Codex CLI: ${finishError.message}`)
      })

      child.on('close', exitCode => {
        clearTimeout(timer)
        if (cancelled || finished.current) return
        finished.current = true
        void (async () => {
          if (exitCode !== 0) {
            setError(`Codex sign-in did not complete (exit ${exitCode ?? 'unknown'}). Run /login codex new again.`)
            return
          }
          const auth = await readCodexAuth(props.home)
          if (!auth) {
            setError(`Codex reported success but ${join(props.home, 'auth.json')} is not usable.`)
            return
          }
          const accounts = await codexAccounts()
          const stored = accounts.find((account: { name: string }) => account.name === props.name)
          const numberNote = stored ? ` It is account ${stored.number}.` : ''
          props.onDone(
            `Codex account ${props.name} signed in.${numberNote} ` +
              `Use /login codex switch ${stored?.number ?? props.name} [session|global] to select it.`,
          )
        })()
      })
    })()

    return () => {
      cancelled = true
      clearTimeout(timer)
      killTree(childRef.current)
    }
    // The account is chosen before the dialog renders; re-rendering must not
    // start a second device flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Dialog
      title={`Codex sign-in for ${props.name}`}
      onCancel={() => {
        finished.current = true
        props.onDone('Codex sign-in cancelled.')
      }}
      color="permission"
    >
      <Box flexDirection="column">
        <Text>Open this link and sign in to the ChatGPT account for {props.name}:</Text>
        <Text color="permission">{url ?? 'Waiting for the device code...'}</Text>
        {code && (
          <>
            <Text> </Text>
            <Text>One-time code:</Text>
            <Text color="permission">{code}</Text>
          </>
        )}
        <Text dimColor>
          The code expires in 15 minutes. It is a login credential: never share it.
        </Text>
        <Text dimColor>{status}</Text>
        {error && <Text color="error">{error}</Text>}
      </Box>
    </Dialog>
  )
}
