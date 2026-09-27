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
parser.add_argument('--probe-parentage', action='store_true')
parser.add_argument('--columns', type=int, default=120)
parser.add_argument('--rows', type=int, default=40)
args = parser.parse_args()
root = Path(tempfile.mkdtemp(prefix='leaf-pointer-'))
requests = []
processes = []
blocked_turns = {name: threading.Event() for name in ('LEAF_BLOCKED_TASK', 'ROOT_BLOCKED_TASK')}
started_turns = set()
finished_turns = set()
# Where a view-tag keystroke landed, in arrival order. See Terminal.typed_in.
arrivals = []

def session_of(body):
    """The session a request belongs to, as the app itself stamps it.

    Every model request carries metadata.user_id, a JSON string holding the
    session id of the REPL that sent it (services/api/claude.ts). That is the
    ground truth for "which session is this", and it is available for a leaf
    exactly as for the root - the leaf is a session, not a special case.
    """
    identity = (body.get('metadata') or {}).get('user_id')
    if not isinstance(identity, str): return None
    try: return json.loads(identity).get('session_id')
    except ValueError: return None

# A view tag is a unique marker a probe types into whatever session is on
# screen, to learn who received it.
VIEW_TAG_RE = re.compile(r'VIEW_TAG_[0-9a-f]{8}')

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        messages = body.get('messages', [])
        latest = json.dumps(messages[-1].get('content', '') if messages else '')
        view = VIEW_TAG_RE.search(latest)
        marker = next((value for value in ('FRESH_ONLY_TASK', 'FORK_ONLY_TASK', 'ROOT_CONTEXT_CAFE_', 'LEAF_BLOCKED_TASK', 'ROOT_BLOCKED_TASK', 'PERMISSION_TASK', 'PLAN_TASK', 'MONITOR_TASK') if value in latest), 'BACKGROUND')
        if marker != 'BACKGROUND': requests.append(body)
        if view:
            # Recorded here and deliberately kept out of `requests`: a view tag
            # is an instrument reading, not one of the turns the probes count
            # and inspect. Its reply is tagged too, so it can never be mistaken
            # for the plain FIXTURE_REPLY_BACKGROUND turn a tool result gets.
            arrivals.append(dict(tag=view.group(0), session=session_of(body)))
        if marker in blocked_turns:
            started_turns.add(marker)
            if not blocked_turns[marker].wait(75): return
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        frames = [
            dict(type='message_start', message=dict(id='msg_' + uuid.uuid4().hex, type='message', role='assistant', model='claude-sonnet-4-6', content=[], stop_reason=None, stop_sequence=None, usage=dict(input_tokens=100, output_tokens=0))),
            dict(type='content_block_start', index=0, content_block=dict(type='text', text='')),
            dict(type='content_block_delta', index=0, delta=dict(type='text_delta', text='FIXTURE_REPLY_' + (view.group(0) if view else marker))),
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
        self.births = {self.proc.pid: self.owned[self.proc.pid].create_time()}
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
                    for child in process.children(recursive=True):
                        self.owned[child.pid] = child
                        try: self.births[child.pid] = child.create_time()
                        except (psutil.NoSuchProcess, psutil.AccessDenied): pass
            except psutil.NoSuchProcess: pass
    def running_owned(self):
        """The captured processes that are still the ones that were captured.

        A pid captured earlier can be gone, and Windows then hands its number to
        whatever starts next: a closed leaf frees one, so the check at the end of
        a run can find that number owned by a Session 0 service nothing can open,
        and psutil raises `AccessDenied` instead of reporting it gone - or, worse,
        a cleanup pass terminates a stranger. Same pid and same creation time is
        the same process; anything else is not one of ours, and no assertion here
        is about it.
        """
        live = []
        for pid, born_at in self.births.items():
            process = self.owned[pid]
            try:
                if process.is_running() and process.create_time() == born_at: live.append(process)
            except (psutil.NoSuchProcess, psutil.AccessDenied): pass
        return live
    def pump(self):
        while True:
            try:
                chunk = self.chunks.get_nowait()
                self.output = (self.output + chunk)[-262144:]
                self.stream.feed(chunk)
            except queue.Empty: return
    def dump(self):
        """Leave what was on screen behind, for whoever reads the failure."""
        (root / 'screen.txt').write_text('\n'.join(self.screen.display), encoding='utf-8')
        (root / 'terminal-output.txt').write_text(self.output, encoding='utf-8')
    def wait(self, predicate, label, timeout=30):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            self.pump()
            if predicate(): return
            time.sleep(.03)
        self.dump()
        raise AssertionError(label + ' (screen saved locally)')
    def pause(self, seconds=.2):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            self.pump(); time.sleep(.02)
    def text(self): return '\n'.join(self.screen.display)
    def submit(self, text):
        self.capture_owned()
        self.proc.write('\x1b[200~' + text + '\x1b[201~'); self.pause(.5); self.proc.write('\r')
    def typed_in(self, tag, wait=10):
        """Type a unique marker once and see which session took it.

        Returns the session id the marker became a request for, or None if it
        reached nobody inside the window.
        """
        before = len(arrivals)
        self.proc.write('\x15'); self.pause(.3)
        self.submit(tag)
        end = time.monotonic() + wait
        while time.monotonic() < end:
            self.pump()
            landed = [row for row in arrivals[before:] if row['tag'] == tag]
            if landed: return landed[0]['session']
            time.sleep(.03)
        return None
    def assert_view(self, session_id, what='focused session', timeout=30):
        """The session on screen is `session_id`, witnessed by routing.

        This is how the harness learns which session is on screen. It used to
        read the focused session id off the footer, but the footer stopped
        printing the id (it prints the resume command), so that reading was a
        stale copy of an old layout: it would say "not on screen" about any
        session at all, since the string it looked for is nowhere in the UI
        any more. A keystroke that becomes a request stamped with its
        session's id is the same fact read from the app instead of from a
        painted label, and no label can satisfy it.

        It is asked more than once because a leaf is a process with a whole
        CLI to evaluate, and until it is up its keystrokes are still handled
        by whatever is on screen. That first answer is honest - it really did
        go somewhere else - so the marker is sent again rather than accepted.
        """
        deadline = time.monotonic() + timeout
        landed = None
        attempts = 0
        while time.monotonic() < deadline:
            attempts += 1
            tag = 'VIEW_TAG_' + uuid.uuid4().hex[:8]
            landed = self.typed_in(tag)
            if landed == session_id:
                # The marker's own reply, which is what makes the session idle
                # again for whatever the probe types next.
                self.wait(lambda: 'FIXTURE_REPLY_' + tag in self.text(),
                          'view-tag turn finished', 45)
                return
            time.sleep(1)
        self.dump()
        raise AssertionError(
            what + ' is not ' + session_id[:8] + ': after ' + str(attempts) +
            ' markers the keystroke landed in ' + (str(landed)[:8] if landed else 'no session'))
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
        """The family file this session belongs to.

        The file is named after the family's creator, so a session that is not
        the creator - a leaf resumed on its own, which is an entry point in its
        own right - finds it through its own pointer. That is the lookup the app
        makes; reading the file directly only works for the session the family
        is named after.
        """
        path = root / 'leaf-families' / (self.id + '.json')
        if not path.exists():
            pointer = root / 'leaf-families' / 'index' / (self.id + '.json')
            try: path = root / 'leaf-families' / (json.loads(pointer.read_text(encoding='utf-8'))['rootSessionId'] + '.json')
            except (OSError, ValueError, KeyError): pass
        try:
            self.last_family = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {'members': []}
        except PermissionError:
            return getattr(self, 'last_family', {'members': []})
        return self.last_family
    def leaves(self):
        """The members other than the family's creator.

        The creator is an ordinary member row now - a number, a name, a place in
        the roster, like any leaf - so a probe that means "the leaves", and every
        count it asserts, has to say so rather than take members[0] and call it
        the leaf.
        """
        family = self.family()
        creator = family.get('rootSessionId')
        return [member for member in family.get('members', []) if member['sessionId'] != creator]
    def all_label(self):
        """The carousel's own count, read off the screen.

        It counts the session on screen plus the leaves this window holds a live
        process for. It is not the family file's "open" tally: the creator is a
        member with status open and is not a leaf in this window's bar.

        Read twice and agreed, because a family file changes before the frame
        that draws it does, and clicking a count the bar has not caught up to
        clicks nothing.
        """
        previous = None
        end = time.monotonic() + 10
        while time.monotonic() < end:
            self.pump()
            counts = re.findall(r'All (\d+)', self.text())
            current = 'All ' + counts[-1] if counts else None
            if current and current == previous: return current
            previous = current
            time.sleep(.1)
        assert previous, 'no carousel count on screen'
        return previous
    def point_row(self, number):
        """Click the expanded-list row for a member number.

        The row reads `{number} {name} [{state}]`, and the name is not a stable
        handle: a leaf's name follows its own session title, which is derived
        from whatever was typed at it. The number is the family's identity for
        the member and it never moves.

        Choosing a row collapses the list, so a list that is still open is a
        press that landed between frames rather than on the row - and a press
        that misses leaves the session on screen unchanged, which then reads as
        a member that would not take the terminal. Retried for the same reason
        `expand_bar` retries its toggle.

        Only the list's own body is searched. `{number} ` also occurs in the
        transcript above it - the reply to `/leaf model <id>` reads
        `Leaf #2 Lifecycle model ... updated`, which is a "2 " with a `#` in
        front of it - and matching there clicked a line of conversation, which
        has no row behind it, so the switch silently did not happen.
        """
        prefix = str(number) + ' '
        def matches():
            lines = self.screen.display
            header = next((row for row, line in enumerate(lines) if 'All sessions - click to switch' in line), None)
            if header is None: return []
            for row in range(header + 1, len(lines)):
                line = lines[row]
                if 'Previous' in line and 'Close list' in line: break
                for at in range(len(line)):
                    if line.startswith(prefix, at) and (at == 0 or not line[at - 1].isdigit()):
                        return [(at + 1, row + 1)]
            return []
        for _ in range(4):
            self.pause(.6)
            self.wait(lambda: bool(matches()), 'visible member #' + str(number))
            x, y = matches()[0]
            self.proc.write(f'\x1b[<0;{x};{y}M'); self.pause(.08)
            self.proc.write(f'\x1b[<0;{x};{y}m'); self.pause(.25)
            try:
                self.wait(lambda: 'All sessions - click to switch' not in self.text(), 'the list to close', 3)
                return
            except AssertionError:
                pass
        raise AssertionError('the session bar would not switch to member #' + str(number))
    def expand_bar(self):
        """Open the session bar's list, retrying the toggle if it did not take.

        The list is the only way to reach a member, and a press that arrives
        while the bar is still repainting what it holds toggles nothing - which
        reads as a bar that cannot be opened rather than as a click that missed.
        """
        self.click(self.all_label())
        for _ in range(3):
            self.pause(.5)
            if 'All sessions - click to switch' in self.text(): return
            self.click(self.all_label())
        raise AssertionError('the session bar would not expand')
    def menu(self):
        """Open the leaf menu, and open it again if the prompt was not free.

        A command typed while a turn is running stays in the composer instead of
        running, and a turn can start on its own here - a leaf that answers
        something arrives as a user turn in this window - so the menu is asked
        for and then asked again, with the composer cleared first, rather than
        once and hoped for. The footer says which state the prompt is in: the
        shortcut hint when it is free, `esc to interrupt` when a turn holds it.
        """
        for _ in range(4):
            self.wait(lambda: 'esc to interrupt' not in self.text(), 'the prompt to be free', 60)
            self.proc.write('\x15'); self.pause(.3)
            self.submit('/leaf')
            try:
                self.wait(lambda: 'Leaves in this family' in self.text(), 'the leaf menu', 10)
                return
            except AssertionError: pass
        raise AssertionError('the leaf menu would not open')
    def pick(self, label):
        """Choose a numbered row from a menu, the way a keyboard does.

        The leaf menu floats over the prompt rather than in a dialog of its own,
        and a click on one of its rows is not what selects it. What selects it is
        the highlighted row, and the rows are numbered on screen - which is how
        many steps down the highlight has to move before Enter. The number is
        read off the row instead of assumed, because the same menu drops its
        first row when another window manages the family.
        """
        self.pause(.6)
        def number():
            for line in self.screen.display:
                if label not in line: continue
                # The highlighted row carries the select's pointer, so the number
                # is read past whatever the row is decorated with.
                found = re.match(r'[^\d]*(\d+)\.\s', line)
                if found: return int(found.group(1))
            return None
        self.wait(lambda: number() is not None, 'visible ' + label)
        for _ in range(number() - 1):
            self.proc.write('\x1b[B'); self.pause(.15)
        self.proc.write('\r')
        self.pause(.5)
    def pick_row(self, label):
        """Choose a row that carries no number, the way a keyboard does.

        Only the rows that are typed into are indexed, and the create wizard's
        other controls - the start toggle, the create button - are rows all the
        same. What selects any row is the highlighted one, so the highlight is
        walked down until it sits on the row that is wanted, which is read from
        the pointer rather than counted, and the walk stops when it arrives.
        """
        self.pause(.6)
        def focused():
            # A `>` at the start of a line is either the dialog's pointer or the
            # prompt the transcript echoes back, and the transcript keeps its
            # echoes above the dialog - so the pointer is the lowest one.
            for line in reversed(self.screen.display):
                stripped = line.strip()
                if stripped.startswith('>'): return stripped[1:].strip()
            return None
        for _ in range(12):
            current = focused()
            if current and label in current:
                self.proc.write('\r'); self.pause(.5); return
            self.proc.write('\x1b[B'); self.pause(.15)
        self.dump()
        raise AssertionError('the highlight would not reach ' + label + ' (screen saved locally)')
    def point_first_item(self):
        """Click the carousel's first entry, which is the session on screen.

        Its label is the session's own name, and that is whatever the session
        has been called - which a leaf can be called too, so matching on the
        text would sometimes click the leaf. The first row of the expanded list
        is the session on screen by construction.
        """
        self.pause(.6)
        def matches():
            lines = self.screen.display
            for row, line in enumerate(lines):
                if 'All sessions - click to switch' not in line: continue
                for below in range(row + 1, len(lines)):
                    if lines[below].strip(' │'):
                        return [(len(lines[below]) - len(lines[below].lstrip(' │')) + 1, below + 1)]
                break
            return []
        self.wait(lambda: bool(matches()), 'visible first carousel entry')
        x, y = matches()[0]
        self.proc.write(f'\x1b[<0;{x};{y}M'); self.pause(.08)
        self.proc.write(f'\x1b[<0;{x};{y}m'); self.pause(.25)
    def original(self, draft=None):
        self.expand_bar()
        self.point_first_item()
        self.witness(self.id, 'the original session', draft)
        self.pause(.5)
    def leaf(self, index, permission=False, draft=None):
        self.expand_bar()
        member = self.leaves()[index]
        self.point_row(member['number'])
        if permission:
            # The pending permission dialog is itself proof of which session is
            # on screen, and is the thing the probe goes on to answer.
            self.wait(lambda: 'Do you want to create approved-leaf.txt?' in self.text(), 'selected leaf UI')
        else:
            self.witness(member['sessionId'], 'the selected leaf', draft)
    def witness(self, session_id, what, draft=None):
        """Say which session is on screen, without damaging what is on it.

        Normally that is routing: type a marker, see whose request it became.
        But a session can be holding unsent text, and typing into it proves
        focus by destroying the very thing the next assertion is about - the
        draft exists on exactly one session's screen, so it is its own witness
        and the marker would only be a second, contradictory one.
        """
        if draft is not None:
            self.wait(lambda: draft in self.text(), what + ', still holding its draft')
        else:
            self.assert_view(session_id, what)
    def resize(self, columns, rows):
        self.screen.resize(lines=rows, columns=columns)
        self.proc.setwinsize(rows, columns)
        self.pause(.8)
    def exit(self, family_survives=None):
        """Leave the session, and check what that did to the family.

        A member is its own process, so the session watching it leaving is a
        detach and the family keeps running - closing the session you are in is
        what used to take the whole family down with it. Where this terminal has
        a member open, surviving is the expected outcome and dying is the
        failure; a terminal with no leaves still has to exit cleanly.
        """
        self.submit('/exit')
        self.wait(lambda: not self.proc.isalive(), 'graceful root exit')
        _, alive = psutil.wait_procs(self.running_owned(), timeout=10)
        if family_survives is None:
            family_survives = any(member['status'] == 'open' for member in self.leaves())
        if family_survives:
            assert alive, 'Graceful exit closed the family instead of detaching it'
        else:
            assert not alive, 'Graceful exit left owned processes: ' + str([p.pid for p in alive])
        # Whoever is still running is still writing, so only the session that
        # left gives its claim back. Waiting for every writer lock here would
        # mean waiting for the family, which is the thing that must not happen.
        self.wait(lambda: not (root / 'gateway-writers' / (self.id + '.lock')).exists(),
                  'the leaving session released its writer lock')
        if not family_survives:
            self.wait(lambda: not list((root / 'gateway-writers').glob('*.lock')), 'all fixture writer locks released')
            self.wait(lambda: not list((root / 'projects').rglob('*.leaf-owner.lock')), 'all leaf owner locks released')
        else:
            # The family is still up in another window, which is holding the
            # leaves it has and its own transcript on purpose. What this session
            # owes back is the transcript it took for itself.
            self.wait(lambda: not list((root / 'projects').rglob(self.id + '*.leaf-owner.lock')),
                      'the leaving session released the transcript it held')

def probe_full_tui():
    t = Terminal()
    t.wait(lambda: 'All 1' in t.text(), 'initial normal session', 60)
    t.submit('/leaf new FullSession')
    t.wait(lambda: len(t.leaves()) == 1 and 'All 2' in t.text(), 'leaf created', 75)
    leaf_id = t.leaves()[0]['sessionId']
    t.wait(lambda: 'session:' in t.text(), 'leaf must show its own normal session footer', 75)
    t.assert_view(leaf_id, 'the new leaf', 75)
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
    t.original('ROOT_UNSENT')
    t.wait(lambda: 'LEAF_UNSENT' not in t.text(), 'the leaf draft leaked into the root')
    t.leaf(0, draft='LEAF_UNSENT')
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
    # A narrow layout still owes the user the directory row it renders and a
    # prompt that takes what is typed at it. The row is labelled `cd:` - the
    # label the footer has used since it started naming the directory the
    # conversation is resumed from rather than the live cwd.
    t.wait(lambda: 'All 2' in t.text() and 'cd:' in t.text(), 'selected full UI resizes')
    t.assert_view(leaf_id, 'the selected leaf at 60 columns')
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
    t.wait(lambda: len(t.leaves()) == 1, 'fork created', 75)
    t.assert_view(t.leaves()[0]['sessionId'], 'the fork', 75)
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
    t.wait(lambda: len(t.leaves()) == 1, 'fresh leaf recorded', 75)
    leaf_id = t.leaves()[0]['sessionId']
    t.assert_view(leaf_id, 'the new leaf', 75)
    t.submit('FRESH_ONLY_TASK')
    t.wait(lambda: 'FIXTURE_REPLY_FRESH_ONLY_TASK' in t.text(), 'leaf turn')
    t.submit('/leaf fork original RootCopy')
    t.wait(lambda: len(t.leaves()) == 2, 'root fork from leaf', 75)
    fork = t.leaves()[1]
    assert fork['parentSessionId'] == t.id, 'Explicit original fork used the leaf as source'
    t.assert_view(fork['sessionId'], 'the root fork', 75)
    t.submit('FORK_ONLY_TASK')
    t.wait(lambda: 'FIXTURE_REPLY_FORK_ONLY_TASK' in t.text(), 'root fork turn')
    assert 'ROOT_CONTEXT_CAFE_' in json.dumps(requests[-1]) and 'FRESH_ONLY_TASK' not in json.dumps(requests[-1]), 'Original fork context incorrect'
    t.submit('/leaf return ' + fork['sessionId'] + ' SELECTED_CONTEXT_NOTE')
    t.wait(lambda: 'Selected leaf context saved' in t.text(), 'context returned from child')
    root_logs = list((root / 'projects').rglob(t.id + '.jsonl'))
    assert len(root_logs) == 1 and 'SELECTED_CONTEXT_NOTE' in root_logs[0].read_text(encoding='utf-8'), 'Return did not persist in original'
    t.submit('/clear')
    t.wait(lambda: len(t.leaves()) == 3 and t.leaves()[1]['status'] == 'closed', 'clear updates leaf identity')
    assert t.leaves()[1]['status'] == 'closed', 'Clear left old identity live'
    cleared = t.leaves()[2]
    t.assert_view(cleared['sessionId'], 'the cleared session')
    t.original()
    t.leaf(2)
    t.original()
    t.submit('/leaf close ' + cleared['sessionId'])
    t.wait(lambda: t.leaves()[2]['status'] == 'closed', 'cleared session closes')
    t.submit('/leaf reopen ' + fork['sessionId'])
    t.wait(lambda: t.leaves()[1]['status'] == 'open' and 'Leaf reopen recorded' in t.text(), 'original fork reopens', 75)
    t.submit('/leaf model ' + leaf_id + ' claude-haiku-4-5')
    t.wait(lambda: t.leaves()[0].get('model') == 'claude-haiku-4-5', 'model saved')
    t.pause(.5)
    t.submit('/leaf effort ' + leaf_id + ' high')
    t.wait(lambda: t.leaves()[0].get('effort') == 'high', 'effort saved')
    t.pause(.5)
    t.leaf(0)
    t.proc.write('SAVED_DRAFT')
    t.wait(lambda: 'SAVED_DRAFT' in t.text(), 'draft visible before switching')
    t.original()
    t.submit('/leaf close ' + leaf_id)
    t.wait(lambda: t.leaves()[0]['status'] == 'closed' and 'All 2' in t.text(), 'leaf closed')
    assert t.leaves()[0]['draft'] == 'SAVED_DRAFT', 'Close lost draft'
    t.submit('/leaf reopen ' + leaf_id)
    t.wait(lambda: t.leaves()[0]['status'] == 'open' and 'All 3' in t.text(), 'leaf reopened', 75)
    t.leaf(0, draft='SAVED_DRAFT')
    t.wait(lambda: 'FRESH_ONLY_TASK' in t.text(), 'Reopen lost draft or transcript')
    t.proc.write('\x15'); t.pause()
    t.submit('FRESH_ONLY_TASK_MODEL')
    t.wait(lambda: requests[-1].get('model') == 'claude-haiku-4-5' and 'FIXTURE_REPLY_FRESH_ONLY_TASK' in t.text(), 'reopened model applied')
    t.original()
    t.submit('/leaf goal ' + leaf_id + ' Verify this local fixture goal')
    t.wait(lambda: 'Leaf goal saved' in t.text(), 'leaf goal saved and reopened', 75)
    member = t.leaves()[0]
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
        if t.leaves()[0]['status'] == 'closed':
            break
    t.wait(lambda: t.leaves()[0]['status'] == 'closed' and 'All 2' in t.text(), 'leaf filed')
    t.wait(lambda: 'lifecycle-fixture' in Path(member['transcriptPath']).read_text(encoding='utf-8'), 'filed tag persisted')
    t.submit('/leaf promote ' + fork['sessionId'])
    t.wait(lambda: t.leaves()[1]['status'] == 'promoted' and 'All 1' in t.text(), 'leaf promoted')
    assert Path(fork['transcriptPath']).exists(), 'Promotion removed transcript'
    subprocess.run(['git', 'init', str(root)], check=True, capture_output=True, timeout=15)
    subprocess.run(['git', '-C', str(root), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--allow-empty', '-m', 'Local fixture'], check=True, capture_output=True, timeout=15)
    worktree = root / 'isolated-worktree'
    subprocess.run(['git', '-C', str(root), 'worktree', 'add', '-b', 'fixture-worktree', str(worktree)], check=True, capture_output=True, timeout=15)
    t.submit('/leaf worktree ' + json.dumps(dict(path=str(worktree), name='WorktreeLeaf')))
    t.wait(lambda: len(t.leaves()) == 4, 'worktree leaf opens', 75)
    worktree_member = t.leaves()[3]
    assert Path(worktree_member['cwd']).resolve() == worktree.resolve(), 'Leaf cwd not isolated'
    t.assert_view(worktree_member['sessionId'], 'the worktree leaf', 75)
    t.submit('FORK_ONLY_TASK_WORKTREE')
    t.wait(lambda: 'FIXTURE_REPLY_FORK_ONLY_TASK' in t.text(), 'worktree fork answers')
    assert 'ROOT_CONTEXT_CAFE_' in json.dumps(requests[-1]), 'Worktree fork lost source context'
    t.original()
    t.submit('/leaf close ' + worktree_member['sessionId'])
    t.wait(lambda: t.leaves()[3]['status'] == 'closed', 'worktree leaf closes')
    t.submit('/leaf reopen ' + worktree_member['sessionId'])
    t.wait(lambda: 'All 2' in t.text(), 'worktree leaf reopens', 75)
    t.leaf(3)
    t.wait(lambda: 'FORK_ONLY_TASK_WORKTREE' in t.text(), 'worktree history retained')
    t.submit('/branch NativeBranch')
    t.wait(lambda: len(t.leaves()) == 5 and t.leaves()[3]['status'] == 'closed', 'native branch updates family identity', 75)
    t.assert_view(t.leaves()[4]['sessionId'], 'the native branch', 75)
    t.submit('/resume ' + worktree_member['sessionId'])
    t.wait(lambda: t.leaves()[3]['status'] == 'open' and t.leaves()[4]['status'] == 'closed', 'native resume restores family identity', 75)
    t.assert_view(worktree_member['sessionId'], 'the resumed session', 75)
    t.original()
    t.exit()
    print(json.dumps(dict(lifecycle=True, rootFork=True, modelRestart=True, savedDraft=True, goal=True, filing=True, promotion=True, ownedProcessCleanup=True)), flush=True)

def probe_parentage():
    """A leaf is an entry point, and the parent is a designation that moves.

    The three things the old model could not do, all of them on fresh sessions:
    a member resumed on its own with `cc --resume <leaf id>` is a full entry
    point - it finds its family, opens new leaves and reopens existing ones;
    which member is the parent can be designated, and the family then takes that
    member's name while the session that was the parent becomes an ordinary
    leaf; and the window that held the family before reports that it moved and
    stops managing it, instead of driving a second copy of the same leaves.
    """
    def title_of(path):
        """The session title in force, read out of the transcript.

        saveSessionName appends a custom-title record, so the newest one is the
        title the UI shows. A session caches its own, and the file is how any
        other process - this probe included - reads the same string.
        """
        found = []
        for line in Path(path).read_text(encoding='utf-8', errors='replace').splitlines():
            try: entry = json.loads(line)
            except ValueError: continue
            if entry.get('type') == 'custom-title': found.append(entry.get('customTitle'))
        return found[-1] if found else None

    t = Terminal()
    t.wait(lambda: 'All 1' in t.text(), 'initial session', 60)
    t.submit('/leaf new Alpha')
    t.wait(lambda: len(t.leaves()) == 1 and 'All 2' in t.text(), 'alpha created', 75)
    t.assert_view(t.leaves()[0]['sessionId'], 'the new leaf', 75)
    t.original()
    t.submit('/leaf new Beta')
    t.wait(lambda: len(t.leaves()) == 2 and 'All 3' in t.text(), 'beta created', 75)
    t.original()
    alpha, beta = t.leaves()[0], t.leaves()[1]
    assert alpha['number'] < beta['number'], 'members are not numbered in creation order'
    # The creator is an ordinary member row now, not only the family's identity.
    creator = next(member for member in t.family()['members'] if member['sessionId'] == t.id)
    assert creator['number'] == 1, 'the creator has no ordinary member row: ' + repr(creator['number'])
    # Alpha stops here so it can be entered on its own. Resuming a member whose
    # process is still running under another window is the double-driver case,
    # not the entry point this is about.
    t.submit('/leaf close ' + alpha['sessionId'])
    t.wait(lambda: t.leaves()[0]['status'] == 'closed', 'alpha closed for a clean resume')
    assert t.leaves()[1]['status'] == 'open', 'beta must stay running for the handoff to inherit it'

    # Enter the leaf directly, the way a person would from any terminal.
    s = Terminal(alpha['sessionId'])
    s.wait(lambda: 'All ' in s.text(), 'the resumed leaf', 90)
    s.assert_view(alpha['sessionId'], 'the leaf entered with --resume', 90)
    assert s.family()['rootSessionId'] == t.id, 'a member resumed on its own did not find its family'
    assert len(s.leaves()) == 2, 'a member resumed on its own cannot see its siblings'
    assert s.family()['members'][0]['sessionId'] == t.id, 'the roster a member reads is missing its parent'

    # A full entry point: it opens a new leaf, and that leaf copies the
    # conversation on screen - the leaf - rather than the parent behind it.
    s.submit('/leaf new Gamma')
    s.wait(lambda: len(s.leaves()) == 3, 'gamma created from the leaf', 75)
    gamma = max(s.leaves(), key=lambda member: member['number'])
    assert gamma['name'] == 'Gamma', 'the new leaf did not take the name it was given: ' + repr(gamma['name'])
    assert gamma['parentSessionId'] == alpha['sessionId'], 'a leaf forked the parent instead of itself'
    s.assert_view(gamma['sessionId'], 'the leaf the leaf opened', 90)

    # Reopening an existing leaf is management, and this window is the one that
    # manages the family now. Reopening relaunches the member without moving the
    # session on screen, so the proof is the bar: it holds the members whose
    # process is alive, and only those, so the reopened leaf leaves it on close
    # and comes back on reopen.
    s.submit('/leaf close ' + gamma['sessionId'])
    s.wait(lambda: max(s.leaves(), key=lambda member: member['number'])['status'] == 'closed', 'gamma closed from the leaf')
    s.wait(lambda: 'All 1' in s.text(), 'the closed leaf leaves the session bar', 60)
    s.submit('/leaf reopen ' + gamma['sessionId'])
    s.wait(lambda: max(s.leaves(), key=lambda member: member['number'])['status'] == 'open', 'gamma reopened from the leaf', 90)
    s.wait(lambda: 'All 2' in s.text(), 'the reopened leaf running in the session bar', 90)

    # Designate the member we are in as the parent. Nothing is created and no
    # number moves; what changes is which member the family is named after.
    before = s.family()
    s.submit('/leaf reparent ' + beta['sessionId'])
    s.wait(lambda: 'is now the family parent' in s.text(), 're-parent accepted', 30)
    after = s.family()
    assert after['nextNumber'] == before['nextNumber'], 're-parenting created a member'
    assert len(after['members']) == len(before['members']), 're-parenting changed the roster'
    assert after['returnedContextIds'] == before['returnedContextIds'], 're-parenting invalidated the context receipts'
    # The designation lives in the creator's pointer, which is what every member
    # reads, and every pointer is rewritten with the parent the family has now.
    designation = json.loads((root / 'leaf-families' / 'index' / (t.id + '.json')).read_text(encoding='utf-8'))
    assert designation['parentSessionId'] == beta['sessionId'], 'the designation did not move'
    for member in after['members']:
        pointer = json.loads((root / 'leaf-families' / 'index' / (member['sessionId'] + '.json')).read_text(encoding='utf-8'))
        assert pointer.get('parentSessionId') == beta['sessionId'], 'a member pointer still names the old parent'
    # The titles move, not the rows: the family reads as the member designated
    # as its parent, and the session that was the parent reads as a leaf of it.
    assert title_of(beta['transcriptPath']) == beta['name'], 'the new parent did not take the family name: ' + repr(title_of(beta['transcriptPath']))
    assert title_of(creator['transcriptPath']) == 'Leaf %s: %s' % (creator['number'], creator['name']), 'the old parent did not become a leaf: ' + repr(title_of(creator['transcriptPath']))
    # The roster agrees with it: the member that was the parent is offered as one
    # that could be made the parent, and the member that is the parent is not.
    s.menu()
    s.pick('Leaves in this family')
    s.wait(lambda: 'Make parent #%s ' % creator['number'] in s.text(), 'the old parent is offered as a parent again', 30)
    assert 'Make parent #%s ' % beta['number'] not in s.text(), 'the parent is offered as its own replacement'
    s.proc.write('\x1b'); s.pause(.5); s.proc.write('\x1b'); s.pause(.5)

    # The window that held the family before is told, rather than left to drive a
    # second copy of the same leaves.
    t.submit('/leaf new Delta')
    t.wait(lambda: 'The family moved to another window' in t.text(), 'management refused in the window that lost the family', 30)
    t.menu()
    t.wait(lambda: 'The family moved to the window opened most recently' in t.text(), 'the menu says the family moved', 30)
    assert 'Create a leaf' not in t.text(), 'a displaced window still offers to create leaves'
    t.pick('Leaves in this family')
    t.wait(lambda: '#%s %s' % (alpha['number'], alpha['name']) in t.text(), 'the roster in a displaced window', 30)
    assert 'Open  #' not in t.text(), 'a displaced window still offers to open leaves'
    assert 'Close #' not in t.text(), 'a displaced window still offers to close leaves'
    assert 'Archive #' not in t.text(), 'a displaced window still offers to archive leaves'
    assert 'Make parent #' not in t.text(), 'a displaced window still offers to re-parent'
    # What a displaced window keeps is the address of every member: it is not the
    # manager any more, but every member is still an entry point.
    assert 'cc --resume ' + alpha['sessionId'] in t.text(), 'the displaced roster does not name how to enter a member'
    t.pick('Back')
    t.proc.write('\x1b'); t.pause(.5)
    # And it keeps the terminals it already attached, which is the other half of
    # being a follower rather than being shut out.
    t.leaf(1)
    t.assert_view(beta['sessionId'], 'the terminal the displaced window kept', 90)
    t.original()
    t.exit()
    s.exit()
    print(json.dumps(dict(parentage=True, directResume=True, leafOpensLeaves=True, leafReopensLeaves=True, reparent=True, familyTakesNewParentName=True, oldParentBecomesLeaf=True, displacedRefusesManagement=True, displacedKeepsTerminals=True)), flush=True)

try:
    (root / '.claude.json').write_text(json.dumps(dict(theme='dark', hasCompletedOnboarding=True, projects={root.as_posix(): dict(hasTrustDialogAccepted=True, hasCompletedProjectOnboarding=True)})), encoding='utf-8')
    if args.probe_full_tui or args.probe_lifecycle or args.probe_selection or args.probe_parity or args.probe_parentage:
        (probe_full_tui if args.probe_full_tui else probe_lifecycle if args.probe_lifecycle else probe_selection if args.probe_selection else probe_parentage if args.probe_parentage else probe_parity)()
        raise SystemExit(0)
    t = Terminal()
    t.wait(lambda: 'All 1' in t.text(), 'initial carousel', 60)
    t.submit('ROOT_CONTEXT_CAFE_世界')
    t.wait(lambda: len(requests) >= 1 and 'FIXTURE_REPLY_ROOT_CONTEXT_CAFE_' in t.text(), 'root response')
    t.submit('/leaf fork original ForkOne')
    t.wait(lambda: len(t.leaves()) == 1, 'fork created', 75)
    fork_id = t.leaves()[0]['sessionId']
    t.assert_view(fork_id, 'the fork', 75)
    t.submit('FORK_ONLY_TASK')
    t.wait(lambda: len(requests) >= 2 and 'FIXTURE_REPLY_FORK_ONLY_TASK' in t.text(), 'fork response')
    assert 'ROOT_CONTEXT_CAFE_' in json.dumps(requests[-1]), 'Fork context missing'
    t.click('✎ Rename')
    t.wait(lambda: 'Session metadata' in t.text(), 'normal leaf rename field')
    t.proc.write('\x15'); t.pause(); t.proc.write('RenamedLeaf\r')
    t.wait(lambda: t.leaves()[0]['name'] == 'RenamedLeaf', 'leaf rename saved')
    t.original()
    t.wait(lambda: 'session:' in t.text(), 'original restored')
    t.submit('/leaf new FreshOne')
    t.wait(lambda: len(t.leaves()) == 2, 'fresh leaf created', 75)
    fresh = t.leaves()[1]
    t.assert_view(fresh['sessionId'], 'the fresh leaf', 75)
    t.submit('FRESH_ONLY_TASK')
    t.wait(lambda: len(requests) >= 3 and 'FIXTURE_REPLY_FRESH_ONLY_TASK' in t.text(), 'fresh response')
    assert 'ROOT_CONTEXT_CAFE_' not in json.dumps(requests[-1]), 'Fresh leaf inherited context'
    # A marker that is answered proves the leaf is back at its input loop,
    # which is the idle claim, and that it - not the root - is on screen.
    t.assert_view(fresh['sessionId'], 'the fresh leaf, idle before the wheel')
    t.pause(.5)
    # The row label is `{number} {name}`, and the number is the family's own - it
    # shifts when a member joins the list, so it is read rather than assumed.
    t.wheel(f"{fresh['number']} {fresh['name']}", False)
    t.assert_view(t.leaves()[0]['sessionId'], 'the wheel target')
    t.click('All 3', hold=True)
    t.wait(lambda: 'All sessions' in t.text(), 'hold expanded picker')
    t.click(f"{fresh['number']} {fresh['name']} [idle]")
    t.assert_view(fresh['sessionId'], 'the picker target')
    assert 'All sessions' not in t.text(), 'the picker stayed open after a selection'
    t.original()
    t.click('✎ Rename')
    t.wait(lambda: 'Session metadata' in t.text(), 'pencil opens root rename')
    t.proc.write('\x15'); t.pause(); t.proc.write('RootRenamed\r')
    t.wait(lambda: 'Session metadata' not in t.text() and 'RootRenamed' in t.text(), 'root rename saved')
    t.pause(.5)
    # Leave a quiet family behind. A member is its own process, and one that is
    # still up when the window exits is detached and keeps serving its own
    # address - so a resumed window finds it running and refuses to start a
    # second copy of it, which is the rule and not what this step is about.
    # Closing first is what makes the resumed window's own opening the subject.
    for member in t.leaves():
        t.submit('/leaf close ' + member['sessionId'])
    t.wait(lambda: not any(item['status'] == 'open' for item in t.leaves()), 'leaves closed before the window leaves', 60)
    t.exit()
    resumed = Terminal(t.id)
    # A window holds the leaves it started and nothing else: `status: open` is
    # what a member was doing when it was last seen, not an instruction to boot.
    # So the resumed session carries itself in the bar, and the family it reads
    # back is the file - names, numbers and all.
    resumed.wait(lambda: 'All 1' in resumed.text(), 'restored carousel', 45)
    assert [item['name'] for item in resumed.leaves()] == ['RenamedLeaf', 'FreshOne'], 'the family was not restored from disk'
    # The leaf's conversation is still reachable, by reopening it here: the member
    # resumes its own transcript rather than being handed a new one. Reopening
    # starts it without taking the screen, so it is then entered from the bar.
    resumed.submit('/leaf reopen ' + fork_id)
    resumed.wait(lambda: 'All 2' in resumed.text(), 'the restored leaf is open here', 75)
    restored = resumed.leaves()[0]
    resumed.click('All 2')
    resumed.click(f"{restored['number']} {restored['name']} [idle]")
    resumed.wait(lambda: 'FORK_ONLY_TASK' in resumed.text(), 'restored leaf history', 75)
    resumed.submit('/leaf')
    resumed.wait(lambda: 'Create a leaf' in resumed.text(), 'creation menu inside leaf')
    resumed.pick('Create a leaf')
    # The wizard opens on the conversation that is on screen and set to fork it,
    # which is the point of reaching it from a leaf: the leaf you are looking at
    # is what the next leaf copies. The name is typed into the row that already
    # holds the keyboard, and the rows that are not typed into carry no number,
    # so those are walked to.
    resumed.wait(lambda: 'Start: Fork' in resumed.text(), 'the wizard forks what is on screen')
    resumed.proc.write('MenuFork')
    resumed.wait(lambda: '1. MenuFork' in resumed.text(), 'the name typed into the wizard')
    resumed.pick_row('Create leaf —')
    resumed.wait(lambda: len(resumed.leaves()) == 3, 'menu context fork', 75)
    assert resumed.leaves()[-1]['parentSessionId'] == resumed.leaves()[0]['sessionId'], 'Menu fork ancestry'
    assert resumed.leaves()[-1]['name'] == 'MenuFork', 'the wizard used the name it was given'
    resumed.assert_view(resumed.leaves()[-1]['sessionId'], 'the menu context fork', 75)
    resumed.submit('/leaf')
    resumed.wait(lambda: 'Create a leaf' in resumed.text(), 'new-chat menu inside leaf')
    resumed.pick('Create a leaf')
    resumed.wait(lambda: 'Start: Fork' in resumed.text(), 'the wizard again')
    resumed.pick_row('Start:')
    resumed.wait(lambda: 'Start: New chat' in resumed.text(), 'the wizard set to a new chat')
    resumed.pick_row('Create leaf —')
    resumed.wait(lambda: len(resumed.leaves()) == 4, 'menu fresh chat', 75)
    resumed.assert_view(resumed.leaves()[-1]['sessionId'], 'the menu fresh chat', 75)
    assert resumed.leaves()[-1]['forkMessageId'] is None, 'Menu new copied context'
    print(json.dumps(dict(fullscreen=args.fullscreen, columns=args.columns, rows=args.rows, forkContext=True, freshIsolation=True, clickSwitch=True, wheelSwitch=True, holdPicker=True, rootRename=True, leafRename=True, restoredHistory=True, creationMenu=True, modelRequests=len(requests))), flush=True)
finally:
    for gate in blocked_turns.values(): gate.set()
    for terminal in processes:
        terminal.capture_owned()
        owned = terminal.running_owned()
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
