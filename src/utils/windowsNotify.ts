import { execFileNoThrow } from './execFileNoThrow.js'
import { logError } from './log.js'

export type WindowsNotification = {
  title?: string
  body?: string
  /** A `System.Media.SystemSounds` member name, played instead of a bundled sound. */
  sound?: string
}

/**
 * A Windows toast and/or a Windows system sound, best effort.
 *
 * Nothing else reaches the desktop here: `notifier.ts`'s `auto` channel answers
 * `no_method_available` on Windows because Windows Terminal speaks none of the
 * notification protocols it knows, so the native way in is the Windows Runtime
 * toast API - which exists only inside PowerShell. The notification is therefore
 * a PowerShell child, and the payload travels on stdin as JSON, the same handoff
 * the clipboard uses (`WINDOWS_CLIPBOARD_SCRIPT`): the script is a constant and
 * nothing is interpolated into the command line, so there is no quoting,
 * escaping or length limit to get wrong, and the payload is read with
 * `[Console]::In.ReadToEnd()` under an explicit UTF-8 decode.
 *
 * The AppId is PowerShell's own registered one. A toast has to name a registered
 * application and an invented name shows nothing at all, so a best-effort toast
 * from a terminal rides on the shell that already owns a Start-menu entry.
 *
 * Off Windows this is a no-op: the caller has nothing platform-specific to do.
 */
export const WINDOWS_TOAST_SCRIPT = `
[Console]::InputEncoding=[Text.Encoding]::UTF8
$payload=[Console]::In.ReadToEnd()|ConvertFrom-Json
if ($payload.title -or $payload.body) {
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]|Out-Null
    $template=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $texts=$template.GetElementsByTagName('text')
    $texts.Item(0).AppendChild($template.CreateTextNode([string]$payload.title))|Out-Null
    $texts.Item(1).AppendChild($template.CreateTextNode([string]$payload.body))|Out-Null
    $appId='{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($template))
  } catch {}
}
if ($payload.sound) {
  $sounds=@{asterisk=[System.Media.SystemSounds]::Asterisk;beep=[System.Media.SystemSounds]::Beep;question=[System.Media.SystemSounds]::Question;exclamation=[System.Media.SystemSounds]::Exclamation;hand=[System.Media.SystemSounds]::Hand}
  if ($sounds.ContainsKey([string]$payload.sound)) { $sounds[[string]$payload.sound].Play() }
}
`.trim()

/** Returned rather than inlined so a test can pin the contract without a desktop. */
export function win32NotifyCommand(): { file: string; args: string[] } {
  return {
    file: 'powershell',
    args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_TOAST_SCRIPT],
  }
}

export async function notifyWindows(
  notification: WindowsNotification,
): Promise<void> {
  if (process.platform !== 'win32') return
  const { file, args } = win32NotifyCommand()
  const result = await execFileNoThrow(file, args, {
    input: JSON.stringify(notification),
    useCwd: false,
    // PowerShell costs a few hundred ms to start, so the default 10s budget is
    // the right one for a write that is already fire-and-forget.
    timeout: 10_000,
  })
  // A notification that silently did nothing must not read like one that was
  // never sent, so the failure is recorded rather than swallowed.
  if (result.code !== 0) {
    logError(new Error(`Windows notification failed: ${result.error ?? result.code}`))
  }
}
