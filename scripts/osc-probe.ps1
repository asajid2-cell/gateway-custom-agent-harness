# OSC survival probe driver (v2). Runs INSIDE a Windows Terminal tab.
# Emits each private/control sequence byte-exactly, then a sentinel + ruler line
# so any leak, swallowing or reflow is visible in the terminal buffer.
# Evidence is collected from OUTSIDE this process (UIA text of the WT buffer,
# clipboard, tab titles) by osc-probe-run.ps1.

$ErrorActionPreference = 'Stop'
$out = [Console]::OpenStandardOutput()
$enc = New-Object System.Text.UTF8Encoding($false)

function Emit([string]$s) {
  $b = $enc.GetBytes($s)
  $out.Write($b, 0, $b.Length)
  $out.Flush()
}
function EmitBytes([int[]]$bytes) {
  $b = [byte[]]$bytes
  $out.Write($b, 0, $b.Length)
  $out.Flush()
}
function Case-Seq([string]$id, [int[]]$payload, [int[]]$terminator) {
  Emit "`nMARK $id BEGIN`n"
  EmitBytes ($payload + $terminator)
  Emit "MARK $id SENTINEL`n"
  Emit ("{0}-RULER-{1}`n" -f $id, ('0123456789' * 6))
  Start-Sleep -Milliseconds 1200
}

$ESC = 27
$BEL = 7
$ST = @($ESC, 92)          # ESC \
$BELT = @($BEL)
function OSC([string]$body) { @($ESC, 93) + [System.Text.Encoding]::ASCII.GetBytes($body) }  # ESC ]
function B64([string]$s) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)) }

Emit "OSCPROBE v2 START`n"
Emit ("RULER-TOP-{0}`n" -f ('0123456789' * 6))
Start-Sleep -Milliseconds 600

# --- framing canaries: OSC that WT IS expected to act on -------------------
Case-Seq 'C1-TITLE-ST'  (OSC '2;OSCPROBE-TITLE-ST')  $ST
Case-Seq 'C2-TITLE-BEL' (OSC '2;OSCPROBE-TITLE-BEL') $BELT
Case-Seq 'D1-CLIP-ST'   (OSC ('52;c;' + (B64 'OSCPROBE-CLIP-ST')))  $ST

# --- split across THREE writes, 400ms apart (does the terminal reassemble?) --
Emit "`nMARK H1-SPLIT BEGIN`n"
EmitBytes (OSC '2;OSCPROBE-SPLIT')
Start-Sleep -Milliseconds 400
EmitBytes ([Text.Encoding]::ASCII.GetBytes('-MID'))
Start-Sleep -Milliseconds 400
EmitBytes $BELT
Emit "MARK H1-SPLIT SENTINEL`n"
Emit ("H1-SPLIT-RULER-{0}`n" -f ('0123456789' * 6))
Start-Sleep -Milliseconds 1200

# --- inline interleave: does an OSC between two text runs stay invisible? --
Emit "`nMARK F1-INLINE BEGIN`n"
Emit 'INLINE-BEFORE|'
EmitBytes ((OSC '1337;InlineProbe') + $ST)
Emit '|INLINE-AFTER`n'.Replace('`n', "`n")
Emit ("F1-INLINE-RULER-{0}`n" -f ('0123456789' * 6))
Start-Sleep -Milliseconds 1200

# --- a) OSC 1337 (iTerm2 proprietary) -------------------------------------
Case-Seq 'A1-1337-ST'   (OSC '1337;File=name=b3NjLXByb2Jl;inline=1:QUJD')  $ST
Case-Seq 'A2-1337-BEL'  (OSC '1337;OSCPROBELABELA2')                        $BELT

# --- b) OSC 9 with NON-numeric payload (notification-ish) -----------------
Case-Seq 'B1-OSC9-ST'   (OSC '9;OSCPROBELABELB1 hello element map')        $ST
Case-Seq 'B2-OSC9-BEL'  (OSC '9;OSCPROBELABELB2 hello element map')        $BELT
Case-Seq 'B3-OSC9-PROG' (OSC '9;4;1;42')                                   $BELT

# --- realistic element-map sized payload, both terminators ----------------
$mapJson = '{"v":1,"n":[{"i":"n1","r":[0,0,80,1],"role":"header","l":"claude"},{"i":"n2","r":[0,1,80,20],"role":"body","l":"hello world"}]}'
$b64 = B64 $mapJson
Case-Seq 'E1-MAP-ST'    (OSC ('1337;ElementMap=' + $b64))  $ST
Case-Seq 'E2-MAP-BEL'   (OSC ('1337;ElementMap=' + $b64))  $BELT

# --- size sweep: OSC 1337 with N 'G' bytes; a leak would show as G-runs ----
foreach ($n in 512, 2048, 4096, 8192, 16384, 65536) {
  Case-Seq ("G$n-1337-ST") (OSC ('1337;SizeProbe=' + ('G' * $n))) $ST
}

# --- size sweep with an ACTIONABLE canary: OSC 52 N bytes -> clipboard -----
foreach ($n in 512, 2048, 8192, 32768) {
  Case-Seq ("K$n-CLIP-ST") (OSC ('52;c;' + (B64 ('K' * $n)))) $ST
}

Emit "`nOSCPROBE v2 ALL-DONE`n"
Emit ("RULER-BOTTOM-{0}`n" -f ('0123456789' * 6))
while ($true) { Start-Sleep -Seconds 60 }
