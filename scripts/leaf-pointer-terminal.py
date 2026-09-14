"""Compiled ConPTY leaf UX acceptance against a local-only model fixture."""
import argparse
import base64
import json
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import pyte
import psutil
from winpty import PtyProcess

parser = argparse.ArgumentParser()
parser.add_argument('cli', type=Path)
parser.add_argument('--fullscreen', action='store_true')
parser.add_argument('--mux-report-filter', action='store_true')
parser.add_argument('--standard-cpr-only', action='store_true')
parser.add_argument('--probe-full-tui', action='store_true')
parser.add_argument('--probe-lifecycle', action='store_true')
parser.add_argument('--probe-selection', action='store_true')
parser.add_argument('--probe-parity', action='store_true')
parser.add_argument('--columns', type=int, default=120)
parser.add_argument('--rows', type=int, default=40)
args = parser.parse_args()
root = Path(tempfile.mkdtemp(prefix='leaf-pointer-'))
requests = []
processes = []
blocked_turns = {name: threading.Event() for name in ('LEAF_BLOCKED_TASK', 'ROOT_BLOCKED_TASK')}
started_turns = set()
finished_turns = set()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        messages = body.get('messages', [])
        latest = json.dumps(messages[-1].get('content', '') if messages else '')
        marker = next((value for value in ('FRESH_ONLY_TASK', 'FORK_ONLY_TASK', 'ROOT_CONTEXT_CAFE_', 'LEAF_BLOCKED_TASK', 'ROOT_BLOCKED_TASK', 'PERMISSION_TASK', 'PLAN_TASK', 'MONITOR_TASK') if value in latest), 'BACKGROUND')
        if marker != 'BACKGROUND': requests.append(body)
        if marker in blocked_turns:
            started_turns.add(marker)
            if not blocked_turns[marker].wait(75): return
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        frames = [
            dict(type='message_start', message=dict(id='msg_' + uuid.uuid4().hex, type='message', role='assistant', model='claude-sonnet-4-6', content=[], stop_reason=None, stop_sequence=None, usage=dict(input_tokens=100, output_tokens=0))),
            dict(type='content_block_start', index=0, content_block=dict(type='text', text='')),
            dict(type='content_block_delta', index=0, delta=dict(type='text_delta', text='FIXTURE_REPLY_' + marker)),
            dict(type='content_block_stop', index=0),
            dict(type='message_delta', delta=dict(stop_reason='end_turn', stop_sequence=None), usage=dict(output_tokens=20)),
            dict(type='message_stop'),
        ]
        if marker == 'PERMISSION_TASK':
            tools = {tool['name'] for tool in body.get('tools', [])}
            tool_name = 'Write' if 'Write' in tools else 'write'
            assert tool_name in tools, 'Normal interactive tools not exposed'
            frames[1] = dict(type='content_block_start', index=0, content_block=dict(type='tool_use', id='tool_permission_fixture', name=tool_name, input={}))
            frames[2] = dict(type='content_block_delta', index=0, delta=dict(type='input_json_delta', partial_json=json.dumps(dict(file_path=str(root / 'approved-leaf.txt'), content='APPROVED_LEAF_ONLY'))))
            frames[4]['delta']['stop_reason'] = 'tool_use'
        # The tool set is only reduced on auxiliary requests (title, quota),
        # which replay the same last user message. Those get a plain reply
        # rather than a tool call, so they never 500 the fixture.
        if marker == 'PLAN_TASK':
            tools = {tool['name'] for tool in body.get('tools', [])}
            if 'ExitPlanMode' in tools:
                path = plan_path(body)
                assert path, 'Plan-mode attachment surfaced no plan file path'
                Path(path).write_text('# Fixture plan\n\n1. Do the local fixture thing.\n', encoding='utf-8')
                frames[1] = dict(type='content_block_start', index=0, content_block=dict(type='tool_use', id='tool_plan_fixture', name='ExitPlanMode', input={}))
                frames[2] = dict(type='content_block_delta', index=0, delta=dict(type='input_json_delta', partial_json='{}'))
                frames[4]['delta']['stop_reason'] = 'tool_use'
        if marker == 'MONITOR_TASK':
            tools = {tool['name'] for tool in body.get('tools', [])}
            tool_name = next((name for name in ('Bash', 'bash') if name in tools), None)
            if tool_name:
                frames[1] = dict(type='content_block_start', index=0, content_block=dict(type='tool_use', id='tool_monitor_fixture', name=tool_name, input={}))
                frames[2] = dict(type='content_block_delta', index=0, delta=dict(type='input_json_delta', partial_json=json.dumps(dict(command='sleep 90', description='Local fixture background task', run_in_background=True))))
                frames[4]['delta']['stop_reason'] = 'tool_use'
        for frame in frames:
            self.wfile.write(('event: ' + frame['type'] + '\ndata: ' + json.dumps(frame) + '\n\n').encode())
        self.wfile.flush()
        finished_turns.add(marker)

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()

# OSC 52 clipboard write: ESC ] 52 ; c ; <base64> (BEL | ST). osc() picks BEL
# for every terminal except kitty, but the alias is free to accept both.
OSC52_RE = re.compile(r'\x1b\]52;c;([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)')

# The plan-mode attachment is the only place the plan file path is named, and
# the ExitPlanMode dialog reads the plan back off disk at render time. So the
# fixture has to recover the path from the request it is answering: an empty
# or missing file would take the dialog's empty-plan branch and never render
# the options this probe is asserting on.
PLAN_PATH_RE = re.compile(r'your plan at (.+?) using|plan file already exists at (.+?)\.')

def plan_path(body):
    stack = [body]
    while stack:
        value = stack.pop()
        if isinstance(value, str):
            match = PLAN_PATH_RE.search(value)
            if match: return match.group(1) or match.group(2)
        elif isinstance(value, dict): stack.extend(value.values())
        elif isinstance(value, list): stack.extend(value)
    return None

class Screen(pyte.Screen):
    reply = lambda self, text: None
    def report_device_status(self, mode, **kwargs):
        if mode == 6:
            if args.mux_report_filter and not kwargs.get('private'): return
            if args.standard_cpr_only and kwargs.get('private'): return
            private = '?' if kwargs.get('private') else ''
            self.reply(f'\x1b[{private}{self.cursor.y + 1};{self.cursor.x + 1}R')
    def report_device_attributes(self, mode=0, **kwargs):
        self.reply('\x1b[?1;2c')

class Terminal:
    def __init__(self, session_id=None, permission_mode=None, env_extra=None):
        self.id = session_id or str(uuid.uuid4())
        self.chunks = queue.Queue(maxsize=256)
        self.screen = Screen(args.columns, args.rows)
        self.stream = pyte.Stream(self.screen)
        self.output = ''
        env = {key: os.environ[key] for key in ('PATH', 'SystemRoot', 'TEMP', 'TMP', 'COMSPEC') if key in os.environ}
        url = f'http://127.0.0.1:{server.server_port}'
        env.update(HOME=str(root), USERPROFILE=str(root), CLAUDE_CONFIG_DIR=str(root), ANTHROPIC_AUTH_TOKEN='local-fixture-only', ANTHROPIC_BASE_URL=url, CLAUDE_CODE_GATEWAY_BASE_URL=url, CLAUDE_CODE_USE_GATEWAY='1', CLAUDE_CODE_NO_FLICKER='1' if args.fullscreen else '0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1', DISABLE_TELEMETRY='1', DISABLE_ERROR_REPORTING='1', NODE_ENV='production')
        env.update(env_extra or {})
        cli_args = [shutil.which('bun'), str(args.cli.resolve()), '--resume' if session_id else '--session-id', self.id, '--model', 'claude-sonnet-4-6']
        if permission_mode: cli_args += ['--permission-mode', permission_mode]
        self.proc = PtyProcess.spawn(subprocess.list2cmdline(cli_args), cwd=str(root), env=env, dimensions=(args.rows, args.columns))
        self.owned = {self.proc.pid: psutil.Process(self.proc.pid)}
        processes.append(self)
        self.screen.reply = self.proc.write
        def drain():
            try:
                while self.proc.isalive(): self.chunks.put(self.proc.read(65536))
            except (EOFError, OSError): pass
        threading.Thread(target=drain, daemon=True).start()
    def capture_owned(self):
        for process in list(self.owned.values()):
            try:
                if process.is_running():
                    for child in process.children(recursive=True): self.owned[child.pid] = child
            except psutil.NoSuchProcess: pass
    def pump(self):
        while True:
            try:
                chunk = self.chunks.get_nowait()
                self.output = (self.output + chunk)[-262144:]
                self.stream.feed(chunk)
            except queue.Empty: return
    def wait(self, predicate, label, timeout=30):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            self.pump()
            if predicate(): return
            time.sleep(.03)
        (root / 'screen.txt').write_text('\n'.join(self.screen.display), encoding='utf-8')
        (root / 'terminal-output.txt').write_text(self.output, encoding='utf-8')
        raise AssertionError(label + ' (screen saved locally)')
    def pause(self, seconds=.2):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            self.pump(); time.sleep(.02)
    def text(self): return '\n'.join(self.screen.display)
    def submit(self, text):
        self.capture_owned()
        self.proc.write('\x1b[200~' + text + '\x1b[201~'); self.pause(.5); self.proc.write('\r')
    def point(self, label):
        self.pause(.6)
        def matches():
            return [(line.index(label) + 1, row + 1) for row, line in enumerate(self.screen.display) if label in line and (label != 'Original' or line.strip(' │') == label)]
        self.wait(lambda: bool(matches()), 'visible ' + label)
        return matches()[-1]
    def click(self, label, hold=False):
        x, y = self.point(label)
        self.proc.write(f'\x1b[<0;{x};{y}M'); self.pause(.6 if hold else .08)
        self.proc.write(f'\x1b[<0;{x};{y}m'); self.pause(.25)
    def wheel(self, label, down):
        x, y = self.point(label)
        self.proc.write(f'\x1b[<{65 if down else 64};{x};{y}M'); self.pause(.3)
    def drag(self, start, end):
        """Press at start, move with the button held (mode 1002, SGR bit
        0x20), release at end. Mirrors what an emulator sends for a text
        selection: the initial press is button 0 with no motion bit, and the
        intermediate motions are what extend the selection. Sending the press
        already carrying 0x20 would be read as motion-with-no-anchor, which
        selects nothing."""
        self.proc.write(f'\x1b[<0;{start[0]};{start[1]}M'); self.pause(.25)
        for step in (1, 2, 3):
            x = round(start[0] + (end[0] - start[0]) * step / 3)
            y = round(start[1] + (end[1] - start[1]) * step / 3)
            self.proc.write(f'\x1b[<32;{x};{y}M'); self.pause(.15)
        self.proc.write(f'\x1b[<0;{end[0]};{end[1]}m'); self.pause(.5)
    def clipboard_writes(self):
        """OSC 52 payloads the app has written to stdout. Only the raw
        sequence is observable here: on Windows getClipboardPath() is
        'osc52', so setClipboard returns the escape and copySelectionNoClear
        writes it straight out."""
        return OSC52_RE.findall(self.output)
    def family(self):
        path = root / 'leaf-families' / (self.id + '.json')
        try:
            self.last_family = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {'members': []}
        except PermissionError:
            return getattr(self, 'last_family', {'members': []})
        return self.last_family
    def original(self):
        self.click('All ' + str(sum(member['status'] == 'open' for member in self.family()['members']) + 1))
        self.click('Original')
        self.wait(lambda: self.id[:8] in self.text(), 'original prompt restored')
        self.pause(.5)
    def leaf(self, index, permission=False):
        self.click('All ' + str(sum(member['status'] == 'open' for member in self.family()['members']) + 1))
        member = self.family()['members'][index]
        self.click(str(member['number']) + ' ' + member['name'] + ' [')
        self.wait(lambda: ('Do you want to create approved-leaf.txt?' in self.text()) if permission else member['sessionId'][:8] in self.text(), 'selected leaf UI')
    def resize(self, columns, rows):
        self.screen.resize(lines=rows, columns=columns)
        self.proc.setwinsize(rows, columns)
        self.pause(.8)
    def exit(self):
        self.submit('/exit')
        self.wait(lambda: not self.proc.isalive(), 'graceful root exit')
        _, alive = psutil.wait_procs(list(self.owned.values()), timeout=10)
        assert not alive, 'Graceful exit left owned processes: ' + str([p.pid for p in alive])
        self.wait(lambda: not list((root / 'gateway-writers').glob('*.lock')), 'all fixture writer locks released')
        self.wait(lambda: not list((root / 'projects').rglob('*.leaf-owner.lock')), 'all leaf owner locks released')

def probe_full_tui():
    t = Terminal()
    t.wait(lambda: 'All 1' in t.text(), 'initial normal session', 60)
    t.submit('/leaf new FullSession')
    t.wait(lambda: len(t.family()['members']) == 1 and 'All 2' in t.text(), 'leaf created', 75)
    leaf_id = t.family()['members'][0]['sessionId']
    t.wait(lambda: leaf_id[:8] in t.text() and 'session:' in t.text(), 'leaf must show its own normal session footer', 75)
    t.click('✎ Rename')
    t.wait(lambda: 'Session metadata' in t.text(), 'leaf must open normal session metadata dialog')
    t.proc.write('\x1b'); t.pause()
    t.submit('/model')
    t.wait(lambda: 'Select model' in t.text() or 'Choose model' in t.text(), 'leaf must run normal model command')
    t.pause(.8)
    t.proc.write('\x1b'); t.pause(.8)
    t.wait(lambda: 'Select model' not in t.text(), 'model command dismissed')
    t.original()
    t.proc.write('ROOT_UNSENT'); t.pause()
    t.leaf(0)
    assert 'ROOT_UNSENT' not in t.text(), 'Root draft leaked into leaf'
    # Wait for the draft to render before pressing Tab: a fixed pause raced the
    # pane's repaint and read as "Tab lost the draft" (and it never actually
    # checked the draft was there to begin with).
    t.proc.write('LEAF_UNSENT')
    t.wait(lambda: 'LEAF_UNSENT' in t.text(), 'leaf draft visible before Tab', 10)
    t.proc.write('\t'); t.pause()
    t.wait(lambda: 'LEAF_UNSENT' in t.text(), 'Tab switched away or lost draft', 3)
    t.original()
    t.wait(lambda: 'ROOT_UNSENT' in t.text() and 'LEAF_UNSENT' not in t.text(), 'Root draft was not retained independently')
    t.leaf(0)
    t.wait(lambda: 'LEAF_UNSENT' in t.text(), 'Leaf draft lost on switch', 10)
    t.proc.write('\x15'); t.pause()
    t.submit('LEAF_BLOCKED_TASK')
    t.wait(lambda: 'LEAF_BLOCKED_TASK' in started_turns, 'leaf turn starts')
    t.original()
    t.proc.write('\x15'); t.pause()
    t.submit('ROOT_BLOCKED_TASK')
    t.wait(lambda: len(started_turns) == 2, 'root runs while leaf remains busy')
    blocked_turns['LEAF_BLOCKED_TASK'].set()
    t.wait(lambda: 'LEAF_BLOCKED_TASK' in finished_turns, 'background leaf completes')
    t.pause(.8)
    assert 'FIXTURE_REPLY_LEAF_BLOCKED_TASK' not in t.text(), 'Background leaf overwrote root terminal'
    t.leaf(0)
    t.wait(lambda: 'FIXTURE_REPLY_LEAF_BLOCKED_TASK' in t.text(), 'background leaf result restored')
    blocked_turns['ROOT_BLOCKED_TASK'].set()
    t.wait(lambda: 'ROOT_BLOCKED_TASK' in finished_turns, 'background original completes')
    t.pause(.8)
    assert 'FIXTURE_REPLY_ROOT_BLOCKED_TASK' not in t.text(), 'Background original overwrote leaf terminal'
    t.submit('PERMISSION_TASK')
    t.wait(lambda: 'approved-leaf.txt' in t.text() and ('Yes' in t.text() or 'Allow' in t.text()), 'normal tool permission dialog')
    assert not (root / 'approved-leaf.txt').exists(), 'Leaf bypassed its permission'
    t.original()
    t.wait(lambda: 'FIXTURE_REPLY_ROOT_BLOCKED_TASK' in t.text(), 'background root result restored')
    assert not (root / 'approved-leaf.txt').exists(), 'Switching approved a tool without consent'
    t.leaf(0, permission=True)
    t.wait(lambda: 'approved-leaf.txt' in t.text(), 'permission survives switching')
    t.proc.write('\r')
    t.wait(lambda: (root / 'approved-leaf.txt').exists(), 'normal leaf tool executes after approval')
    assert (root / 'approved-leaf.txt').read_text() == 'APPROVED_LEAF_ONLY'
    t.wait(lambda: 'FIXTURE_REPLY_BACKGROUND' in t.text(), 'tool result turn completes')
    t.resize(60, 28)
    t.wait(lambda: 'All 2' in t.text() and 'session:' in t.text(), 'selected full UI resizes')
    t.resize(args.columns, args.rows)
    t.original()
    t.exit()
    print(json.dumps(dict(fullInteractiveTui=True, leafId=leaf_id, isolatedDrafts=True, concurrentTurns=True, permissionRoundtrip=True, resize=True)), flush=True)

def probe_selection():
    """App-owned text selection must work everywhere the user can put the
    pointer, not just on transcript cells with no handler underneath.

    A press over a Button or an onClick Box is dispatched as a click and
    consumed, so the selection machinery used to never see the press: the
    anchor stayed null, every drag motion no-opped, and only plain
    transcript text was selectable. seedPressSelection() seeds the anchor
    for consumed presses, which makes these three surfaces behave like
    native text: drag selects, a bare click does not."""
    t = Terminal()
    t.wait(lambda: 'All 1' in t.text(), 'initial session', 60)
    t.submit('ROOT_CONTEXT_CAFE_世界')
    t.wait(lambda: 'FIXTURE_REPLY_ROOT_CONTEXT_CAFE_' in t.text(), 'root reply')
    t.submit('/leaf fork original ForkOne')
    t.wait(lambda: len(t.family()['members']) == 1 and t.family()['members'][0]['sessionId'][:8] in t.text(), 'fork created', 75)
    t.original()
    t.wait(lambda: 'session:' in t.text(), 'original restored')

    def last_copied(since, label):
        t.wait(lambda: len(t.clipboard_writes()) > since, label)
        return base64.b64decode(t.clipboard_writes()[-1]).decode('utf-8', 'replace')

    def right_of(point, width):
        return (min(args.columns - 1, point[0] + width), point[1])

    # Control: transcript text has no pointer target, so this path already
    # worked. It stays green if the anchor-seeding change is a no-op here.
    before = len(t.clipboard_writes())
    anchor = t.point('FIXTURE_REPLY_ROOT_CONTEXT_CAFE_')
    t.drag(anchor, right_of(anchor, 40))
    text = last_copied(before, 'transcript drag copied')
    assert 'FIXTURE_REPLY_ROOT_CONTEXT_CAFE_' in text, 'Transcript drag selected the wrong text: ' + repr(text)

    # Bottom bar, on a Button: ✎ Rename is a pointer target, so its press used
    # to be consumed as a click and the drag extended nothing. Selecting it
    # must not open the dialog the click would have opened.
    before = len(t.clipboard_writes())
    button = t.point('✎ Rename')
    t.drag(button, right_of(button, 7))
    text = last_copied(before, 'bottom bar button drag copied')
    assert 'Rename' in text, 'Bottom bar drag selected the wrong text: ' + repr(text)
    assert 'Session metadata' not in t.text(), 'Dragging across a button activated it'

    # Bottom bar, the session resume command — the thing the user copies out
    # of the bottom bar.
    before = len(t.clipboard_writes())
    resume = t.point('session:')
    t.drag(resume, right_of(resume, 12))
    text = last_copied(before, 'resume command drag copied')
    assert 'session:' in text, 'Resume command drag selected the wrong text: ' + repr(text)

    # Prompt box: click-to-position-cursor makes the input an onClick Box.
    t.proc.write('PROMPT_SELECT_TEXT'); t.pause(.5)
    before = len(t.clipboard_writes())
    field = t.point('PROMPT_SELECT_TEXT')
    t.drag(field, right_of(field, 20))
    text = last_copied(before, 'prompt box drag copied')
    assert 'PROMPT_SELECT_TEXT' in text, 'Prompt box drag selected the wrong text: ' + repr(text)
    t.proc.write('\x15'); t.pause(.4)

    # A bare click must stay a click: the anchor is seeded but focus is not,
    # so nothing is selected and nothing reaches the clipboard. Twice in a
    # row, because the first click leaves an unfinished anchor behind and the
    # second proves that state does not swallow the next press.
    before = len(t.clipboard_writes())
    for attempt in (1, 2):
        t.click('✎ Rename')
        t.wait(lambda: 'Session metadata' in t.text(), f'button click {attempt} still activates')
        assert len(t.clipboard_writes()) == before, f'Click {attempt} produced a spurious selection copy'
        t.proc.write('\x1b'); t.pause()
        t.wait(lambda: 'Session metadata' not in t.text(), f'rename dialog {attempt} dismissed')
    t.exit()
    print(json.dumps(dict(selection=True, transcriptSelection=True, bottomBarSelection=True, promptSelection=True, bareClickNoCopy=True, clickStillWorks=True)), flush=True)

def probe_parity():
    """Behaviors an ordinary inline gateway session has to reach on its own.

    The inline lane renders the same tree as the alt screen, so each of these
    worked in fullscreen and silently did nothing inline: the background-task
    pill looked clickable and swallowed the click, the plan-exit options
    scrolled away with the plan, and the tmux wheel hint never fired. All
    three are isBoundedLayoutEnabled() call sites - asking
    isFullscreenEnvEnabled() excludes the inline lane even though it renders
    the same bounded layout. Every assertion below fails on the old
    predicate, in the inline run this probe defaults to.
    """
    evidence = {}

    # These lanes run under bypass permissions, but the CLI gates the mode
    # behind a one-time acceptance prompt on a fresh config home. Accept it up
    # front so the probe measures the pill and not that dialog.
    (root / 'settings.json').write_text(json.dumps(dict(skipDangerousModePermissionPrompt=True)), encoding='utf-8')

    # 1. The footer pill is a pointer target. run_in_background produces a
    #    real local_bash task, so the pill renders '1 shell'; clicking it
    #    must open the dialog rather than being dropped on the floor.
    t = Terminal(permission_mode='bypassPermissions')
    t.wait(lambda: 'All 1' in t.text(), 'initial session', 60)
    t.submit('MONITOR_TASK')
    t.wait(lambda: '1 shell' in t.text(), 'background task pill renders inline')
    t.click('1 shell')
    # A lone running task skips the list and opens its own detail view, so
    # accept either title; with the click dropped there is no dialog at all.
    t.wait(lambda: 'Shell details' in t.text() or 'Background tasks' in t.text(), 'pill click opens the background task UI')
    evidence['backgroundTaskPillClick'] = True
    t.proc.write('x'); t.pause(1.2)
    t.proc.write('\x1b'); t.pause(.8)
    t.wait(lambda: 'Shell details' not in t.text() and 'Background tasks' not in t.text(), 'background task UI dismissed')
    t.exit()

    # 2. Exit-plan options stay pinned inline. The sticky path puts the short
    #    'Would you like to proceed?' in FullscreenLayout's bottom slot; the
    #    non-sticky fallback puts 'ready to execute. Would you like to
    #    proceed?' in the scrolling body instead. ENABLE_TOOL_SEARCH=false is
    #    the documented escape hatch that turns off deferral and exposes
    #    ExitPlanMode's schema inline; the default 'tst' mode defers it behind
    #    ToolSearchTool, which would otherwise put a second model round trip in
    #    front of the dialog this probe is about.
    p = Terminal(permission_mode='plan', env_extra=dict(ENABLE_TOOL_SEARCH='false'))
    p.wait(lambda: 'All 1' in p.text(), 'plan-mode session', 60)
    p.submit('PLAN_TASK')
    p.wait(lambda: 'ready to execute' in p.text() or 'Would you like to proceed?' in p.text(), 'plan-exit permission dialog', 60)
    assert 'ready to execute' not in p.text(), 'plan-exit options rendered in the scrolling body instead of the pinned footer'
    evidence['planOptionsPinned'] = True
    p.proc.write('\x1b'); p.pause(.6)
    p.wait(lambda: 'Would you like to proceed?' not in p.text(), 'plan-exit dialog dismissed')
    p.exit()

    # 3. The tmux 'mouse off' hint fires inline. Only `show -Av mouse` is
    #    reached: TERM_PROGRAM is set and is not iTerm's, so
    #    probeTmuxControlModeSync() takes its early return and spawns
    #    nothing. Empty stdout means the option is off, which is the case
    #    the hint exists for.
    fake = root / 'fake-tmux'
    fake.mkdir(exist_ok=True)
    (fake / 'tmux.cmd').write_text('@echo off\r\nexit /b 0\r\n', encoding='ascii')
    m = Terminal(env_extra=dict(TMUX='/tmp/parity-fixture', TERM_PROGRAM='tmux', TERM='screen-256color', PATH=str(fake) + os.pathsep + os.environ.get('PATH', '')))
    m.wait(lambda: 'tmux detected' in m.text(), 'tmux wheel hint fires inline', 60)
    evidence['tmuxMouseHint'] = True
    m.exit()

    # 4. Shift+Up. scripts/build.ts stubs bun:bundle's feature() to return
    #    false, so feature('MESSAGE_ACTIONS') folds out of the compiled
    #    harness and shift+up resolves to messageSelector:top - the rewind
    #    dialog, not a message-actions bar. Only the keybinding is
    #    observable: the dialog opens on double-Esc from an empty prompt and
    #    must stay open across shift+up inline.
    r = Terminal()
    r.wait(lambda: 'All 1' in r.text(), 'initial session', 60)
    r.submit('ROOT_CONTEXT_CAFE_')
    r.wait(lambda: 'FIXTURE_REPLY_ROOT_CONTEXT_CAFE_' in r.text(), 'root reply')
    r.proc.write('\x1b'); r.pause(.15); r.proc.write('\x1b')
    r.wait(lambda: 'Rewind' in r.text(), 'rewind dialog opens inline')
    assert 'Nothing to rewind to yet.' not in r.text(), 'rewind dialog did not see the prior prompt'
    r.proc.write('\x1b[1;2A'); r.pause(.5)
    assert 'Rewind' in r.text(), 'shift+up dismissed the rewind dialog'
    evidence['rewindDialogInline'] = True
    r.proc.write('\x1b'); r.pause(.4)
    r.exit()

    print(json.dumps(dict(parity=True, fullscreen=args.fullscreen, **evidence)), flush=True)

def probe_lifecycle():
    t = Terminal()
    t.wait(lambda: 'All 1' in t.text(), 'initial session', 60)
    t.submit('ROOT_CONTEXT_CAFE_')
    t.wait(lambda: 'FIXTURE_REPLY_ROOT_CONTEXT_CAFE_' in t.text(), 'root context')
    t.submit('/leaf new Lifecycle')
    t.wait(lambda: len(t.family()['members']) == 1, 'fresh leaf recorded', 75)
    leaf_id = t.family()['members'][0]['sessionId']
    t.wait(lambda: leaf_id[:8] in t.text(), 'full leaf active', 75)
    t.submit('FRESH_ONLY_TASK')
    t.wait(lambda: 'FIXTURE_REPLY_FRESH_ONLY_TASK' in t.text(), 'leaf turn')
    t.submit('/leaf fork original RootCopy')
    t.wait(lambda: len(t.family()['members']) == 2 and t.family()['members'][1]['sessionId'][:8] in t.text(), 'root fork from leaf', 75)
    fork = t.family()['members'][1]
    assert fork['parentSessionId'] == t.id, 'Explicit original fork used the leaf as source'
    t.submit('FORK_ONLY_TASK')
    t.wait(lambda: 'FIXTURE_REPLY_FORK_ONLY_TASK' in t.text(), 'root fork turn')
    assert 'ROOT_CONTEXT_CAFE_' in json.dumps(requests[-1]) and 'FRESH_ONLY_TASK' not in json.dumps(requests[-1]), 'Original fork context incorrect'
    t.submit('/leaf return ' + fork['sessionId'] + ' SELECTED_CONTEXT_NOTE')
    t.wait(lambda: 'Selected leaf context saved' in t.text(), 'context returned from child')
    root_logs = list((root / 'projects').rglob(t.id + '.jsonl'))
    assert len(root_logs) == 1 and 'SELECTED_CONTEXT_NOTE' in root_logs[0].read_text(encoding='utf-8'), 'Return did not persist in original'
    t.submit('/clear')
    t.wait(lambda: len(t.family()['members']) == 3 and t.family()['members'][1]['status'] == 'closed' and t.family()['members'][2]['sessionId'][:8] in t.text(), 'clear updates leaf identity')
    assert t.family()['members'][1]['status'] == 'closed', 'Clear left old identity live'
    cleared = t.family()['members'][2]
    t.original()
    t.leaf(2)
    t.wait(lambda: cleared['sessionId'][:8] in t.text(), 'cleared session selectable')
    t.original()
    t.submit('/leaf close ' + cleared['sessionId'])
    t.wait(lambda: t.family()['members'][2]['status'] == 'closed', 'cleared session closes')
    t.submit('/leaf reopen ' + fork['sessionId'])
    t.wait(lambda: t.family()['members'][1]['status'] == 'open' and 'Leaf reopen recorded' in t.text(), 'original fork reopens', 75)
    t.submit('/leaf model ' + leaf_id + ' claude-haiku-4-5')
    t.wait(lambda: t.family()['members'][0].get('model') == 'claude-haiku-4-5', 'model saved')
    t.pause(.5)
    t.submit('/leaf effort ' + leaf_id + ' high')
    t.wait(lambda: t.family()['members'][0].get('effort') == 'high', 'effort saved')
    t.pause(.5)
    t.leaf(0)
    t.proc.write('SAVED_DRAFT')
    t.wait(lambda: 'SAVED_DRAFT' in t.text(), 'draft visible before switching')
    t.original()
    t.submit('/leaf close ' + leaf_id)
    t.wait(lambda: t.family()['members'][0]['status'] == 'closed' and 'All 2' in t.text(), 'leaf closed')
    assert t.family()['members'][0]['draft'] == 'SAVED_DRAFT', 'Close lost draft'
    t.submit('/leaf reopen ' + leaf_id)
    t.wait(lambda: t.family()['members'][0]['status'] == 'open' and 'All 3' in t.text(), 'leaf reopened', 75)
    t.leaf(0)
    t.wait(lambda: 'SAVED_DRAFT' in t.text() and 'FRESH_ONLY_TASK' in t.text(), 'Reopen lost draft or transcript')
    t.proc.write('\x15'); t.pause()
    t.submit('FRESH_ONLY_TASK_MODEL')
    t.wait(lambda: requests[-1].get('model') == 'claude-haiku-4-5' and 'FIXTURE_REPLY_FRESH_ONLY_TASK' in t.text(), 'reopened model applied')
    t.original()
    t.submit('/leaf goal ' + leaf_id + ' Verify this local fixture goal')
    t.wait(lambda: 'Leaf goal saved' in t.text(), 'leaf goal saved and reopened', 75)
    member = t.family()['members'][0]
    goal_path = Path(member['transcriptPath']).with_suffix('.persist.json')
    assert json.loads(goal_path.read_text(encoding='utf-8'))['task'] == 'Verify this local fixture goal', 'Goal not persisted'
    t.submit('/leaf goal ' + leaf_id + ' pause')
    t.wait(lambda: json.loads(goal_path.read_text(encoding='utf-8'))['status'] == 'paused' and 'All 3' in t.text(), 'goal paused and leaf reopened', 75)
    # `/leaf goal <id> pause` reopens the leaf, which relaunches its child
    # process, and filing is refused until that child is back at its input loop.
    # A fixed pause raced the relaunch, so keep asking while the guard is the
    # only thing refusing the command; the assertions below are unchanged.
    for _ in range(40):
        t.submit('/leaf file ' + leaf_id + ' lifecycle-fixture')
        if t.family()['members'][0]['status'] == 'closed':
            break
    t.wait(lambda: t.family()['members'][0]['status'] == 'closed' and 'All 2' in t.text(), 'leaf filed')
    t.wait(lambda: 'lifecycle-fixture' in Path(member['transcriptPath']).read_text(encoding='utf-8'), 'filed tag persisted')
    t.submit('/leaf promote ' + fork['sessionId'])
    t.wait(lambda: t.family()['members'][1]['status'] == 'promoted' and 'All 1' in t.text(), 'leaf promoted')
    assert Path(fork['transcriptPath']).exists(), 'Promotion removed transcript'
    subprocess.run(['git', 'init', str(root)], check=True, capture_output=True, timeout=15)
    subprocess.run(['git', '-C', str(root), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--allow-empty', '-m', 'Local fixture'], check=True, capture_output=True, timeout=15)
    worktree = root / 'isolated-worktree'
    subprocess.run(['git', '-C', str(root), 'worktree', 'add', '-b', 'fixture-worktree', str(worktree)], check=True, capture_output=True, timeout=15)
    t.submit('/leaf worktree ' + json.dumps(dict(path=str(worktree), name='WorktreeLeaf')))
    t.wait(lambda: len(t.family()['members']) == 4 and t.family()['members'][3]['sessionId'][:8] in t.text(), 'worktree leaf opens', 75)
    worktree_member = t.family()['members'][3]
    assert Path(worktree_member['cwd']).resolve() == worktree.resolve(), 'Leaf cwd not isolated'
    t.submit('FORK_ONLY_TASK_WORKTREE')
    t.wait(lambda: 'FIXTURE_REPLY_FORK_ONLY_TASK' in t.text(), 'worktree fork answers')
    assert 'ROOT_CONTEXT_CAFE_' in json.dumps(requests[-1]), 'Worktree fork lost source context'
    t.original()
    t.submit('/leaf close ' + worktree_member['sessionId'])
    t.wait(lambda: t.family()['members'][3]['status'] == 'closed', 'worktree leaf closes')
    t.submit('/leaf reopen ' + worktree_member['sessionId'])
    t.wait(lambda: 'All 2' in t.text(), 'worktree leaf reopens', 75)
    t.leaf(3)
    t.wait(lambda: 'FORK_ONLY_TASK_WORKTREE' in t.text(), 'worktree history retained')
    t.submit('/branch NativeBranch')
    t.wait(lambda: len(t.family()['members']) == 5 and t.family()['members'][3]['status'] == 'closed' and t.family()['members'][4]['sessionId'][:8] in t.text(), 'native branch updates family identity', 75)
    t.submit('/resume ' + worktree_member['sessionId'])
    t.wait(lambda: t.family()['members'][3]['status'] == 'open' and t.family()['members'][4]['status'] == 'closed' and worktree_member['sessionId'][:8] in t.text(), 'native resume restores family identity', 75)
    t.original()
    t.exit()
    print(json.dumps(dict(lifecycle=True, rootFork=True, modelRestart=True, savedDraft=True, goal=True, filing=True, promotion=True, ownedProcessCleanup=True)), flush=True)

try:
    (root / '.claude.json').write_text(json.dumps(dict(theme='dark', hasCompletedOnboarding=True, projects={root.as_posix(): dict(hasTrustDialogAccepted=True, hasCompletedProjectOnboarding=True)})), encoding='utf-8')
    if args.probe_full_tui or args.probe_lifecycle or args.probe_selection or args.probe_parity:
        (probe_full_tui if args.probe_full_tui else probe_lifecycle if args.probe_lifecycle else probe_selection if args.probe_selection else probe_parity)()
        raise SystemExit(0)
    t = Terminal()
    t.wait(lambda: 'All 1' in t.text(), 'initial carousel', 60)
    t.submit('ROOT_CONTEXT_CAFE_世界')
    t.wait(lambda: len(requests) >= 1 and 'FIXTURE_REPLY_ROOT_CONTEXT_CAFE_' in t.text(), 'root response')
    t.submit('/leaf fork original ForkOne')
    t.wait(lambda: len(t.family()['members']) == 1 and t.family()['members'][0]['sessionId'][:8] in t.text(), 'fork created', 75)
    t.submit('FORK_ONLY_TASK')
    t.wait(lambda: len(requests) >= 2 and 'FIXTURE_REPLY_FORK_ONLY_TASK' in t.text(), 'fork response')
    assert 'ROOT_CONTEXT_CAFE_' in json.dumps(requests[-1]), 'Fork context missing'
    t.click('✎ Rename')
    t.wait(lambda: 'Session metadata' in t.text(), 'normal leaf rename field')
    t.proc.write('\x15'); t.pause(); t.proc.write('RenamedLeaf\r')
    t.wait(lambda: t.family()['members'][0]['name'] == 'RenamedLeaf', 'leaf rename saved')
    t.original()
    t.wait(lambda: 'session:' in t.text(), 'original restored')
    t.submit('/leaf new FreshOne')
    t.wait(lambda: len(t.family()['members']) == 2 and t.family()['members'][1]['sessionId'][:8] in t.text(), 'fresh leaf created', 75)
    t.submit('FRESH_ONLY_TASK')
    t.wait(lambda: len(requests) >= 3 and 'FIXTURE_REPLY_FRESH_ONLY_TASK' in t.text(), 'fresh response')
    assert 'ROOT_CONTEXT_CAFE_' not in json.dumps(requests[-1]), 'Fresh leaf inherited context'
    t.wait(lambda: t.family()['members'][1]['sessionId'][:8] in t.text(), 'fresh turn idle before wheel')
    t.pause(.5)
    t.wheel('2 FreshOne', False)
    t.wait(lambda: t.family()['members'][0]['sessionId'][:8] in t.text(), 'wheel switched leaf')
    t.click('All 3', hold=True)
    t.wait(lambda: 'All sessions' in t.text(), 'hold expanded picker')
    t.click('2 FreshOne [idle]')
    t.wait(lambda: t.family()['members'][1]['sessionId'][:8] in t.text() and 'All sessions' not in t.text(), 'picker switched leaf')
    t.original()
    t.click('✎ Rename')
    t.wait(lambda: 'Session metadata' in t.text(), 'pencil opens root rename')
    t.proc.write('\x15'); t.pause(); t.proc.write('RootRenamed\r')
    t.wait(lambda: 'Session metadata' not in t.text() and 'RootRenamed' in t.text(), 'root rename saved')
    t.pause(.5)
    t.exit()
    resumed = Terminal(t.id)
    resumed.wait(lambda: 'All 3' in resumed.text(), 'restored carousel', 45)
    resumed.click('All 3')
    resumed.click('1 RenamedLeaf [idle]')
    resumed.wait(lambda: 'FORK_ONLY_TASK' in resumed.text(), 'restored leaf history')
    resumed.submit('/leaf')
    resumed.wait(lambda: 'Create a leaf' in resumed.text(), 'creation menu inside leaf')
    resumed.proc.write('MenuFork'); resumed.pause()
    resumed.click('Copy context')
    resumed.wait(lambda: len(resumed.family()['members']) == 3 and resumed.family()['members'][-1]['sessionId'][:8] in resumed.text(), 'menu context fork', 75)
    assert resumed.family()['members'][-1]['parentSessionId'] == resumed.family()['members'][0]['sessionId'], 'Menu fork ancestry'
    resumed.submit('/leaf')
    resumed.wait(lambda: 'Create a leaf' in resumed.text(), 'new-chat menu inside leaf')
    resumed.proc.write('MenuFresh\r')
    resumed.wait(lambda: len(resumed.family()['members']) == 4 and resumed.family()['members'][-1]['sessionId'][:8] in resumed.text(), 'menu fresh chat', 75)
    assert resumed.family()['members'][-1]['forkMessageId'] is None, 'Menu new copied context'
    print(json.dumps(dict(fullscreen=args.fullscreen, columns=args.columns, rows=args.rows, forkContext=True, freshIsolation=True, clickSwitch=True, wheelSwitch=True, holdPicker=True, rootRename=True, leafRename=True, restoredHistory=True, creationMenu=True, modelRequests=len(requests))), flush=True)
finally:
    for gate in blocked_turns.values(): gate.set()
    for terminal in processes:
        terminal.capture_owned()
        owned = list(terminal.owned.values())
        for child in reversed(owned):
            try:
                if child.is_running(): child.terminate()
            except psutil.NoSuchProcess: pass
        _, alive = psutil.wait_procs(owned, timeout=10)
        for child in alive:
            try: child.kill()
            except psutil.NoSuchProcess: pass
        _, alive = psutil.wait_procs(alive, timeout=5)
        assert not alive, 'Owned terminal fixture processes did not exit'
    server.shutdown(); server.server_close()
    print('EVIDENCE_DIRECTORY=' + str(root), flush=True)
