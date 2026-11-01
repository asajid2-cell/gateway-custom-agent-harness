# OSC survival probe controller. Launch a dedicated Windows Terminal window
# running osc-probe.ps1, then read what the terminal actually holds from the
# OUTSIDE via UI Automation (TextPattern on the TermControl), plus clipboard and
# top-level window names. Nothing here writes to the probe's pty; the only
# evidence is the terminal's own rendered buffer and OS-level side effects.
param(
  [string]$OutDir = "$env:USERPROFILE\oscprobe",
  [string]$Driver = '',
  [ValidateSet('powershell', 'bun', 'tee')][string]$Launcher = 'powershell',
  [string]$Profile = '',
  [switch]$Close
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$log = New-Object System.Collections.Generic.List[string]
function L([string]$s) { $log.Add($s); }

$AE = [System.Windows.Automation.AutomationElement]
$root = $AE::RootElement
$wtCond = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')

function Get-WtWindows { $root.FindAll([System.Windows.Automation.TreeScope]::Children, $wtCond) }
function Get-VisibleText($win) {
  if ($null -eq $win) { return $null }
  $tc = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, 'TermControl')))
  if ($null -eq $tc) { return $null }
  $tp = $null
  if (-not $tc.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) { return $null }
  return $tp.DocumentRange.GetText(-1)
}

$before = @{}
foreach ($w in Get-WtWindows) { $before[$w.Current.NativeWindowHandle] = $true }
L ("pre-existing WT windows: " + (($before.Keys | Sort-Object) -join ','))
$wtPkg = Get-AppxPackage Microsoft.WindowsTerminal -ErrorAction SilentlyContinue
L ("Windows Terminal package version: " + ($(if ($wtPkg) { $wtPkg.Version.ToString() } else { '<not a store package>' })))
try { L ("wt.exe --version: " + (& wt.exe --version | Out-String).Trim()) } catch { L 'wt.exe --version: <failed>' }

# Distinct prelude so a clipboard canary that writes the SAME text as a
# previous run still registers as a change (the poller logs changes only).
Set-Clipboard -Value 'OSCPROBE-PRELUDE' -ErrorAction SilentlyContinue

if (-not $Driver) { $Driver = Join-Path $PSScriptRoot 'osc-probe.ps1' }
$profileArgs = @()
if ($Profile) { $profileArgs = @('--profile', "`"$Profile`"") }
if ($Launcher -eq 'bun' -or $Launcher -eq 'tee') {
  $bun = (Get-Command bun.exe).Source
  if ($Launcher -eq 'tee') {
    $tee = Join-Path $env:USERPROFILE 'muxtee\muxtee.exe'
    $args = @('-w', '-1', 'nt') + $profileArgs + @('--title', 'OSCPROBE', "`"$tee`"", '--', "`"$bun`"", 'run', "`"$Driver`"")
  } else {
    $args = @('-w', '-1', 'nt') + $profileArgs + @('--title', 'OSCPROBE', $bun, 'run', "`"$Driver`"")
  }
} else {
  $args = @('-w', '-1', 'nt') + $profileArgs + @('--title', 'OSCPROBE', 'powershell.exe', '-NoLogo', '-NoProfile',
            '-ExecutionPolicy', 'Bypass', '-File', "`"$Driver`"")
}
$cfg = Join-Path $env:LOCALAPPDATA 'Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json'
if (Test-Path $cfg) {
  try {
    $s = Get-Content $cfg -Raw | ConvertFrom-Json
    L ("WT defaultProfile guid: " + $s.defaultProfile)
    L ("WT bellStyle: " + $(if ($null -ne $s.bellStyle) { $s.bellStyle } else { '<unset>' }))
    $pl = if ($s.profiles.list) { $s.profiles.list } else { $s.profiles }
    foreach ($p in $pl) { if ($p.guid -eq $s.defaultProfile) { L ("WT default profile: " + $p.name + " cmd=" + $p.commandline) } }
  } catch { L ("settings read failed: " + $_.Exception.Message) }
}
L ("launch profile: " + $(if ($Profile) { $Profile } else { '<default> (no --profile)' }))
Start-Process -FilePath 'wt.exe' -ArgumentList $args | Out-Null

$win = $null
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline -and $null -eq $win) {
  Start-Sleep -Milliseconds 400
  foreach ($w in Get-WtWindows) {
    if (-not $before.ContainsKey($w.Current.NativeWindowHandle)) { $win = $w; break }
  }
}
if ($null -eq $win) { L 'FATAL: no new WT window appeared'; $log -join "`n" | Out-File -Encoding utf8 (Join-Path $OutDir 'results.txt'); throw 'no window' }
L ("probe window handle: " + $win.Current.NativeWindowHandle)

# Which processes actually carry the probe's stdout: the pane's real chain.
# MUXTEE_ACTIVE in the child env is inherited from whoever launched wt.exe and
# is NOT evidence that this pane is teed - the chain is.
$leaf = Split-Path $Driver -Leaf
$probe = $null
$deadline = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $deadline -and $null -eq $probe) {
  Start-Sleep -Milliseconds 500
  $probe = Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -match [regex]::Escape($leaf)
  } | Sort-Object CreationDate -Descending | Select-Object -First 1
}
if ($probe) {
  L ("probe process chain (leaf -> root):")
  $cur = $probe
  $depth = 0
  while ($cur -and $depth -lt 8) {
    $cmd = if ($cur.CommandLine) { $cur.CommandLine.Substring(0, [Math]::Min(140, $cur.CommandLine.Length)) } else { '' }
    L ("  {0} {1} :: {2}" -f $cur.ProcessId, $cur.Name, $cmd)
    $cur = Get-CimInstance Win32_Process -Filter "ProcessId=$($cur.ParentProcessId)" -ErrorAction SilentlyContinue
    $depth++
  }
} else { L 'probe process chain: <not found>' }

# In-window tab titles (title canary lands here)
function Get-TabTitles($win) {
  $items = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)))
  $names = @(); foreach ($i in $items) { $names += $i.Current.Name }
  return ($names -join ' | ')
}

function Short([string]$s, [int]$n = 120) {
  if ($null -eq $s) { return '<null>' }
  $clean = $s -replace "`r", '\r' -replace "`n", '\n'
  if ($clean.Length -le $n) { return $clean }
  return ($clean.Substring(0, $n) + ('...[{0} chars]' -f $s.Length))
}
# log lines for the buffer are truncated so a leaked multi-KB payload stays readable
function Trim-Lines([string]$t) {
  $lines = $t -split "`n"
  ($lines | ForEach-Object { if ($_.Length -gt 200) { $_.Substring(0,200) + ('...[{0}]' -f $_.Length) } else { $_.TrimEnd() } }) -join "`n"
}

$lastClip = Get-Clipboard -Format Text -Raw -ErrorAction SilentlyContinue
$lastText = ''
$snapN = 0
$done = $false
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  $t = Get-VisibleText $win
  if ($null -ne $t -and $t -ne $lastText) {
    $snapN++
    L ("`n===== SNAPSHOT {0} @ {1:HH:mm:ss.fff} (chars={2}) =====" -f $snapN, (Get-Date), $t.Length)
    L (Trim-Lines $t)
    $lastText = $t
  }
  $c = Get-Clipboard -Format Text -Raw -ErrorAction SilentlyContinue
  if ($c -ne $lastClip) {
    L ("`n[CLIPBOARD CHANGED @ {0:HH:mm:ss.fff}] len={1} head='{2}' tail='{3}'" -f (Get-Date), $c.Length, (Short $c 24), (Short $(if ($c.Length -gt 24) { $c.Substring($c.Length - 24) } else { '' }) 24))
    $lastClip = $c
  }
  $tabs = Get-TabTitles $win
  if ($tabs -ne $script:lastTabs) { L ("`n[TAB TITLES @ {0:HH:mm:ss.fff}] {1}" -f (Get-Date), $tabs); $script:lastTabs = $tabs }
  if ($lastText -match 'ALL-DONE') { $done = $true; break }
}
L ("`ndone=" + $done)

# toast / notification windows carrying the payload token
Start-Sleep -Milliseconds 1500
$hits = @()
foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
  if ($w.Current.Name -match 'OSCPROBE') { $hits += ($w.Current.ClassName + ' :: ' + $w.Current.Name) }
}
L ("`n[TOP-LEVEL WINDOWS MATCHING OSCPROBE] " + ($(if ($hits.Count) { $hits -join ' ;; ' } else { 'none' })))

$fc = Get-Clipboard -Format Text -Raw -ErrorAction SilentlyContinue
L ("`n[FINAL CLIPBOARD] len={0} head='{1}'" -f $fc.Length, (Short $fc 24))

# Screenshot cropped to the probe window only (colour/visual symptom).
try {
  Add-Type -AssemblyName System.Drawing
  if (-not ('Win32Probe' -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Probe {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
"@
  }
  $h = [IntPtr]$win.Current.NativeWindowHandle
  [Win32Probe]::ShowWindow($h, 9) | Out-Null
  [Win32Probe]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 900
  $r = New-Object Win32Probe+RECT
  [Win32Probe]::GetWindowRect($h, [ref]$r) | Out-Null
  $bw = $r.Right - $r.Left
  $bh = $r.Bottom - $r.Top
  $bmp = New-Object System.Drawing.Bitmap($bw, $bh)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
  $png = Join-Path $OutDir 'screen.png'
  $bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  L ("screenshot: $png ($bw x $bh)")
} catch { L ("screenshot failed: " + $_.Exception.Message) }

if ($Close) {
  $wp = $null
  if ($win.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$wp)) {
    $wp.Close(); L 'probe window closed'
  }
}
$log -join "`n" | Out-File -Encoding utf8 (Join-Path $OutDir 'results.txt')
L ("results written to " + (Join-Path $OutDir 'results.txt'))
$log -join "`n"
