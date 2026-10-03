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
parser.add_argument('--probe-inline-ownership', action='store_true')
parser.add_argument('--probe-parity', action='store_true')
parser.add_argument('--probe-parentage', action='store_true')
parser.add_argument('--probe-close-matriarch', action='store_true')
parser.add_argument('--probe-owner-cascade', action='store_true')
parser.add_argument('--probe-exit-cascade', action='store_true')
parser.add_argument('--probe-resumed-member', action='store_true')
parser.add_argument('--probe-creator-after-patriarch', action='store_true')
parser.add_argument('--probe-comms', action='store_true')
parser.add_argument('--probe-read', action='store_true')
parser.add_argument('--probe-merge', action='store_true')
parser.add_argument('--probe-compact', action='store_true')
parser.add_argument('--probe-merge-stress', action='store_true')
parser.add_argument('--probe-merge-roles', action='store_true')
parser.add_argument('--probe-queue', action='store_true')
parser.add_argument('--probe-elder', action='store_true')
parser.add_argument('--probe-arc', action='store_true')
parser.add_argument('--probe-stress', action='store_true')
parser.add_argument('--probe-crash-window', action='store_true')
parser.add_argument('--probe-designation-residue', action='store_true')
parser.add_argument('--probe-dormant-residue', action='store_true')
parser.add_argument('--probe-close-promotion', action='store_true')
parser.add_argument('--probe-goal-reopen', action='store_true')
parser.add_argument('--probe-boot', action='store_true')
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
# What the app computed for a tool it ran, in arrival order: the result is sent
# back to the model, and for tools the transcript does not render - the Leaf
# tool among them - that request is the only place the answer exists. See
# tool_result_text.
tool_results = []

def tool_result_text(content):
    """The text of a tool result the app is sending back to the model.

    A tool the app runs has one observable that is not the screen: the result
    it hands to the model in the next request. The Leaf tool's listing is the
    case that matters here - the app runs it, sends the text back and renders
    only the model's next words, so a probe that reads the screen concludes the
    app said nothing. The result itself is right there on the wire.
    """
    blocks = content if isinstance(content, list) else [content]
    for block in blocks:
        if not isinstance(block, dict) or block.get('type') != 'tool_result': continue
        inner = block.get('content')
        if isinstance(inner, str): return inner
        if isinstance(inner, list):
            return '\n'.join(part.get('text', '') for part in inner if isinstance(part, dict))
    return None

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

def view_tag(content):
    """The view tag the app typed, read from the message's own text.

    A tag means "this keystroke landed here", so it is only a reading when it
    *is* the message. Searching the whole message instead is not the same fact:
    a read renders another session's conversation, and that text quotes replies,
    so a digest line ends in `FIXTURE_REPLY_VIEW_TAG_<hex>` - a tag-shaped
    string that has nothing to do with who received anything. A probe hit
    exactly that: the digest rode along in the same message as the newly typed
    tag, the search answered the quotation, and the previous turn's reply
    appeared under the new turn's question. Only a block that is nothing but a
    tag counts.
    """
    blocks = content if isinstance(content, list) else [content]
    found = None
    for block in blocks:
        text = block if isinstance(block, str) else (block.get('text', '') if isinstance(block, dict) else '')
        match = VIEW_TAG_RE.fullmatch(text.strip()) if isinstance(text, str) else None
        if match: found = match
    return found

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        messages = body.get('messages', [])
        latest = json.dumps(messages[-1].get('content', '') if messages else '')
        view = view_tag(messages[-1].get('content', '') if messages else '')
        answered = tool_result_text(messages[-1].get('content', '') if messages else '')
        tool_results.append(answered)
        marker = next((value for value in ('FRESH_ONLY_TASK', 'FORK_ONLY_TASK', 'ROOT_CONTEXT_CAFE_', 'LEAF_BLOCKED_TASK', 'ROOT_BLOCKED_TASK', 'PERMISSION_TASK', 'PLAN_TASK', 'MONITOR_TASK', 'QUEUE_', 'ALPHA_FIRST_TURN', 'ALPHA_LATER_TURN', 'ELDER_SECRET_', 'PATRIARCH_SECRET_', 'GAMMA_TURN', 'GAMMA_LATER_TURN', 'DELTA_TURN', 'OTHER_TURN_MARKER', 'BLOT_STEP_', 'BLOT_REPORT_', 'SEEDLING_FINDING_', 'SEED_ACK_', 'BULK_TURN_', 'SOLO_REPORT_', 'ROSTER_TASK', 'OWNERSHIP_MARKER_ALPHA') if value in latest), 'BACKGROUND')
        if marker != 'BACKGROUND': requests.append(body)
        if os.environ.get('LEAF_POINTER_LOG'):
            # What the app actually asked for. A probe that fails on a reply it
            # never saw needs to know whether the request carried the marker
            # that was typed, so this records the raw last message rather than
            # the answer the fixture decided to give it.
            with open(root / 'requests.log', 'a', encoding='utf-8') as log:
                log.write(json.dumps(dict(
                    view=(view.group(0) if view else None), marker=marker,
                    session=session_of(body), tail=latest[-4000:],
                ), ensure_ascii=False) + '\n')
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
        if marker == 'ROSTER_TASK':
            tools = {tool['name'] for tool in body.get('tools', [])}
            print('FIXTURE_ROSTER_TASK leafTool=' + str('Leaf' in tools) + ' n=' + str(len(tools)) + ' names=' + ','.join(sorted(tools)), flush=True)
            # The family roster is the app's own account of who holds the role,
            # and it is only reachable through the model's Leaf tool - there is
            # no slash command for it. So the fixture asks for it the way the
            # model would, and the app computes the listing, which is the
            # resolution a probe wants to read rather than a file it parsed.
            #
            # Only when the request is a real turn: an auxiliary request (a
            # title, a quota probe) replays the same last user message with a
            # reduced tool set, and answering that one with a tool call names a
            # tool the request never had. `Write` is an ordinary tool that a
            # real turn always carries and an auxiliary one never does - the
            # same distinction the plan-mode branch draws, for the same reason.
            # The Leaf tool itself is not the test: it is a deferred tool, so it
            # is described in the prompt rather than listed in `tools`.
            if 'Write' in tools or 'write' in tools:
                frames[1] = dict(type='content_block_start', index=0, content_block=dict(type='tool_use', id='tool_roster_fixture', name='Leaf', input=dict(action='roster')))
                frames[2] = dict(type='content_block_delta', index=0, delta=dict(type='input_json_delta', partial_json=json.dumps(dict(action='roster'))))
                frames[4]['delta']['stop_reason'] = 'tool_use'
        if marker == 'BULK_TURN_':
            # One long turn, repeated, is how a seed's conversation is pushed
            # past the size a merge carries - the branch that decides what a
            # bounded merge does rather than the one that only ever sees a
            # handful of short turns.
            frames[2]['delta']['text'] = 'FIXTURE_REPLY_BULK_TURN_' + ('x' * 1400)
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
    def owned_leaves(self):
        """The captured children that are running a member of this family.

        A window's children are not only leaves. A turn that starts a
        background task, or a shell provider, leaves processes of its own
        behind, and a leave ends the LEAVES - a backgrounded task is the turn's
        to end, not the window's. So a child counts here only when its command
        line names a member of this family, which is the same fact the app reads
        off a member's own command line, and the same instrument the owner
        cascade probe uses.
        """
        members = {member['sessionId'] for member in self.family().get('members', [])}
        found = []
        for process in self.running_owned():
            try: line = process.cmdline()
            except (psutil.NoSuchProcess, psutil.AccessDenied): continue
            if any(member in part for member in members for part in line): found.append(process)
        return found
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
    def after(self, marker):
        """What is on screen from the last `marker` onwards.

        What a command printed stays on screen above whatever comes after it, so
        a check against the whole screen can be satisfied by an older answer to an
        older question - a listing that still shows a checkpoint after it was
        dropped, because the listing from before the drop is still up there. The
        newest occurrence is what the last command wrote.
        """
        at = self.text().rfind(marker)
        return self.text()[at:] if at >= 0 else ''
    def check(self, predicate, label):
        """An assertion about what is on screen, with the screen kept on failure.

        `wait` already saves the screen when it gives up; a bare assert does not,
        and a probe that fails on a screen reading with no screen to read is a
        probe nobody can diagnose.
        """
        self.pump()
        if not predicate():
            self.dump()
            raise AssertionError(label + ' (screen saved locally)')
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
    def pointer(self, session_id, timeout=15):
        """One member's loose pointer, waited for rather than read once.

        The member reaches the family file a beat before its pointer reaches
        the index, so a read straight off a row can outrun the write. A write
        in progress is also a read that can fail on Windows - the file is
        briefly open for writing and a reader gets a permission error, not a
        missing file - so both are waited out rather than told apart.
        """
        path = root / 'leaf-families' / 'index' / (session_id + '.json')
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            try:
                return json.loads(path.read_text(encoding='utf-8'))
            except (FileNotFoundError, PermissionError):
                self.pump()
                time.sleep(.05)
        raise AssertionError('no pointer written for ' + session_id)
    def close_leaves(self, timeout=90):
        """Close every member of the family, asking again for any that did not take.

        A close is a command typed into the window, and a typed command is lost
        while the window repaints or a turn holds the prompt - which reads as a
        member that would not close. Asking for the whole set once and then
        waiting on the file made a single lost keystroke fail the probe; each
        member is asked for again until its own row says closed.
        """
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            pending = [member for member in self.leaves() if member['status'] == 'open']
            if not pending: return
            for member in pending:
                # A busy app can leave the previous ask sitting in the input box,
                # and the next paste then joins it into one long command - which
                # is a close that never runs, read as a member that would not
                # close. Ctrl-U is the clear `typed_in` uses.
                self.proc.write('\x15'); self.pause(.3)
                self.submit('/leaf close ' + member['sessionId'])
            self.pause(1)
        self.dump()
        raise AssertionError('leaves closed before the window leaves (screen saved locally)')
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
        A leaf opening or closing redraws the bar for as long as its process
        takes to come and go, so the retries are spread over several seconds
        rather than a few hundred milliseconds.
        """
        for attempt in range(6):
            self.click(self.all_label())
            self.pause(.6 + .4 * attempt)
            if 'All sessions - click to switch' in self.text(): return
        self.dump()
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

        The list is opened here rather than assumed to still be open: a leaf
        booting or a turn running redraws the bar and drops the list, and a
        dropped list reads exactly like a click that missed - so the gesture is
        repeated rather than waited on over a bar that is closed.
        """
        def matches():
            lines = self.screen.display
            for row, line in enumerate(lines):
                if 'All sessions - click to switch' not in line: continue
                for below in range(row + 1, len(lines)):
                    if lines[below].strip(' │'):
                        return [(len(lines[below]) - len(lines[below].lstrip(' │')) + 1, below + 1)]
                break
            return []
        self.pause(.5)
        for _ in range(3):
            if not matches():
                self.expand_bar()
                self.pause(.6)
            found = matches()
            if found:
                x, y = found[0]
                self.proc.write(f'\x1b[<0;{x};{y}M'); self.pause(.08)
                self.proc.write(f'\x1b[<0;{x};{y}m'); self.pause(.25)
                return
        self.dump()
        raise AssertionError('visible first carousel entry (screen saved locally)')
    def first_item_label(self):
        """The carousel's first entry, as the session on screen draws it.

        That entry is the session this window leaves for, so it carries that
        session's name. It is read from the expanded list rather than the
        collapsed bar: the bar truncates to the box width and blanks it when
        the list is not open, while the list gives the label whole.

        A leaf draws this bar exactly as the window that owns the family draws
        it, so from a leaf the first entry is the way out of the leaf. It used
        to be the leaf's own name there - the session you are already in, with
        the one that owns the family left unnamed in the slot kept for it.
        """
        self.expand_bar()
        lines = self.screen.display
        header = next((row for row, line in enumerate(lines) if 'All sessions - click to switch' in line), None)
        assert header is not None, 'the session bar would not expand'
        label = None
        for row in range(header + 1, len(lines)):
            text = lines[row].strip(' │')
            if text:
                label = text
                break
        self.click('Close list')
        self.wait(lambda: 'All sessions - click to switch' not in self.text(), 'the list to close', 5)
        assert label, 'the session bar lists nothing'
        return label
    def original(self, draft=None):
        self.point_first_item()
        self.witness(self.id, 'the original session', draft)
        self.pause(.5)
    def leaf(self, index, permission=False, draft=None):
        """Select a member from the bar, and ask again if the switch did not take.

        A leaf that is still starting is alive, so the bar offers it - but
        taking the terminal is a handoff that completes only once the leaf is
        reading, so a press that lands while it boots is refused rather than
        made, which is what keeps this session from being muted for a leaf that
        cannot answer. A refused switch leaves the session on screen unchanged,
        and that reads exactly like a press that missed the row, so the gesture
        is repeated rather than assumed to have worked the first time. The
        first passes judge the switch on a short lease because a refusal is
        known as soon as the marker comes back stamped with the wrong session;
        the last one keeps the full one so a genuine failure reports itself.
        """
        member = self.leaves()[index]
        for attempt in range(3):
            self.expand_bar()
            self.point_row(member['number'])
            if permission:
                # The pending permission dialog is itself proof of which session
                # is on screen, and is the thing the probe goes on to answer.
                self.wait(lambda: 'Do you want to create approved-leaf.txt?' in self.text(), 'selected leaf UI')
                return
            try:
                self.witness(member['sessionId'], 'the selected leaf', draft, 8 if attempt < 2 else 30)
                return
            except AssertionError:
                if attempt == 2: raise
                self.pause(1)
    def witness(self, session_id, what, draft=None, timeout=30):
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
            self.assert_view(session_id, what, timeout)
    def resize(self, columns, rows):
        self.screen.resize(lines=rows, columns=columns)
        self.proc.setwinsize(rows, columns)
        self.pause(.8)
    def exit(self, family_survives=None):
        """Leave the session with a bare `/exit`, and check what that did.

        This is the bare door, not the graceful one. The menu's "Close this
        session" hands the family to the next leaf in this process and, with no
        leaf to take it, ends the window the way Ctrl-C does; `/exit` is that
        Ctrl-C, and what it does to the leaves is the owner cascade - a session
        leaving takes the leaves it owns with it, they are its children, and the
        harness has watched that happen rather than inferred it (the leaf's pid
        is one of the window's own captured children, and it is gone when the
        window is). What a leave must not do is take the FAMILY with it, and
        that is the second, separate question: the family is held by whichever
        window is holding its terminal, so a window that is not that one can end
        every leaf it has and still leave the family running in the window that
        made it. Neither answer on its own describes that case - the leaves are
        gone and the family is not - so both are read, and the file is what
        answers the second one.
        """
        self.capture_owned()
        leaves = self.owned_leaves()
        # `/exit` is a keystroke, and a keystroke is dropped while a turn or a
        # repaint holds the input - which reads as a session that would not
        # leave. The door is asked for again rather than waited on, and only the
        # last attempt gets the full lease so a genuine failure reports itself.
        #
        # A retry clears the composer first, because the usual reason a leave did
        # not take is that the line was not `/exit` at all: the previous command
        # was still sitting there, so `/exit` was appended to it and the surface
        # refused the result. The first attempt is left exactly as it was - the
        # extra keystroke is only spent once the plain one has failed.
        for attempt in range(3):
            if not self.proc.isalive(): break
            if attempt: self.proc.write('\x15'); self.pause(.3)
            self.submit('/exit')
            try:
                self.wait(lambda: not self.proc.isalive(), 'graceful root exit', 10 if attempt < 2 else 30)
                break
            except AssertionError:
                if attempt == 2: raise
        # Taken before the leave, and read after it: a leaf is a child of the
        # window that started it, so one that outlives the window is the cascade
        # having failed. Only leaves are read - a turn's own background task is
        # not a leaf and is not this claim's business.
        _, alive = psutil.wait_procs(leaves, timeout=20)
        assert not alive, 'Graceful exit left a leaf running: ' + str([p.pid for p in alive])
        if family_survives is None:
            # The leaver's own row is left as it was last seen - `open` is what a
            # member was doing, not a claim that it is still up, so a window that
            # has just gone is still `open` in the file - which is why it cannot
            # count as evidence that the family is held. Another member's row is
            # read instead, the creator's included: a family a member left is
            # held by the window that made it exactly as much as by any other.
            family_survives = any(member['status'] == 'open' and member['sessionId'] != self.id
                                  for member in self.family().get('members', []))
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
    # The bar on screen is the leaf's own here, and its first entry is the way
    # out of the leaf: the session that owns the family, called by the family's
    # name. It used to be the leaf, so the patriarch was unnamed in the slot kept
    # for it and the leaf appeared twice - once bare, once with its number. The
    # name is read from the pointer the family writes for this member, the same
    # value the owning session publishes in the snapshot this leaf draws from,
    # so the check fails if either end disagrees.
    leaf_pointer = t.pointer(leaf_id)
    leaf_member = next(member for member in t.family()['members'] if member['sessionId'] == leaf_id)
    first_item = t.first_item_label()
    assert first_item == leaf_pointer['rootName'], (
        'the leaf bar names ' + repr(first_item) + ' where the patriarch ' + repr(leaf_pointer['rootName']) + ' belongs')
    assert first_item != leaf_member['name'], 'the leaf names itself in the slot kept for the patriarch'
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

def probe_inline_ownership():
    """ITEM 2 re-root: on the REAL target, does CC own the mouse well enough
    that its own controls work AND a drag selection still finishes?

    Ahmed's live symptom: "selection wins - I can select everything, it never
    clears, and I cannot click or interact with anything." That is a
    user-visible failure of the inline mouse lane, and it was green on every
    guard/wire assertion we had (armed? SGR-on-wire?) because those assert the
    proxy, not the outcome. This probe asserts the OUTCOME in one continuous
    interaction, with NO mode toggle in between:

      (A) clicking a bottom-bar control opens it (the lane owns the mouse), and
      (B) a drag-select then finishes on release - the selection clears and the
          text is copied - with no keystroke or resize to shake it loose.

    It is run under --mux-report-filter (a mux pane that answers only the
    DEC-private CPR), which is the topology the real session is in. Both must
    hold simultaneously; either one alone is the bug.
    """
    evidence = {}

    # The decision path is what the item turns on, and it is a debug log line,
    # not a screen reading. Point the log INSIDE the evidence dir so the raw
    # arm/relay/timeout verdicts are captured with the run rather than left in
    # a config home that is deleted with the fixture.
    t = Terminal(env_extra=dict(DEBUG='1', CLAUDE_CODE_DEBUG_LOGS_DIR=str(root / 'inline-mouse.log')))
    t.wait(lambda: 'All 1' in t.text(), 'initial session', 60)
    t.submit('OWNERSHIP_MARKER_ALPHA')
    t.wait(lambda: 'FIXTURE_REPLY_OWNERSHIP_MARKER_ALPHA' in t.text(), 'root reply')

    def last_copied(since):
        if len(t.clipboard_writes()) <= since: return None
        return base64.b64decode(t.clipboard_writes()[-1]).decode('utf-8', 'replace')

    # (A) The bottom bar renders and a control in it is a pointer target.
    #     A click must open the control - not be swallowed by a selection.
    t.check(lambda: '✎ Rename' in t.text() or 'session:' in t.text(), 'bottom bar is on screen')
    t.click('✎ Rename')
    t.wait(lambda: 'Session metadata' in t.text(), 'clicking the bottom-bar control opens it (lane owns the mouse)')
    evidence['bottomBarClickOpens'] = True
    t.proc.write('\x1b'); t.pause(.6)
    t.wait(lambda: 'Session metadata' not in t.text(), 'dialog dismissed')

    # (B) A drag-select finishes on release: the copy happens, and no stale
    #     drag state carries out of the gesture. No mode toggle, no resize.
    #     Drag across the whole marker: the reply line starts with an indent, so
    #     the end column is the marker's own length past its first character.
    anchor = t.point('FIXTURE_REPLY_OWNERSHIP_MARKER_ALPHA')
    before = len(t.clipboard_writes())
    t.drag(anchor, (min(args.columns - 1, anchor[0] + len('FIXTURE_REPLY_OWNERSHIP_MARKER_ALPHA')), anchor[1]))
    t.check(lambda: len(t.clipboard_writes()) > before, 'drag-select did not finish: no copy reached the clipboard')
    copied = last_copied(before)
    t.check(lambda: 'FIXTURE_REPLY_OWNERSHIP_MARKER_ALPHA' in copied,
            'drag-select copied the wrong text: ' + repr(copied))
    evidence['dragSelectFinishes'] = True

    # (C) The two must not be mutually exclusive: after the selection, a click
    #     on a control STILL opens it. If owning the mouse killed selection -
    #     or selection killed the click - one of (A)/(B)/(C) is the bug.
    t.proc.write('\x1b'); t.pause(.4)
    t.click('✎ Rename')
    t.wait(lambda: 'Session metadata' in t.text(), 'control still clicks AFTER a selection (no mode toggle between)')
    evidence['clickAfterSelection'] = True

    t.exit()
    print(json.dumps(dict(inlineOwnership=True, **evidence)), flush=True)

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
    """A leaf is an entry point, and the patriarch is a designation that moves.

    The three things the old model could not do, all of them on fresh sessions:
    a member resumed on its own with `cc --resume <leaf id>` is a full entry
    point - it finds its family, opens new leaves and reopens existing ones;
    which member is the patriarch can be designated, and the family then takes that
    member's name while the session that was the patriarch becomes an ordinary
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
    # The member's row is up before its process is: entering the new member is
    # deferred to the moment that process is listening, so a switch away before
    # then is undone by the boot it was racing - the pane that was clicked is
    # replaced while the click is in flight, and the keystroke that follows lands
    # in the member that booted. Witness the boot first, exactly as the Alpha
    # creation above does, and the switch back is the one that stays.
    t.assert_view(t.leaves()[1]['sessionId'], 'the new leaf', 75)
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
    assert s.family()['members'][0]['sessionId'] == t.id, 'the roster a member reads is missing its patriarch'

    # A full entry point: it opens a new leaf, and that leaf copies the
    # conversation on screen - the leaf - rather than the patriarch behind it.
    s.submit('/leaf new Gamma')
    s.wait(lambda: len(s.leaves()) == 3, 'gamma created from the leaf', 75)
    gamma = max(s.leaves(), key=lambda member: member['number'])
    assert gamma['name'] == 'Gamma', 'the new leaf did not take the name it was given: ' + repr(gamma['name'])
    assert gamma['parentSessionId'] == alpha['sessionId'], 'a leaf forked the patriarch instead of itself'
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

    # Designate the member we are in as the patriarch. Nothing is created and no
    # number moves; what changes is which member the family is named after.
    before = s.family()
    s.submit('/leaf patriarch ' + beta['sessionId'])
    s.wait(lambda: 'is now the family patriarch' in s.text(), 'patriarch conferred', 30)
    after = s.family()
    assert after['nextNumber'] == before['nextNumber'], 'conferring the patriarch created a member'
    assert len(after['members']) == len(before['members']), 'conferring the patriarch changed the roster'
    assert after['returnedContextIds'] == before['returnedContextIds'], 'conferring the patriarch invalidated the context receipts'
    # The designation lives in the creator's pointer, which is what every member
    # reads, and every pointer is rewritten with the patriarch the family has now.
    designation = t.pointer(t.id)
    assert designation['patriarchSessionId'] == beta['sessionId'], 'the designation did not move'
    for member in after['members']:
        pointer = t.pointer(member['sessionId'])
        assert pointer.get('patriarchSessionId') == beta['sessionId'], 'a member pointer still names the old patriarch'
    # The titles move, not the rows: the family reads as the member designated
    # as its patriarch, and the session that was the patriarch reads as a leaf of it.
    assert title_of(beta['transcriptPath']) == beta['name'], 'the new patriarch did not take the family name: ' + repr(title_of(beta['transcriptPath']))
    assert title_of(creator['transcriptPath']) == 'Leaf %s: %s' % (creator['number'], creator['name']), 'the old patriarch did not become a leaf: ' + repr(title_of(creator['transcriptPath']))
    # The roster agrees with it: the member that was the patriarch is offered as one
    # that could be made the patriarch, and the member that is the patriarch is not.
    s.menu()
    s.pick('Leaves in this family')
    s.wait(lambda: 'Make patriarch #%s ' % creator['number'] in s.text(), 'the old patriarch is offered as a patriarch again', 30)
    assert 'Make patriarch #%s ' % beta['number'] not in s.text(), 'the patriarch is offered as its own replacement'
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
    assert 'Make patriarch #' not in t.text(), 'a displaced window still offers to confer the patriarch'
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
    # The creator leaving does not end the family - the window that resumed the
    # member is holding its terminal, and the leaves that window owns are the
    # ones the creator's leave does not touch. This is the last window out, so
    # nothing is left to hold anything: every lock, the leaves' included, has to
    # be back. That is what the strict reading asserts, and it is said here
    # rather than read off the file, because the creator's own row is still
    # `open` in it and would read as a family nobody is holding.
    s.exit(family_survives=False)
    print(json.dumps(dict(parentage=True, directResume=True, leafOpensLeaves=True, leafReopensLeaves=True, patriarch=True, familyTakesPatriarchName=True, oldPatriarchBecomesLeaf=True, displacedRefusesManagement=True, displacedKeepsTerminals=True)), flush=True)

def probe_close_matriarch():
    """A leaf closes the matriarch it belongs to, and a session that closes itself leaves.

    The window that created the family is showing the leaf by the time the close
    is asked for, so the keystroke is handled by the leaf's own process and the
    request reaches the session hosting the family stamped with the leaf's id.
    The refusal that used to greet it was decided by the process executing the
    request - the matriarch, which here is the very member the leaf asked for - so
    a leaf was told it was the session it was trying to close. The rule is about
    the session that asks: a leaf is refused for itself and for nothing else, and
    a session asking to close itself is not refused at all - it leaves.
    """
    t = Terminal()
    t.wait(lambda: 'All 1' in t.text(), 'initial session', 60)
    t.submit('/leaf new Alpha')
    t.wait(lambda: len(t.leaves()) == 1 and 'All 2' in t.text(), 'alpha created', 75)
    alpha = t.leaves()[0]
    # The leaf is on screen in the window that made it, so what is typed here is
    # handled by the leaf's process, which forwards management to its matriarch.
    t.assert_view(alpha['sessionId'], 'the new leaf on screen', 75)
    matriarch = next(member for member in t.family()['members'] if member['sessionId'] == t.id)

    # The matriarch is an ordinary member to the leaf, and the leaf closes it.
    t.menu()
    t.pick('Leaves in this family')
    close_matriarch = 'Close #%s %s' % (matriarch['number'], matriarch['name'])
    t.wait(lambda: close_matriarch in t.text(), 'the leaf menu offers the matriarch for closing', 30)
    t.pick(close_matriarch)
    t.wait(lambda: next(member for member in t.family()['members'] if member['sessionId'] == t.id)['status'] == 'closed',
           'a leaf closes the matriarch it belongs to', 45)
    # The window the person is looking through is still running: the close is the
    # member's, not the session that carries it out.
    assert t.proc.isalive(), 'the window ended when a leaf closed its matriarch'
    # The designation moves down with the departure, and the move is the whole
    # point of it: a patriarch that has gone takes the family's name with it, and
    # a designation naming a session that is no longer a member is ignored by
    # every reader - so the family would otherwise be named after a conversation
    # that is no longer in it and `patriarch` would resolve to nothing. The
    # successor is the lowest-numbered member still in the family, which here is
    # the leaf that did the closing, and every member's own pointer has to agree
    # or a member resumed later reads the family it used to belong to.
    #
    # The move is two writes, not one: the creator's pointer is designated first
    # and the rest are republished from it afterwards, so reading them once is
    # reading a convergence part way through it. What has to be true is that
    # they agree, which is what is waited for - the creator's pointer alone
    # would pass a moment before the members' do.
    def designated():
        for session_id in [t.id, *(member['sessionId'] for member in t.family()['members'])]:
            path = root / 'leaf-families' / 'index' / (session_id + '.json')
            try: pointer = json.loads(path.read_text(encoding='utf-8'))
            except (OSError, ValueError): return False
            if pointer.get('patriarchSessionId') != alpha['sessionId']: return False
        return True
    t.wait(designated, 'the designation moved to the closing leaf, in every member pointer', 30)
    # And the move is said out loud where the close was asked for, so the person
    # watching the leaf is told the family they are still in has a new patriarch.
    t.assert_view(alpha['sessionId'], 'promoted conversation owns the terminal', 75)
    claim = json.loads((root / 'leaf-families' / 'index' / (t.id + '.host.json')).read_text(encoding='utf-8'))
    assert claim['matriarchSessionId'] == alpha['sessionId'], 'designation changed without transferring session ownership'

    # The terminal moved to the leaf, so the session on screen is the matriarch
    # now, and closing it is leaving it: no other leaf is open to take the family,
    # so it leaves the way Ctrl-C leaves - the window ends, and the family keeps
    # its leaves and its files.
    t.submit('/leaf close ' + alpha['sessionId'])
    t.wait(lambda: not t.proc.isalive(), 'a session that closes itself leaves', 60)
    print(json.dumps(dict(leafClosesMatriarch=True, selfCloseLeaves=True, matriarchSurvivesClose=True, closePromotes=True, sessionOwnerTransferred=True)), flush=True)

def leaf_process(session_id):
    """The process running a member's own conversation, found by the id it runs under.

    A leaf is spawned detached, so it is not reliably a child of the window that
    made it - and it is exactly that independence this probe is about. The
    session id it was started with is on its command line and belongs to nothing
    else on the machine.
    """
    for process in psutil.process_iter(['pid', 'cmdline']):
        try: line = process.info['cmdline'] or []
        except psutil.NoSuchProcess: continue
        if any(session_id in part for part in line): return process
    return None

def exited(process, born, timeout):
    """Whether a process ended, without being fooled by a recycled pid."""
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            if not process.is_running() or process.create_time() != born: return True
        except (psutil.NoSuchProcess, psutil.AccessDenied): return True
        time.sleep(.2)
    return False

def probe_owner_cascade():
    """The leaves go when the session that owns them goes, and only then.

    A leaf outliving its launcher is the ordinary case for the transport - the
    launcher exiting is only "nobody is watching", and the leaf is picked up
    again by whoever opens it next. That is the wrong answer when the launcher is
    the matriarch: the leaves belong to that session, so a crash, a Ctrl-C
    or a closed terminal takes them with it. A pid cannot prove the owner,
    because Windows hands a dead process's number to whatever starts next; the
    owner answers on a private endpoint instead, and the leaf ends when that
    endpoint stops answering.

    The other half is the isolation, and it is why the two are checked together:
    one leaf leaving is one leaf leaving, and the window and its siblings must not
    notice.
    """
    t = Terminal()
    t.wait(lambda: 'All 1' in t.text(), 'initial session', 60)
    t.submit('/leaf new Alpha')
    t.wait(lambda: len(t.leaves()) == 1 and 'All 2' in t.text(), 'alpha created', 75)
    t.submit('/leaf new Beta')
    t.wait(lambda: len(t.leaves()) == 2 and 'All 3' in t.text(), 'beta created', 75)
    alpha, beta = t.leaves()[0], t.leaves()[1]
    alpha_proc, beta_proc = leaf_process(alpha['sessionId']), leaf_process(beta['sessionId'])
    assert alpha_proc and beta_proc, 'a leaf runs as a process of its own'
    alpha_born, beta_born = alpha_proc.create_time(), beta_proc.create_time()

    # One leaf leaving, on its own.
    t.submit('/leaf close ' + alpha['sessionId'])
    t.wait(lambda: next(member for member in t.family()['members'] if member['sessionId'] == alpha['sessionId'])['status'] == 'closed',
           'one leaf closes', 45)
    assert exited(alpha_proc, alpha_born, 15), 'a closed leaf kept running'
    assert t.proc.isalive(), 'closing a leaf took the window with it'
    assert beta_proc.is_running() and beta_proc.create_time() == beta_born, 'closing a leaf took its sibling with it'

    # The crash. The window is killed outright, so no cleanup runs and nothing
    # gets to say goodbye - which is the case the owner endpoint exists for. Only
    # the window's own process is killed: a kill that took the tree would prove
    # nothing, because the leaves would be gone by force rather than by the rule.
    psutil.Process(t.proc.pid).kill()
    assert exited(beta_proc, beta_born, 40), 'a leaf outlived the matriarch that owned it'
    print(json.dumps(dict(leafExitIsolated=True, ownerCrashCascades=True)), flush=True)

def probe_exit_cascade():
    """What a bare `/exit` does to the leaves the window owns, and what can see it.

    Two questions the campaign turns on, and both are about this harness before
    they are about the product. The first is whether the processes a window
    spawns are reachable as its children at all: a leaf is spawned detached, so
    a check that walks the window's children may be blind to every leaf - and a
    blind check cannot say whether a leaf lived or died, only that it did not
    see one. The second is what `/exit` leaves behind: the leaf's process, its
    row in the family file, and the writer lock it held.

    The menu's "Close this session" is the graceful door and is not this one -
    it hands the family to the next leaf, in this process, and with no leaf to
    take it, ends the window the way Ctrl-C does. `/exit` is the bare door, so
    what it must do is take the leaves it owns with it and leave nothing of
    them running.
    """
    t = Terminal()
    t.wait(lambda: 'All 1' in t.text(), 'initial session', 60)
    t.submit('/leaf new Alpha')
    t.wait(lambda: len(t.leaves()) == 1 and 'All 2' in t.text(), 'alpha created', 75)
    alpha = t.leaves()[0]
    t.assert_view(alpha['sessionId'], 'the new leaf', 75)
    t.original()
    child = leaf_process(alpha['sessionId'])
    assert child, 'the leaf does not run as a process of its own'
    born = child.create_time()
    # The instrument question, asked of a leaf that is certainly up.
    t.capture_owned()
    owned = sorted(process.pid for process in t.running_owned())
    locks_before = sorted(path.name for path in (root / 'gateway-writers').glob('*.lock'))
    t.submit('/exit')
    t.wait(lambda: not t.proc.isalive(), 'the window leaves', 60)
    gone = exited(child, born, 20)
    row = next((member['status'] for member in t.leaves() if member['sessionId'] == alpha['sessionId']), None)
    print(json.dumps(dict(
        exitCascade=True,
        leafPid=child.pid,
        ownedPids=owned,
        leafIsOwnedChild=child.pid in owned,
        leafEndedWithTheWindow=gone,
        leafRowAfterExit=row,
        writerLocksBefore=locks_before,
        writerLocksAfter=sorted(path.name for path in (root / 'gateway-writers').glob('*.lock')),
        windowLockReleased=not (root / 'gateway-writers' / (t.id + '.lock')).exists(),
    )), flush=True)

def probe_resumed_member():
    """A member entered on its own is that member, not the family's patriarch.

    `cc --resume <leaf id>` is the address the leaf menu prints for every
    member, and it is the door a person uses - but it carries none of the launch
    environment a spawn carries, so the window it opens has to know the member
    from the family's own records rather than from how it was started. It is not
    a leaf by that test and its bar is drawn as the window that owns the family
    draws it, so what is read here is the part a person acts on: the roster's
    own "the session you are in" line, and the source the create wizard already
    holds when it opens. The wizard is the surface the family surface is
    entered through, and its source is the row that decides which conversation
    the next leaf copies.
    """
    t = Terminal()
    t.wait(lambda: 'All 1' in t.text(), 'initial session', 60)
    t.submit('/leaf new Alpha')
    t.wait(lambda: len(t.leaves()) == 1 and 'All 2' in t.text(), 'alpha created', 75)
    alpha = t.leaves()[0]
    # Creating a leaf leaves it on screen, and a keystroke typed into a member
    # before its REPL reaches its input loop is lost - which reads as a member
    # that ignored the command rather than as one that was not listening yet.
    t.assert_view(alpha['sessionId'], 'the new leaf', 75)
    t.original()
    # A member whose process is still up is the double-driver case; a clean
    # resume wants it finished first, exactly as the parentage probe does. The
    # close is typed in the window showing the original, which is what makes it
    # the original closing the leaf rather than the leaf closing itself.
    t.submit('/leaf close ' + alpha['sessionId'])
    t.wait(lambda: t.leaves()[0]['status'] == 'closed', 'alpha closed for a clean resume')
    # What the window that owns the family draws in the slot kept for the
    # session it leaves for: the family's name, because the session on screen is
    # the family's patriarch. The resumed member is read against this.
    patriarch_name = t.first_item_label()

    # Enter the leaf directly, the way a person would from any terminal.
    s = Terminal(alpha['sessionId'])
    s.wait(lambda: 'All ' in s.text(), 'the resumed leaf', 90)
    s.assert_view(alpha['sessionId'], 'the leaf entered with --resume', 90)
    bar = s.first_item_label()
    # The menu's own sentence about what a new leaf copies. It is the first place
    # the window's answer to "which member am I" is visible, and the wizard opens
    # holding the same reading.
    s.menu()
    # The sentence is written from the roster, and the roster is a file read: the
    # first frame names the session it has not looked up yet by its id. What a
    # person reads is the settled screen.
    s.wait(lambda: 'saved —' in s.text() or 'Read-only' in s.text(), 'the menu roster', 30)
    home = s.text()
    readings = dict(member=alpha['name'], patriarch_name=patriarch_name, bar=bar, home=home)
    assert 'forks the session you are looking at: %s.' % alpha['name'] in home, (
        'the menu does not name the member on screen as the conversation a leaf copies: ' + json.dumps(readings))
    # The wizard's own source row, which is what "fork from this leaf" means.
    s.pick('Create a leaf')
    s.wait(lambda: 'Fork source:' in s.text(), 'the create wizard', 30)
    source_row = next((line.strip() for line in s.screen.display if 'Fork source:' in line), '')
    readings['source_row'] = source_row
    # A leaf entered on its own offers itself as the conversation a new leaf
    # copies; naming the family's patriarch here is the failure.
    assert source_row, 'the wizard has no source row'
    assert 'Fork source:' in source_row and alpha['name'] in source_row, (
        'the wizard does not fork the member on screen: ' + json.dumps(readings))
    # The same fact read on the roster: the window says which member it is, so
    # its own row is not offered to it as somebody else's to open or close. Read
    # before anything is started: a fork's own boot switches the pane, and the
    # overlay goes with it, so the roster is up only while nothing is launching.
    s.proc.write('\x1b'); s.pause(.6)
    s.pick('Leaves in this family')
    s.wait(lambda: 'is the session you are in' in s.text(), 'the roster', 30)
    roster = s.after('Leaves in this family')
    readings['roster'] = roster
    assert 'is the session you are in' in roster, 'the window does not say which member it is: ' + json.dumps(readings)
    assert 'Close #%s ' % alpha['number'] not in roster, 'the window offers its own row for closing: ' + json.dumps(readings)
    # Now make the fork the reading is about.
    s.proc.write('\x1b'); s.pause(.6)
    s.pick('Create a leaf')
    s.wait(lambda: 'Fork source:' in s.text(), 'the create wizard', 30)
    s.proc.write('ResumedFork')
    s.pick_row('Create leaf —')
    s.wait(lambda: len(s.leaves()) == 2, 'fork made by the resumed member', 75)
    made = max(s.leaves(), key=lambda member: member['number'])
    readings['made_ancestry'] = made['parentSessionId']
    assert made['parentSessionId'] == alpha['sessionId'], 'the resumed member forked something other than the member on screen: ' + json.dumps(readings)
    # The fork took the pane: a member is drawn by the window that made it, and
    # keystrokes go to whatever is drawn. Step back onto the session this window
    # is - the bar's first entry - before leaving, or `/exit` lands on the leaf.
    s.proc.write('\x1b'); s.pause(.5)
    s.original()
    print(json.dumps(dict(resumedMember=True, wizardForksMember=True, rosterNamesSelf=True, readings=readings)), flush=True)
    # The window that resumed the member held the family's terminal, so the fork
    # it started is one of its own leaves and goes down with it - while the
    # family does not, because the window that made the family is still open.
    # That is the pair this leave is checked against: no process of this
    # window's left running, and the family still held. The creator is leaving
    # last with a live leaf under it again - the member it closed is reopened,
    # which is what puts a process of this window's back - and a bare `/exit`
    # takes that leaf with it too, so the creator's leave is the same cascade in
    # a family that is still held elsewhere.
    s.exit(family_survives=True)
    t.submit('/leaf reopen ' + alpha['sessionId'])
    t.wait(lambda: any(member['sessionId'] == alpha['sessionId'] and member['status'] == 'open' for member in t.leaves()), 'the member reopened under its creator', 90)
    t.exit()

def probe_creator_after_patriarch():
    """A family designation must not change the window's identity or default fork."""
    t = Terminal()
    t.wait(lambda: 'All 1' in t.text(), 'initial session', 60)
    t.submit('/leaf new Tokens')
    t.wait(lambda: len(t.leaves()) == 1 and 'All 2' in t.text(), 'Tokens created', 75)
    tokens = t.leaves()[0]
    t.assert_view(tokens['sessionId'], 'Tokens', 75)
    t.original()
    before = t.first_item_label()
    t.submit('/leaf patriarch ' + tokens['sessionId'])
    t.wait(lambda: 'is now the family patriarch' in t.text(), 'Tokens designated', 30)
    t.assert_view(t.id, 'creator remains the conversation on screen')
    t.leaf(0)
    leaf_host_label = t.first_item_label()
    t.original()
    bar = t.first_item_label()
    t.menu()
    t.wait(lambda: 'saved —' in t.text(), 'menu roster', 30)
    home = t.text()
    t.pick('Create a leaf')
    t.wait(lambda: 'Fork source:' in t.text(), 'wizard', 30)
    source_row = next(line.strip() for line in t.screen.display if 'Fork source:' in line)
    t.proc.write('CreatorFork')
    t.pick_row('Create leaf —')
    t.wait(lambda: len(t.leaves()) == 2, 'fork created', 75)
    made = max(t.leaves(), key=lambda member: member['number'])
    t.assert_view(made['sessionId'], 'new fork', 75)
    result = dict(before=before, bar=bar, leaf_host_label=leaf_host_label, source_row=source_row, creator=t.id,
                  designated_patriarch=tokens['sessionId'], made_ancestry=made['parentSessionId'])
    print(json.dumps(result), flush=True)
    t.check(lambda: made['parentSessionId'] == t.id, 'wizard forked the designated patriarch instead of the creator on screen')
    t.check(lambda: 'Tokens' not in leaf_host_label, 'leaf return-to-host slot is labeled Tokens')
    t.check(lambda: 'Tokens' not in bar, 'creator slot is labeled Tokens')
    t.check(lambda: 'Tokens' not in source_row, 'default source names Tokens')
    t.expand_bar()
    t.point_first_item()
    t.proc.write('\x1b'); t.pause(.5)
    t.proc.write('\x1b'); t.pause(.5)
    t.assert_view(t.id, 'creator after closing its menu')
    t.exit()


def probe_elder():
    """An elder: a member that held the role, parked, and still answering.

    Succession is rare and it is the whole point of a family, and nothing
    witnesses it today. Archive is the near-neighbour - a member detaches, goes
    hidden, and its transcript is kept - but nothing marks a member as having
    HELD the role and being consultable afterwards. This drives the path that
    matters: a member takes the designation, learns something only it has, is
    parked, and is read back. What it must still answer with is the memory only
    it had, and what the family must say about it is that it held the role.

    Two readings are kept apart on purpose. The recall half is mechanical and
    should hold already, because the bytes are on disk and the family holds the
    path. The elder half is the product concept, and the assertion that names it
    is the gate for the whole design rather than a bug report about a read.
    """
    t = Terminal()
    t.wait(lambda: 'All 1' in t.text(), 'initial session', 60)
    t.submit('/leaf new Elder')
    t.wait(lambda: len(t.leaves()) == 1 and 'All 2' in t.text(), 'the elder member', 75)
    elder = t.leaves()[0]
    t.assert_view(elder['sessionId'], 'the elder member', 75)

    # The memory only this member has. The fixture answers the marker, so the
    # turn is real and the bytes it leaves are this member's own.
    t.submit('ELDER_SECRET_')
    t.wait(lambda: 'FIXTURE_REPLY_ELDER_SECRET_' in t.text(), 'the elder learns something only it has', 45)

    # It takes the designation first: an elder is a member that HELD the role,
    # so holding it is the thing that has to be recorded before the park.
    t.original()
    t.submit('/leaf patriarch ' + elder['sessionId'])
    t.wait(lambda: 'is now the family patriarch' in t.text(), 'the elder holds the role', 30)

    # Park it. Archiving detaches and hides it while keeping its transcript. The
    # wait is for "no longer open", not for the word `archived`: the member is a
    # live process, and archiving it ends that process, whose exit handler files
    # it back as `closed` (leafWorkspace.ts onExit). Which of the two words the
    # row ends on is a race this probe must not depend on - what "parked" means
    # here is that it is out of the open list and its bytes are still on disk.
    t.submit('/leaf archive ' + elder['sessionId'])
    t.wait(lambda: 'Leaf archive recorded' in t.text(), 'the archive is recorded', 30)
    t.wait(lambda: any(member['sessionId'] == elder['sessionId'] and member['status'] != 'open'
                       for member in t.leaves()), 'the elder is parked', 60)

    # Consultable while parked: the bytes are on disk and the family holds the
    # path, so a read reaches the memory without the member running. This is the
    # difference between consulting an elder and restarting one.
    t.submit('/leaf read ' + elder['sessionId'])
    t.wait(lambda: 'ELDER_SECRET_' in t.after('/leaf read ' + elder['sessionId']),
           'the parked elder is read on demand', 45)
    t.check(lambda: '[peer session transcript' in t.after('/leaf read ' + elder['sessionId']),
            'the parked elder read was not labelled as peer-authored text')

    # THE ELDER MARK. A member that held the role and is now parked is an elder:
    # the record carries the one durable fact that it held the role, so an
    # ex-patriarch is filed differently from a member that was merely parked.
    # The message prints the whole record, so a failure names what is there.
    record = next((member for member in t.family()['members'] if member['sessionId'] == elder['sessionId']), None)
    t.check(lambda: record is not None and record.get('eldership') is True,
            'the family does not mark a member that held the role as an elder: ' + json.dumps(record))

    # Back and recall: the member itself must still carry the memory it had.
    # Reopening starts the member; it does not put it on screen, so the bar is
    # how the probe gets to it - the same gesture a person makes to open an elder.
    t.submit('/leaf reopen ' + elder['sessionId'])
    t.wait(lambda: any(member['sessionId'] == elder['sessionId'] and member['status'] == 'open'
                       for member in t.leaves()), 'the elder is reopened', 90)
    t.leaf(0)
    t.check(lambda: 'ELDER_SECRET_' in t.text(), 'the reopened elder lost the memory only it had')

    t.original()
    t.close_leaves(60)
    t.exit()
    print(json.dumps(dict(elder=True, parkedAs=record.get('status'), marked=True,
                          readableWhileParked=True, reopened=True, recalled=True)), flush=True)


def probe_arc():
    """The succession arc, end to end, in one family.

    Succession is the point of a family - one conversation raises another, hands
    the role over, and steps back into a place the rest of the family can still
    reach - and nothing has witnessed that as ONE sequence. The pieces exist (a
    designation, an elder mark, a read that reaches a parked member), but a piece
    is not an arc. This drives the whole thing in a live window and answers three
    questions at once:

      1. Before the handover the successor is WORKING. It holds something the
         patriarch told it, told in a real turn - not merely a pointer that names
         it - so the raise is a relationship and not a label.
      2. The handover is ATOMIC. One command makes the successor the patriarch,
         clears the heir designation, and files the member it displaced as an
         elder; one read of the family afterwards shows all three together, so
         they cannot have happened as separate steps that drifted apart.
      3. After the former patriarch is parked it is reachable by a THIRD PARTY.
         A different member - not the one that parked it - reads it and finds the
         memory it kept, so an elder is the family's to consult rather than the
         parker's private record.

    The family: the window is the creator and the matriarch. A is a leaf made the
    patriarch, B is raised as its heir, C is a bystander that does the reading.
    A is parked from the window and read from C, so the parker and the reader are
    different sessions - which is the whole of question 3.
    """
    t = Terminal()
    t.wait(lambda: 'All 1' in t.text(), 'initial session', 60)

    # Three leaves. A will hold the role; B will be raised; C only reads. Each is
    # started by opening it, which is also what gives it a live process to talk
    # to later.
    t.submit('/leaf new Elder')
    t.wait(lambda: len(t.leaves()) == 1 and 'All 2' in t.text(), 'the patriarch-to-be', 75)
    t.assert_view(t.leaves()[0]['sessionId'], 'the patriarch-to-be', 75)
    t.original()
    t.submit('/leaf new Heir')
    t.wait(lambda: len(t.leaves()) == 2 and 'All 3' in t.text(), 'the successor', 75)
    t.assert_view(t.leaves()[1]['sessionId'], 'the successor', 75)
    t.original()
    t.submit('/leaf new Witness')
    t.wait(lambda: len(t.leaves()) == 3 and 'All 4' in t.text(), 'the bystander', 75)
    t.assert_view(t.leaves()[2]['sessionId'], 'the bystander', 75)
    t.original()

    elder, heir, witness = t.leaves()[0], t.leaves()[1], t.leaves()[2]

    # A holds the role. It is a leaf, not the window, so the window can park it
    # the way it parks any member - and so the member that reads it afterwards is
    # a different session again.
    t.submit('/leaf patriarch ' + elder['sessionId'])
    t.wait(lambda: 'is now the family patriarch' in t.after('/leaf patriarch ' + elder['sessionId']),
           'the patriarch holds the role', 45)
    t.check(lambda: t.pointer(t.id).get('patriarchSessionId') == elder['sessionId'],
            'the designation did not move to the member the family was renamed after')

    # The memory only the patriarch has. The fixture answers the marker, so the
    # turn is real and the bytes it leaves are this member's own.
    t.leaf(0)
    t.submit('PATRIARCH_SECRET_')
    t.wait(lambda: 'FIXTURE_REPLY_PATRIARCH_SECRET_' in t.text(), 'the patriarch learns something only it has', 45)
    t.original()

    # Raise the heir: a designation, written where the patriarch's is, so the
    # family reads it and files it. This is the label half - question 1 is what
    # makes it more than a label, and that is the training below.
    t.submit('/leaf heir ' + heir['sessionId'])
    t.wait(lambda: 'is now the family heir' in t.after('/leaf heir ' + heir['sessionId']),
           'the heir is designated', 45)
    t.check(lambda: t.pointer(t.id).get('heirSessionId') == heir['sessionId'],
            'the heir designation is not written where the patriarch’s is')
    # The designation is a filing, not a mode: the member keeps its row and its
    # standing, so nothing about it becomes a patriarch before the handover.
    raised = {member['sessionId']: member for member in t.family().get('members', [])}
    t.check(lambda: raised.get(heir['sessionId'], {}).get('status') == 'open' and
            raised.get(heir['sessionId'], {}).get('eldership') is None,
            'naming the heir changed the member’s own standing, not just its filing')

    # THE TRAINING. The patriarch tells the heir what it knows, in a real turn,
    # and the heir answers. Before the send the heir has never heard it; after,
    # it holds the patriarch's secret on its own screen. That is question 1: the
    # successor is working, and the raise is a conversation, not a pointer move.
    t.submit('/leaf read ' + heir['sessionId'])
    t.wait(lambda: 'Leaf #' in t.after('/leaf read ' + heir['sessionId']), 'the heir can be read', 45)
    t.check(lambda: 'PATRIARCH_SECRET_' not in t.after('/leaf read ' + heir['sessionId']),
            'the heir already held the patriarch’s secret before it was told')
    t.leaf(0)
    t.submit('/leaf send ' + heir['sessionId'] + ' PATRIARCH_SECRET_')
    t.wait(lambda: 'PATRIARCH_SECRET_' in t.after('/leaf send'), 'the patriarch tells the heir', 30)
    t.leaf(1)
    t.wait(lambda: 'FIXTURE_REPLY_PATRIARCH_SECRET_' in t.text(), 'the heir answers with what it was told', 60)
    t.original()

    # THE HANDOVER. One command. The successor takes the role, the heir
    # designation it just realized is cleared, and the member it displaced is
    # filed as an elder - and one read of the family shows all three together,
    # which is question 2: atomic, not three steps that could drift apart.
    t.submit('/leaf patriarch ' + heir['sessionId'])
    t.wait(lambda: 'is now the family patriarch' in t.after('/leaf patriarch ' + heir['sessionId']),
           'the heir ascends', 45)
    pointer = t.pointer(t.id)
    members = {member['sessionId']: member for member in t.family().get('members', [])}
    ascended = pointer.get('patriarchSessionId') == heir['sessionId']
    cleared = pointer.get('heirSessionId') is None
    filed = members.get(elder['sessionId'], {}).get('eldership') is True
    t.check(lambda: ascended, 'the ascension did not make the heir the patriarch')
    t.check(lambda: cleared, 'the heir designation was not cleared in the same write as the ascension')
    t.check(lambda: filed, 'the displaced patriarch was not filed as an elder in the same write as the ascension')
    # The heir that ascended is an ordinary member again, and the elder that was
    # displaced keeps its place - the mark it gained is the only change.
    t.check(lambda: members.get(heir['sessionId'], {}).get('eldership') is None,
            'the heir that ascended was filed as an elder too, not as the patriarch')

    # Park the former patriarch. The window parks it; the reading below is done
    # from another member, so an elder is not the parker's private record. The
    # wait is for "no longer open", not the word `archived`: the member is a live
    # process, and archiving it ends that process, whose exit handler files it
    # back as `closed` (leafWorkspace.ts onExit) - which of the two words the row
    # ends on is a race this probe must not depend on.
    t.submit('/leaf archive ' + elder['sessionId'])
    t.wait(lambda: 'Leaf archive recorded' in t.text(), 'the archive is recorded', 30)
    t.wait(lambda: any(member['sessionId'] == elder['sessionId'] and member['status'] != 'open'
                       for member in t.leaves()), 'the former patriarch is parked', 60)
    parked = next(member['status'] for member in t.family().get('members', [])
                  if member['sessionId'] == elder['sessionId'])

    # QUESTION 3. A third party - the bystander, which neither held the role nor
    # parked the member - reads the parked elder and finds the memory it kept. If
    # only the parker could reach it, the elder would be a personal resource; this
    # is what makes it the family's.
    t.leaf(2)
    t.submit('/leaf read ' + elder['sessionId'])
    t.wait(lambda: 'PATRIARCH_SECRET_' in t.after('/leaf read ' + elder['sessionId']),
           'a third party reaches the parked elder', 45)
    t.check(lambda: '[peer session transcript' in t.after('/leaf read ' + elder['sessionId']),
            'the third-party read was not labelled as peer-authored text')

    t.original()
    t.close_leaves(60)
    t.exit()
    print(json.dumps(dict(elder=elder['sessionId'], heir=heir['sessionId'], witness=witness['sessionId'],
                          heirDesignated=True, trained=True, ascended=ascended, clearedInSameWrite=cleared,
                          elderFiledInSameWrite=filed, parkedAs=parked, thirdPartyRead=True)), flush=True)


def probe_stress():
    """What the family model does when it is pushed.

    Two claims a live surface can falsify, asked of the surface rather than the
    code: that a member cannot raise ITSELF (the write is gated on the matriarch),
    and that a raised successor is the family's answer to losing its patriarch.
    It also looks for the state a discarded successor leaves behind. Nothing is
    asserted away - the surface is asked, and what it does is the result, so a
    refusal is an answer and so is a success the design did not intend.

    Run it against a fresh config tree; it reads and writes only its own family.
    """
    results = {}

    def answered(command, needles, timeout=90):
        t.submit(command)
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            t.pump()
            shown = t.after(command)
            if any(needle in shown for needle in needles):
                return shown
            time.sleep(.05)
        return t.after(command)

    def refusal_line(shown):
        for line in shown.splitlines():
            if 'Leaf operation failed' in line:
                return ' '.join(line.split())[-200:]
        return ''

    t = Terminal()
    t.wait(lambda: 'All 1' in t.text(), 'initial session', 60)

    # Two leaves: Alpha is raised and then tries to take the role itself; Bravo is
    # the rival it is later replaced by.
    t.submit('/leaf new Alpha')
    t.wait(lambda: len(t.leaves()) == 1 and 'All 2' in t.text(), 'Alpha', 75)
    t.assert_view(t.leaves()[0]['sessionId'], 'Alpha', 75)
    t.original()
    t.submit('/leaf new Bravo')
    t.wait(lambda: len(t.leaves()) == 2 and 'All 3' in t.text(), 'Bravo', 75)
    t.assert_view(t.leaves()[1]['sessionId'], 'Bravo', 75)
    t.original()
    alpha, bravo = t.leaves()[0], t.leaves()[1]

    # The window raises Alpha. The ordinary path, expected to work, and the thing
    # everything after it is measured against.
    shown = answered('/leaf heir ' + alpha['sessionId'], ('is now the family heir', 'Leaf operation failed'))
    results['raiseAlpha'] = 'heir' if 'is now the family heir' in shown else (refusal_line(shown) or 'no output')

    # CLAIM 1: the heir cannot name ITSELF the patriarch, by construction. The
    # heir is a member; entering it and asking is exactly what a successor would
    # do, and a relay the matriarch runs on the member's behalf is a relay the
    # member asked for - so if this succeeds, the claim is false.
    t.leaf(0)
    shown = answered('/leaf patriarch ' + alpha['sessionId'], ('is now the family patriarch', 'Leaf operation failed'))
    t.original()
    results['heirSelfPromoted'] = t.pointer(t.id).get('patriarchSessionId') == alpha['sessionId']
    results['heirSelfPromotionSaid'] = 'patriarch' if 'is now the family patriarch' in shown else (refusal_line(shown) or 'no output')

    # A discarded successor. Raise Alpha, replace it with Bravo - the successor
    # that failed - then park Bravo. What does the designation say now? If it
    # still names a parked member, the family points at a successor that cannot
    # succeed.
    answered('/leaf heir ' + alpha['sessionId'], ('is now the family heir', 'Leaf operation failed'))
    answered('/leaf heir ' + bravo['sessionId'], ('is now the family heir', 'Leaf operation failed'))
    answered('/leaf close ' + bravo['sessionId'], ('closed', 'Leaf operation failed'))
    t.wait(lambda: any(item['sessionId'] == bravo['sessionId'] and item['status'] != 'open' for item in t.leaves()),
           'the discarded successor is parked', 60)
    heir_now = t.pointer(t.id).get('heirSessionId')
    parked = {item['sessionId']: item['status'] for item in t.family().get('members', [])}
    results['staleHeirAfterDiscard'] = heir_now == bravo['sessionId'] and parked.get(bravo['sessionId']) != 'open'
    results['heirAfterDiscard'] = None if heir_now is None else (heir_now[:8] + ' (' + str(parked.get(heir_now)) + ')')

    # CLAIM 2: when the patriarch is lost, the raised successor takes over. Bring
    # the rival back, hand Alpha the role, and only THEN raise Bravo - a raise
    # belongs to the patriarch that is training it, so a raise made before the
    # hand-off is ended by the hand-off itself, and measuring the loss against a
    # designation that is already gone would measure nothing. Close Alpha: the
    # lowest-numbered open member wins the promotion, and the question is whether
    # the heir does, or is passed over.
    answered('/leaf reopen ' + bravo['sessionId'], ('reopened', 'Leaf operation failed'))
    t.wait(lambda: any(item['sessionId'] == bravo['sessionId'] and item['status'] == 'open' for item in t.leaves()),
           'the rival is back', 90)
    answered('/leaf patriarch ' + alpha['sessionId'], ('is now the family patriarch', 'Leaf operation failed'))
    answered('/leaf heir ' + bravo['sessionId'], ('is now the family heir', 'Leaf operation failed'))
    results['heirBeforeDeath'] = t.pointer(t.id).get('heirSessionId') == bravo['sessionId']
    answered('/leaf close ' + alpha['sessionId'], ('closed', 'Leaf operation failed'))
    t.wait(lambda: t.pointer(t.id).get('patriarchSessionId') != alpha['sessionId'], 'the role moved off the closed patriarch', 60)
    new_patriarch = t.pointer(t.id).get('patriarchSessionId')
    results['heirPassedOverOnDeath'] = new_patriarch != bravo['sessionId']
    results['newPatriarchAfterDeath'] = new_patriarch[:8] if isinstance(new_patriarch, str) else new_patriarch
    results['heirWas'] = bravo['sessionId'][:8]
    heir_after_death = t.pointer(t.id).get('heirSessionId')
    results['heirAfterDeath'] = None if heir_after_death is None else heir_after_death[:8]

    # Invariants: whatever happened, the family is coherent - one patriarch, the
    # file parses, and no number repeats.
    members = t.family().get('members', [])
    numbers = [item['number'] for item in members]
    results['onePatriarch'] = new_patriarch in {item['sessionId'] for item in members}
    results['numbersUnique'] = len(numbers) == len(set(numbers))

    t.original()
    t.close_leaves(90)
    t.exit()
    print(json.dumps(results, indent=1, sort_keys=True), flush=True)


def member_process(terminal, session_id):
    """The captured child that is running one member of this family.

    A leaf is a process the window started, so the window holds it - the same
    capture `owned_leaves` reads. This picks the one whose command line names the
    member asked for, which is the process that has to die for the member's row
    to be filed back as `closed`.
    """
    for process in terminal.running_owned():
        try: line = process.cmdline()
        except (psutil.NoSuchProcess, psutil.AccessDenied): continue
        if any(session_id in part for part in line): return process
    return None


def roster_rows(terminal, marker):
    """The family roster the app rendered after `marker`, one row per member.

    The roster is the app's own account of who holds the role, and it is only
    reachable through the model's Leaf tool - there is no slash command for it -
    so a probe reads what the app computed rather than a file it parsed. Rows
    are `#N name [state] [marks...] <session id>`; the box the transcript draws
    them in is stripped so a row is compared whole.
    """
    rows = []
    for line in terminal.after(marker).splitlines():
        text = line.strip(' │|')
        if text.startswith('#') and '[' in text: rows.append(text)
    return rows


def confer_patriarch(terminal, leaf_id, results, label):
    """Put `leaf_id` in the patriarch seat, or leave the tries behind.

    `/leaf patriarch` is refused while the leaf still holds a turn, and a leaf
    that is booting is a leaf mid-turn - under load, which is to say whenever
    the machine is also running everyone else's leaves, that is most of the
    first minute. So the ask is repeated rather than sent once.

    The line is cleared before each ask because a busy app can leave the
    previous command sitting in the input box, and the next paste then joins
    it: this probe once produced `/leaf patriarch <id>/leaf patriarch <id>`,
    got a Usage error back, and read that as the app refusing the role. That
    was a reading about the harness. Ctrl-U is the same clear `typed_in` does.
    """
    for attempt in range(10):
        if terminal.pointer(terminal.id).get('patriarchSessionId') == leaf_id:
            return
        terminal.proc.write('\x15')
        terminal.pause(.4)
        terminal.submit('/leaf patriarch ' + leaf_id)
        terminal.pause(4)
        results[label + '_ask' + str(attempt)] = terminal.text()[-1200:]


def ask_roster(terminal, results, label):
    """Ask the app for the family roster and report what the app answered.

    There is no slash command for the roster - it is only reachable through the
    model's Leaf tool - so the fixture answers with that tool call and the app
    computes the listing. The listing is then read from the request that carries
    it back to the model, because that is where it exists: the app runs the
    tool, sends the result and paints only the model's next words, so the
    transcript shows the reply and nothing of the roster. The screen is kept
    anyway, so a future reader can see that for themselves.

    A row is `#N name [state] [marks...] <session id>`; the box the transcript
    draws them in is stripped, so a row compares whole.
    """
    terminal.proc.write('\x15')
    terminal.pause(.4)
    before = len(tool_results)
    terminal.submit('ROSTER_TASK')
    terminal.pause(12)
    results[label + '_screen'] = terminal.text()
    # The first *result* after the ask, not the first request after it: the
    # turns in between are auxiliary requests carrying no tool result at all.
    answered = [text for text in tool_results[before:] if text]
    results[label + '_wire'] = answered[0] if answered else None
    on_screen = roster_rows(terminal, 'ROSTER_TASK')
    if on_screen: return on_screen
    wire = results[label + '_wire'] or ''
    return [line.strip() for line in wire.splitlines()
            if line.strip().startswith('#') and '[' in line]


def probe_crash_window():
    """The two designation-crash windows, built on disk and read back.

    Both windows are one shape: a designation is written on the assumption that
    a later event will clean it up, and an interruption between the write and the
    event leaves a stale designation, because nothing reconciles.

      Window 1 - the elder mark. `writePatriarchDesignation` commits the pointer
      to the new patriarch and only THEN calls `markLeafElder` for the member it
      moved off. Dying between the two loses the elder mark for good.

      Window 3 - the closed patriarch. `setLeafMember` writes status `closed` to
      the family file and only THEN calls `promoteNextPatriarch`, which moves the
      designation. Dying between the two leaves the family file saying `closed`
      for the member the pointer still names patriarch.

    The window itself is sub-millisecond - two awaits in one function - so it
    cannot be raced reliably from a harness. What can be done is build the exact
    on-disk residue the interruption leaves and then let the REAL app resolve it
    in a resumed session. The residue is the input; what the family does with it
    is the answer, and either answer is worth having.

    Window 3's residue is produced by the app itself: a member's process is
    killed, its exit handler files it back as `closed`, and nothing promotes -
    so the pointer keeps naming it. Window 1's residue is written by hand,
    because only an interruption produces it and a write that fast cannot be
    interrupted from outside.
    """
    results = {}

    def flush_results():
        """Leave the readings behind as they are taken, so a later failure still
        has the evidence: this probe builds two families and kills a process, and
        the interesting state is on disk long before the last assertion."""
        print(json.dumps(results, indent=1, sort_keys=True), flush=True)

    # --- Window 3: the closed patriarch the app leaves behind on its own -------
    t = Terminal()
    t.wait(lambda: 'All 1' in t.text(), 'initial session', 240)
    # Neither window ever looks at a leaf's own screen: the members only have to
    # exist, and one of them only has to be running so it can be killed. So the
    # probe does not select one in the bar - that handoff is the slowest, flakiest
    # gesture in the harness and it buys nothing here. `leaves()` reads the family
    # file, which is the app's own record of who is in it.
    t.proc.write('\x15'); t.pause(.4)
    t.submit('/leaf new Alpha')
    t.wait(lambda: len(t.leaves()) == 1, 'Alpha created', 90)
    t.proc.write('\x15'); t.pause(.4)
    t.submit('/leaf new Bravo')
    t.wait(lambda: len(t.leaves()) == 2, 'Bravo created', 90)
    alpha, bravo = t.leaves()[0], t.leaves()[1]

    # Ask for the designation and check the pointer, retrying: conferring is
    # refused while the leaf still holds a turn ("Wait for the leaf turn"), and a
    # leaf that is booting is a leaf mid-turn.
    confer_patriarch(t, alpha['sessionId'], results, 'w3')
    t.check(lambda: t.pointer(t.id).get('patriarchSessionId') == alpha['sessionId'],
            'Alpha never took the role')

    # The interruption, produced by the app: kill the patriarch's process. This
    # is what an OOM, a crash or a closed lid does, and it is the only way to
    # leave the two-file write half-done. The exit handler files the member back
    # as `closed` and does not promote, so the pointer keeps naming it.
    t.wait(lambda: member_process(t, alpha['sessionId']) is not None, 'the patriarch has a process', 90)
    victim = member_process(t, alpha['sessionId'])
    t.check(lambda: victim is not None, 'the patriarch has no process to lose')
    victim.terminate()
    t.wait(lambda: next((m for m in t.family()['members'] if m['sessionId'] == alpha['sessionId']), {}).get('status') != 'open',
           'the dead patriarch is filed back as closed', 60)
    closed_row = next(m for m in t.family()['members'] if m['sessionId'] == alpha['sessionId'])
    results['w3_familyFileSays'] = closed_row.get('status')
    results['w3_pointerStillNamesIt'] = t.pointer(t.id).get('patriarchSessionId') == alpha['sessionId']
    t.check(lambda: closed_row.get('status') == 'closed',
            'the family file does not say closed for the dead patriarch: ' + json.dumps(closed_row))
    flush_results()

    # Read it back through a resume: the family that resolves from disk.
    #
    # The killed member's writer lock is left behind - a process that is
    # terminated cannot release it, and reclaiming it is the app's business on
    # next use, not this window's on its way out. So the leave is told the
    # family is held elsewhere and does not wait on the whole lock set, which
    # is a claim about clean shutdown and not what this probe is testing.
    t.exit(family_survives=True)
    r = Terminal(session_id=t.id)
    r.wait(lambda: 'All ' in r.text(), 'the family resumed', 180)
    rows = ask_roster(r, results, 'w3_afterRoster')
    results['w3_rosterRows'] = rows
    alpha_row = next((row for row in rows if alpha['sessionId'] in row), None)
    results['w3_alphaRow'] = alpha_row
    results['w3_resolvesToClosedMember'] = bool(alpha_row and '[patriarch]' in alpha_row)
    flush_results()
    r.close_leaves(90)
    r.exit(family_survives=True)

    # --- Window 1: the elder mark the interrupted write never reached ----------
    u = Terminal()
    u.wait(lambda: 'All 1' in u.text(), 'initial session', 240)
    u.proc.write('\x15'); u.pause(.4)
    u.submit('/leaf new Alpha')
    u.wait(lambda: len(u.leaves()) == 1, 'Alpha created', 90)
    u.proc.write('\x15'); u.pause(.4)
    u.submit('/leaf new Bravo')
    u.wait(lambda: len(u.leaves()) == 2, 'Bravo created', 90)
    a1, b1 = u.leaves()[0], u.leaves()[1]

    confer_patriarch(u, a1['sessionId'], results, 'w1')
    u.check(lambda: u.pointer(u.id).get('patriarchSessionId') == a1['sessionId'], 'Alpha never took the role')

    # (a) The writer half, read off the disk. A real conferral is the commit that
    # an interruption cannot split, so what the pointer holds afterwards is what
    # survives one. The holder the role moved away from must be named in the
    # POINTER, in the same write that moved the role: while it lived only in the
    # `markLeafElder` that follows, dying between the two lost it for good, and no
    # read can invent a fact that was never written.
    after_confer = u.pointer(u.id)
    results['w1_pointerAfterConfer'] = after_confer
    results['w1_writerRecordsOutgoingHolder'] = u.id in (after_confer.get('formerPatriarchIds') or [])
    u.check(lambda: u.id in (after_confer.get('formerPatriarchIds') or []),
            'the pointer does not name the holder the role moved away from: ' + json.dumps(after_confer))
    creator_row = next((m for m in u.family()['members'] if m['sessionId'] == u.id), {})
    results['w1_realConferMarksCreatorElder'] = bool(creator_row.get('eldership'))

    # (b) The display half: the instant between the pointer write and the elder
    # mark, frozen. The pointer has moved to Bravo carrying the record that Alpha
    # held the role, and Alpha's row is unmarked - exactly what an interruption
    # leaves now that the record rides in the same write. A resolver-only diff
    # cannot make the resumed roster show this, because there would be nothing on
    # disk for it to derive from.
    pointer_path = root / 'leaf-families' / 'index' / (u.id + '.json')
    pointer = json.loads(pointer_path.read_text(encoding='utf-8'))
    pointer['patriarchSessionId'] = b1['sessionId']
    pointer['formerPatriarchIds'] = list(dict.fromkeys((pointer.get('formerPatriarchIds') or []) + [a1['sessionId']]))
    pointer_path.write_text(json.dumps(pointer), encoding='utf-8')
    alpha_member = next(m for m in u.family()['members'] if m['sessionId'] == a1['sessionId'])
    results['w1_residueElderOnAlpha'] = bool(alpha_member.get('eldership'))
    u.check(lambda: u.pointer(u.id).get('patriarchSessionId') == b1['sessionId'], 'the residue does not name Bravo')
    u.check(lambda: not alpha_member.get('eldership'), 'the residue already marks Alpha an elder')

    # The clean residue, resolved in the window that built it.
    rows = ask_roster(u, results, 'w1_beforeResume')
    results['w1_rosterRowsBeforeResume'] = rows
    alpha_row = next((row for row in rows if a1['sessionId'] in row), None)
    results['w1_alphaRowBeforeResume'] = alpha_row
    flush_results()

    # And again through a resume, so the loss is shown to survive the window.
    #
    # The family is held for the resume, and it is also not this probe's business
    # whether the whole config root is quiet: Window 3 killed a process in the
    # same root a moment ago, and a killed process cannot give its writer lock
    # back. So both leaves here say the family is held elsewhere and skip the
    # root-wide lock sweep.
    u.exit(family_survives=True)
    v = Terminal(session_id=u.id)
    v.wait(lambda: 'All ' in v.text(), 'the family resumed', 180)
    rows = ask_roster(v, results, 'w1_afterResume')
    results['w1_rosterRowsAfterResume'] = rows
    alpha_row = next((row for row in rows if a1['sessionId'] in row), None)
    results['w1_alphaRowAfterResume'] = alpha_row
    results['w1_elderMarkEverRestored'] = bool(alpha_row and '[elder]' in alpha_row)
    flush_results()

    # The leaves are not closed here on purpose. `/exit` is the owner cascade:
    # a window leaving takes the leaves it owns with it, and the window that
    # reshaped this family already left, so the members have no process left to
    # close - asking `/leaf close` for one is a command that can never take,
    # which is a probe failing on its own housekeeping. What the probe owes is
    # the family left standing, and `exit` reads that back.
    v.exit(family_survives=True)


def probe_designation_residue():
    """The open-sibling residue: a stale designation with a member that can act.

    The pointer names a member whose process was killed, so the family filed it
    away; another member is still open, so the family is not dormant. What is
    asserted is POSITIVE: the member that can act must carry [patriarch], read
    from a session that is not it. The window-3 residue in `probe_crash_window`
    could only show the mark coming OFF the closed member, and a resolver that
    returned no patriarch at all satisfies that reading just as well - it is one
    half of the fact.

    The other residue a stale designation leaves - every member filed away, so
    nothing can act - is `probe_dormant_residue`. It builds its family in a run
    of its own on purpose: this residue kills a member's process, a killed
    process cannot give its writer lock back, and a leaf spawned into that same
    config root afterwards never leaves its boot and can never be given the
    title. A residue is read in a root where nothing has been killed.
    """
    results = {}

    def flush_results():
        print(json.dumps(results, indent=1, sort_keys=True), flush=True)

    # --- The open-sibling residue ---------------------------------------------
    #
    # Kill the patriarch, then read from a sibling. A window reading its own
    # family is filtered out of its own roster, so a session that enters as the
    # creator can never be shown the creator's row - and the creator is the
    # member the derivation falls back to here, being the lowest-numbered open
    # one. Entering as a leaf puts the reading session behind a row of its own
    # and leaves the acting patriarch a row this window has to show.
    t = Terminal()
    t.wait(lambda: 'All 1' in t.text(), 'initial session', 240)
    # The session that reads a member back afterwards enters its own conversation,
    # and a leaf that never had one has none to resume: a fresh leaf's transcript
    # is metadata only, and `--resume` refuses it. The creator is given a turn and
    # the reading sibling is forked from it, which is what gives the sibling a
    # conversation without having to open it on screen.
    t.proc.write('\x15'); t.pause(.4)
    t.submit('ALPHA_FIRST_TURN')
    t.wait(lambda: 'FIXTURE_REPLY_ALPHA_FIRST_TURN' in t.text(), 'the creator has a conversation', 90)
    t.proc.write('\x15'); t.pause(.4)
    t.submit('/leaf new Alpha')
    t.wait(lambda: len(t.leaves()) == 1, 'Alpha created', 90)
    t.proc.write('\x15'); t.pause(.4)
    t.submit('/leaf fork original Bravo')
    t.wait(lambda: len(t.leaves()) == 2, 'Bravo forked', 90)
    alpha, bravo = t.leaves()[0], t.leaves()[1]

    confer_patriarch(t, alpha['sessionId'], results, 'r1')
    t.check(lambda: t.pointer(t.id).get('patriarchSessionId') == alpha['sessionId'], 'Alpha never took the role')

    # The interruption, produced by the app: kill the patriarch's process. Its
    # exit handler files it back as closed and does not promote, so the pointer
    # keeps naming a member the family has put away.
    t.wait(lambda: member_process(t, alpha['sessionId']) is not None, 'the patriarch has a process', 90)
    victim = member_process(t, alpha['sessionId'])
    t.check(lambda: victim is not None, 'the patriarch has no process to lose')
    victim.terminate()
    t.wait(lambda: next((m for m in t.family()['members'] if m['sessionId'] == alpha['sessionId']), {}).get('status') != 'open',
           'the dead patriarch is filed back as closed', 60)
    closed_alpha = next(m for m in t.family()['members'] if m['sessionId'] == alpha['sessionId'])
    results['r1_pointerNamesClosedAlpha'] = t.pointer(t.id).get('patriarchSessionId') == alpha['sessionId']
    results['r1_alphaStatus'] = closed_alpha.get('status')
    t.check(lambda: closed_alpha.get('status') == 'closed',
            'the family file does not say closed for the dead patriarch: ' + json.dumps(closed_alpha))
    flush_results()

    # Close the sibling on purpose, so the session that reads afterwards enters a
    # closed member - the ordinary way a person comes back to one - rather than
    # racing the process the window left behind.
    t.submit('/leaf close ' + bravo['sessionId'])
    t.wait(lambda: next(m for m in t.family()['members'] if m['sessionId'] == bravo['sessionId'])['status'] == 'closed',
           'the sibling closed cleanly', 90)

    # Enter as the sibling while the window that made the family is still up:
    # that is the ordinary way a member is entered - `cc --resume <leaf id>`, the
    # address the leaf menu prints for every member - and two windows on one
    # family, a host and a member, is the shape the family model is built on. The
    # session reading is not the acting patriarch, so the acting patriarch is a
    # row this window has to show.
    r = Terminal(bravo['sessionId'])
    r.wait(lambda: 'All ' in r.text(), 'the sibling resumed', 180)
    rows = ask_roster(r, results, 'r1_roster')
    results['r1_rosterRows'] = rows
    alpha_line = next((row for row in rows if alpha['sessionId'] in row), None)
    acting_line = next((row for row in rows if t.id in row), None)
    results['r1_closedPatriarchLine'] = alpha_line
    results['r1_actingLine'] = acting_line
    results['r1_closedPatriarchStillMarked'] = bool(alpha_line and '[patriarch]' in alpha_line)
    results['r1_successorMarked'] = bool(acting_line and '[patriarch]' in acting_line)
    flush_results()
    r.pause(1)
    r.exit(family_survives=True)
    t.exit(family_survives=True)


def probe_dormant_residue():
    """The all-filed-away residue: a designation with no member that can act.

    No member can act at all, which is the one case the derivation has nothing
    to fall back to. It is put to the app rather than settled in prose, so the
    answer recorded is whatever the app actually says.

    Nothing in the app files every member away while a window is reading - a
    window that is reading is a window whose own row is open - so the residue is
    built by hand, exactly as window 1's is. It gets a run of its own because
    the other residue, `probe_designation_residue`, kills a member's process,
    and a killed process cannot give its writer lock back: a leaf spawned into
    that same config root afterwards never leaves its boot.
    """
    results = {}

    def flush_results():
        print(json.dumps(results, indent=1, sort_keys=True), flush=True)

    # The pointer still names a member the family has put away, and no member
    # can act: the pointer's member is what a fallback returns, and the family
    # id is what a deliberate terminus would name.
    u = Terminal()
    u.wait(lambda: 'All 1' in u.text(), 'initial session', 240)
    # The dormant family is read back through this same session, so it is given a
    # conversation to resume for the same reason the sibling was.
    u.proc.write('\x15'); u.pause(.4)
    u.submit('ALPHA_LATER_TURN')
    u.wait(lambda: 'FIXTURE_REPLY_ALPHA_LATER_TURN' in u.text(), 'the creator has a conversation', 90)
    u.proc.write('\x15'); u.pause(.4)
    u.submit('/leaf new Alpha')
    u.wait(lambda: len(u.leaves()) == 1, 'Alpha created', 90)
    a2 = u.leaves()[0]
    results['r2_beforeResidue'] = [(m['number'], m['name'], m['status']) for m in u.family()['members']]
    results['r2_pointerBeforeResidue'] = u.pointer(u.id)
    flush_results()

    # The window leaves before the file is reshaped: a running window is a window
    # that can still rewrite the file it is reading, and the residue has to be
    # what the session that reads it finds on disk.
    u.exit(family_survives=True)

    # The residue, built by hand - the designation moved and every member filed
    # away, so the pointer names a role nobody can hold and nobody is left to
    # fall back to.
    #
    # Hand-built for the same reason window 1's is, and not for want of a real
    # route: `/leaf patriarch` does move the designation. It is that the title is
    # refused while the leaf is not `idle`, and a member that never reaches its
    # own endpoint is refused for good - three runs of this probe were spent on
    # exactly that refusal, with the leaf's process up the whole time and the app
    # never letting the title through. The residue is the input either way; what
    # the family does with it is the answer, and that is what is read below.
    family_file = root / 'leaf-families' / (u.id + '.json')
    pointer_file = root / 'leaf-families' / 'index' / (u.id + '.json')
    dormant = json.loads(family_file.read_text(encoding='utf-8'))
    for member in dormant['members']:
        member['status'] = 'closed'
    family_file.write_text(json.dumps(dormant), encoding='utf-8')
    pointer = json.loads(pointer_file.read_text(encoding='utf-8'))
    pointer['patriarchSessionId'] = a2['sessionId']
    pointer_file.write_text(json.dumps(pointer), encoding='utf-8')
    results['r2_membersAllClosed'] = [(m['number'], m['name'], m['status']) for m in dormant['members']]
    results['r2_pointerNames'] = a2['sessionId']
    results['r2_residuePointer'] = u.pointer(u.id)
    flush_results()

    w = Terminal(session_id=u.id)
    w.wait(lambda: 'All ' in w.text(), 'the dormant family resumed', 180)
    rows = ask_roster(w, results, 'r2_roster')
    results['r2_rosterRows'] = rows
    results['r2_rowsMarkingPatriarch'] = [row for row in rows if '[patriarch]' in row]
    results['r2_familyId'] = u.id
    # The reading session's own row is filtered out of its roster, so the file is
    # read too: it says whether entering the family put the reader back among the
    # members that can act, which is the claim about why the terminus is never
    # observed from inside.
    results['r2_familyAfterResume'] = [(m['number'], m['name'], m['status']) for m in w.family()['members']]
    flush_results()
    w.pause(1)
    w.exit(family_survives=True)


def probe_close_promotion():
    """The deliberate close still moves the designation, and records the elder.

    Window 1's fix puts the name of the holder the role moved away from into the
    SAME write that moves the role. The risk that carries is the other direction:
    a move that now also records history could stop moving the designation when
    it should. So the ordinary path is put to the app - confer the title on a
    leaf, then close that leaf on purpose - and the pointer that follows is read.
    It has to name the member that took over, that member has to be one that can
    act, and the member the role moved off has to be in the record the same write
    left behind.
    """
    results = {}

    def flush_results():
        print(json.dumps(results, indent=1, sort_keys=True), flush=True)

    t = Terminal()
    t.wait(lambda: 'All 1' in t.text(), 'initial session', 240)
    t.proc.write('\x15'); t.pause(.4)
    t.submit('ALPHA_FIRST_TURN')
    t.wait(lambda: 'FIXTURE_REPLY_ALPHA_FIRST_TURN' in t.text(), 'the creator has a conversation', 90)
    t.proc.write('\x15'); t.pause(.4)
    t.submit('/leaf new Alpha')
    t.wait(lambda: len(t.leaves()) == 1, 'Alpha created', 90)
    t.proc.write('\x15'); t.pause(.4)
    t.submit('/leaf fork original Bravo')
    t.wait(lambda: len(t.leaves()) == 2, 'Bravo forked', 90)
    alpha = t.leaves()[0]

    confer_patriarch(t, alpha['sessionId'], results, 'p')
    results['p_pointerAfterConfer'] = t.pointer(t.id)
    flush_results()
    t.check(lambda: t.pointer(t.id).get('patriarchSessionId') == alpha['sessionId'], 'Alpha never took the role')

    # The deliberate close: the designated patriarch is filed away by command
    # rather than by a dying process. This is the path that promotes, and it is
    # the path the residue runs never take.
    t.submit('/leaf close ' + alpha['sessionId'])
    t.wait(lambda: next(m for m in t.family()['members'] if m['sessionId'] == alpha['sessionId'])['status'] == 'closed',
           'the patriarch closed cleanly', 90)
    t.pause(4)
    after = t.pointer(t.id)
    results['p_pointerAfterDeliberateClose'] = after
    results['p_designationMoved'] = after.get('patriarchSessionId') != alpha['sessionId']
    results['p_newPatriarchStatus'] = next(
        (m['status'] for m in t.family()['members'] if m['sessionId'] == after.get('patriarchSessionId')), None)
    results['p_outgoingHeldInHistory'] = alpha['sessionId'] in (after.get('formerPatriarchIds') or [])
    rows = ask_roster(t, results, 'p_roster')
    results['p_rosterRows'] = rows
    results['p_rosterMarksOutgoingElder'] = any(alpha['sessionId'] in row and '[elder]' in row for row in rows)
    flush_results()
    t.check(lambda: after.get('patriarchSessionId') != alpha['sessionId'],
            'the designation did not move on a deliberate close: ' + json.dumps(after))

    t.close_leaves(90)
    t.exit(family_survives=True)


def probe_goal_reopen():
    """The close-modify-reopen failure branch: a goal that throws still reopens.

    `setLeafGoal` closes the leaf, claims the writer, writes the goal, and reopens
    in a nested `finally`. The branch that matters is the failure: if the write
    throws AFTER the close, that reopen is the only thing standing between a
    failed command and a leaf left stopped by it. Nothing in leaf-family.test.ts
    reaches it - every refusal there fires before the close (the `Unknown leaf`
    check and the `Leaf must be open and idle` guard both precede
    `changeLeaf(status:'closed')`), so the `finally` never runs its failing branch.

    The failure is produced by the app's own logic rather than a mutation: a
    `pause` on a leaf that has never been given a goal reads no record and throws
    'No saved leaf goal' after the close. What is asserted is that the member
    reads OPEN again - and it is read from the family FILE, named as the file,
    not from a return value, so the answer is held to the thing that has to carry
    it.

    The leaf has to be idle for the command to reach the close at all: the idle
    guard precedes it, and an attempt that trips the guard never closed anything.
    So the ask is repeated until the refusal seen is the post-close one, and the
    guard's own message is recorded separately, so a pre-close refusal is never
    mistaken for the branch under test. With the reopen deleted from the `finally`
    the family file keeps the member `closed` and this probe fails - that is the
    mutation this exists to catch.
    """
    results = {}

    def flush_results():
        print(json.dumps(results, indent=1, sort_keys=True), flush=True)

    t = Terminal()
    t.wait(lambda: 'All 1' in t.text(), 'initial session', 240)
    t.proc.write('\x15'); t.pause(.4)
    t.submit('ALPHA_FIRST_TURN')
    t.wait(lambda: 'FIXTURE_REPLY_ALPHA_FIRST_TURN' in t.text(), 'the creator has a conversation', 90)
    t.proc.write('\x15'); t.pause(.4)
    t.submit('/leaf new Alpha')
    t.wait(lambda: len(t.leaves()) == 1, 'Alpha created', 90)
    alpha = t.leaves()[0]

    # Enter Alpha, so it leaves 'starting' and reaches 'idle'. `setLeafGoal`
    # refuses anything but idle (unlike confer/heir, which accept closed and
    # failed too), and a leaf that was only created and never read is still
    # starting - a plain `/leaf new` never reaches its input loop on its own.
    # Entering is the switch that proves it is reading, and `assert_view` is what
    # makes it idle: its marker is answered, and the reply is the idle claim, so
    # no separate turn is needed. The switch is repeated because the bar is still
    # repainting the leaf it just made, and a press that lands between frames
    # toggles nothing.
    for attempt in range(6):
        try:
            t.leaf(0)
            break
        except AssertionError:
            t.pause(2)
    t.assert_view(alpha['sessionId'], 'Alpha on screen and idle', 90)
    t.original()

    def status():
        return next((m['status'] for m in t.family()['members'] if m['sessionId'] == alpha['sessionId']), None)

    results['g_statusBefore'] = status()
    flush_results()

    # Repeat until the refusal is the one thrown AFTER the close. A leaf that is
    # still booting trips the idle guard first, and that attempt closed nothing -
    # so the guard's message is tracked apart from the post-close one.
    saw_post_close = False
    for attempt in range(12):
        t.proc.write('\x15'); t.pause(.4)
        t.submit('/leaf goal ' + alpha['sessionId'] + ' pause')
        t.pause(5)
        screen = t.text()
        post_close = 'No saved leaf goal' in screen
        results['g_attempt' + str(attempt) + '_postClose'] = post_close
        results['g_attempt' + str(attempt) + '_idleGuard'] = 'Leaf must be open and idle' in screen
        if post_close:
            saw_post_close = True
            results['g_refusalScreen'] = screen[-1200:]
            break

    results['g_reachedPostCloseRefusal'] = saw_post_close
    # The answer is held to the family file, named here, not to a return value.
    results['g_familyFileMembers'] = [(m['number'], m['name'], m['status']) for m in t.family()['members']]
    results['g_familyFileStatusAfter'] = status()
    results['g_reopenedInFamilyFile'] = status() == 'open'
    flush_results()

    # The family file is rewritten by the teardown below, so the state
    # as-of-assertion is captured to its own file first: a residue's family file
    # is POST-teardown and cannot be read back as this probe's reading. Without
    # this, a reader of the residue directory sees the last write on disk rather
    # than what the probe asserted - which nearly produced a false contradiction
    # against this commit, read from the file instead of from the bar.
    (root / 'goal-reopen-reading.json').write_text(json.dumps(dict(
        reachedPostCloseRefusal=saw_post_close,
        familyFileStatusAfter=status(),
        familyFileMembers=[(m['number'], m['name'], m['status']) for m in t.family()['members']],
        alphaSessionId=alpha['sessionId'],
    ), indent=1, sort_keys=True), encoding='utf-8')

    t.check(lambda: saw_post_close,
            'never reached the post-close refusal, so the close-modify-reopen branch was not exercised')
    t.check(lambda: status() == 'open',
            'the family file leaves the leaf stopped after a goal that threw: ' + json.dumps(t.family()['members']))

    t.close_leaves(90)
    t.exit(family_survives=True)


def probe_queue():
    """The message queue: Tab hands a message over instead of sending it.

    The turn is held open by the fixture, so everything the probe does happens
    while the agent is busy - which is the only time a queue means anything.
    What is asserted is read from the app's own account of itself: the session
    transcript records every queue operation with the text it carried, in the
    order they happened, so "in order" and "waited for the turn" are facts about
    the app rather than readings of a painted list.
    """
    t = Terminal()
    t.wait(lambda: 'All 1' in t.text(), 'initial carousel', 60)

    def queue_ops():
        rows = []
        for path in (root / 'projects').rglob(t.id + '*.jsonl'):
            for line in path.read_text(encoding='utf-8').splitlines():
                try: entry = json.loads(line)
                except ValueError: continue
                if entry.get('type') == 'queue-operation': rows.append(entry)
        return rows

    def enqueued():
        return [row.get('content') for row in queue_ops() if row.get('operation') == 'enqueue']

    def popped():
        return [row.get('content') for row in queue_ops() if row.get('operation') == 'popAll']

    def user_texts():
        """The queued messages that became the user's own messages, in order.

        Read from the transcript rather than the screen, because the screen is
        only the last frame and this is about what the session recorded.
        """
        rows = []
        for path in (root / 'projects').rglob(t.id + '*.jsonl'):
            for line in path.read_text(encoding='utf-8').splitlines():
                try: entry = json.loads(line)
                except ValueError: continue
                if entry.get('type') != 'user': continue
                content = (entry.get('message') or {}).get('content')
                text = content if isinstance(content, str) else ' '.join(block.get('text', '') for block in content if isinstance(block, dict) and block.get('type') == 'text')
                if 'QUEUE_' in text: rows.append(text.strip())
        return rows

    def composer():
        """What the input line holds, read from between the last two rules.

        A fixed pause after writing is a guess at when the app has caught up,
        and a guess made too early reads the frame from before the write - so
        every step below waits for the screen instead.
        """
        lines = t.text().splitlines()
        rules = [i for i, l in enumerate(lines) if l.strip() and set(l.strip()) == {'─'}]
        if len(rules) < 2:
            return ''
        region = lines[rules[-2] + 1:rules[-1]]
        return '\n'.join(l for l in region if 'Press up to edit' not in l)

    def type_line(message, key, handed_over=True):
        t.proc.write('\x15')
        t.wait(lambda: 'QUEUE_' not in composer(), 'the composer is clear', 15)
        t.proc.write('\x1b[200~' + message + '\x1b[201~')
        t.wait(lambda: message in composer(), message + ' is in the composer', 20)
        t.proc.write(key)
        # The hand-over empties the composer, so waiting for that is waiting for
        # this key to have been acted on - and it keeps the next line's clear
        # from racing the key that is still being handled. A refused message
        # stays where it was written, so that wait does not apply to it.
        if handed_over:
            t.wait(lambda: message not in composer(), message + ' left the composer', 20)

    # Hold the turn open, so every message written below is written mid-turn.
    t.submit('ROOT_BLOCKED_TASK')
    t.wait(lambda: 'ROOT_BLOCKED_TASK' in started_turns, 'the turn is held open', 45)

    # Tab on an empty composer keeps its old meaning rather than queueing a blank.
    t.proc.write('\t')
    t.wait(lambda: 'to toggle thinking' in t.text(), 'an empty composer offers the thinking hint', 15)
    assert enqueued() == [], 'an empty composer queued something'

    for message in ('QUEUE_ONE', 'QUEUE_TWO', 'QUEUE_THREE', 'QUEUE_FOUR'):
        type_line(message, '\t')
    t.wait(lambda: enqueued() == ['QUEUE_ONE', 'QUEUE_TWO', 'QUEUE_THREE', 'QUEUE_FOUR'],
           'the four messages wait in the order they were written', 30)
    # Each hand-over emptied the composer, so a Tab now lands on nothing - which
    # is also the proof that the text is not sitting in the composer any more.
    t.proc.write('\t')
    t.wait(lambda: 'to toggle thinking' in t.text(), 'an empty composer still offers the thinking hint', 15)
    assert enqueued() == ['QUEUE_ONE', 'QUEUE_TWO', 'QUEUE_THREE', 'QUEUE_FOUR'], 'a fifth message was queued without being typed'
    # Nothing has been sent: the queue holds until the turn ends.
    assert user_texts() == [], 'a queued message was sent before the turn ended'

    # The queue is full at four, and the fifth is refused where it was written
    # rather than dropping one of the four already waiting.
    type_line('QUEUE_FIVE', '\t', handed_over=False)
    assert enqueued() == ['QUEUE_ONE', 'QUEUE_TWO', 'QUEUE_THREE', 'QUEUE_FOUR'], 'the queue took a fifth message'
    t.wait(lambda: 'The queue holds 4 messages' in t.text(), 'a full queue says so', 15)
    assert user_texts() == [], 'the refused message was sent anyway'

    # Up-arrow hands the newest message back, and it is editable: the line typed
    # after it only reads as one message if the composer already held it.
    t.proc.write('\x15')
    t.wait(lambda: 'QUEUE_' not in composer(), 'the composer is clear', 15)
    t.proc.write('\x1b[A')
    t.wait(lambda: popped() == ['QUEUE_FOUR'], 'up-arrow hands back the newest message', 20)
    t.wait(lambda: 'QUEUE_FOUR' in composer(), 'the handed-back message is in the composer', 20)
    t.proc.write('\x1b[200~ EDITED\x1b[201~')
    t.wait(lambda: 'QUEUE_FOUR EDITED' in composer(), 'the edit joined the handed-back message', 20)
    t.proc.write('\t')
    t.wait(lambda: enqueued() == ['QUEUE_ONE', 'QUEUE_TWO', 'QUEUE_THREE', 'QUEUE_FOUR', 'QUEUE_FOUR EDITED'],
           'the edited message went back to the queue', 30)

    # Let the turn finish. The queue drains itself, in the order it was written.
    blocked_turns['ROOT_BLOCKED_TASK'].set()
    t.wait(lambda: 'ROOT_BLOCKED_TASK' in finished_turns, 'the held turn completes', 45)
    t.wait(lambda: user_texts() == ['QUEUE_ONE', 'QUEUE_TWO', 'QUEUE_THREE', 'QUEUE_FOUR EDITED'],
           'the queue drained in order once the turn ended', 90)
    # And the model saw them in that order too: the drain batches the prompts
    # into one turn, so order is read off the wire rather than off one request
    # per message.
    drained = [body for body in requests if 'QUEUE_ONE' in json.dumps(body)]
    assert drained, 'the queued messages never reached the model'
    wire = json.dumps(drained[-1])
    positions = [wire.index(name) for name in ('QUEUE_ONE', 'QUEUE_TWO', 'QUEUE_THREE', 'QUEUE_FOUR EDITED')]
    assert positions == sorted(positions), 'the model saw the queued messages out of order'
    # The refused one is nowhere: not in the transcript, not on the wire.
    assert 'QUEUE_FIVE' not in json.dumps(requests), 'the refused message was sent after the turn ended'
    assert all('QUEUE_FIVE' not in text for text in user_texts()), 'the refused message reached the transcript'
    t.exit()
    print(json.dumps(dict(queue=True, emptyComposerNotQueued=True, orderHeld=True, waitsForTurnEnd=True, capRefuses=True, upArrowEdits=True, drainsInOrder=True)), flush=True)

def probe_read():
    """Reading a member's work on demand, on real sessions, from both ends.

    Three surfaces, all of them real CLIs at a real prompt: the matriarch reads a
    member's chat and the family digest, a leaf reads a sibling (which the matriarch
    serves, since a leaf holds no transcript paths), and a live session outside
    the family is read over the peer bus. A read is a file read on the target's
    side and never a turn, so none of this waits on, or interrupts, the work it
    is looking at.
    """
    t = Terminal()
    t.wait(lambda: 'All 1' in t.text(), 'initial session', 60)
    t.submit('ROOT_CONTEXT_CAFE_')
    t.wait(lambda: 'FIXTURE_REPLY_ROOT_CONTEXT_CAFE_' in t.text(), 'root context')
    t.submit('/leaf fork original Gamma')
    t.wait(lambda: len(t.leaves()) == 1, 'the gamma leaf', 75)
    gamma = t.leaves()[0]
    t.assert_view(gamma['sessionId'], 'the gamma leaf', 75)
    t.submit('GAMMA_TURN')
    t.wait(lambda: 'FIXTURE_REPLY_GAMMA_TURN' in t.text(), 'gamma turn')

    # A second member, so the leaf-side read has a target whose work exists
    # nowhere on the reading leaf's own screen.
    t.original()
    t.submit('/leaf fork original Delta')
    t.wait(lambda: len(t.leaves()) == 2, 'the delta leaf', 75)
    delta = t.leaves()[1]
    t.assert_view(delta['sessionId'], 'the delta leaf', 75)
    t.submit('DELTA_TURN')
    t.wait(lambda: 'FIXTURE_REPLY_DELTA_TURN' in t.text(), 'delta turn')

    # The family digest: every member at a glance, with the matriarch that holds the
    # member list and the transcript paths answering for all of them.
    t.original()
    t.submit('/leaf read')
    t.wait(lambda: 'family ' + t.id in t.text(), 'the family digest', 45)
    digest = t.after('family ' + t.id)
    assert 'Gamma' in digest and 'Delta' in digest, 'the digest does not name the members it summarises'

    # One member's own chat, read from the matriarch. The header is the reader's own
    # label, so the assertion cannot be satisfied by the turn itself still being
    # on some other screen.
    t.submit('/leaf read ' + gamma['sessionId'])
    t.wait(lambda: '[peer session transcript' in t.text(), 'the labelled member chat', 45)
    assert 'GAMMA_TURN' in t.text(), 'the member chat did not carry the member work'
    assert 'cursor ' in t.text(), 'a read hands back a cursor so following along is cheap'

    # A bounded read, and the cursor played back. Following along has to be
    # cheap, which means asking for a short window and for only what is new -
    # and a read that ignored either would look exactly like a working one
    # until the conversation got long.
    t.submit('/leaf read ' + gamma['sessionId'] + ' tail=1')
    t.wait(lambda: 'cursor ' in t.after('tail=1'), 'a bounded read', 45)
    bounded = t.after('tail=1')
    assert 'FIXTURE_REPLY_GAMMA_TURN' in bounded, 'tail=1 dropped the newest turn'
    assert 'ROOT_CONTEXT_CAFE_' not in bounded, 'tail=1 kept turns it was told to leave out'
    handed = re.search(r'cursor ([0-9a-f-]{36})', bounded)
    assert handed, 'a read handed back no cursor to follow from'

    t.leaf(0)
    t.submit('GAMMA_LATER_TURN')
    t.wait(lambda: 'FIXTURE_REPLY_GAMMA_LATER_TURN' in t.text(), 'the member works on')
    t.original()
    t.submit('/leaf read ' + gamma['sessionId'] + ' since=' + handed.group(1))
    t.wait(lambda: 'GAMMA_LATER_TURN' in t.after('since='), 'a read from a cursor', 45)
    followed = t.after('since=')
    assert 'FIXTURE_REPLY_GAMMA_LATER_TURN' in followed, 'the read from a cursor missed the turn that came after it'
    assert 'ROOT_CONTEXT_CAFE_' not in followed, 'the read from a cursor re-sent turns that were already read'

    # A leaf reading a sibling. The leaf has no member list and no paths, so the
    # only way this answer exists is the matriarch serving it over the leaf wire - and
    # DELTA_TURN is nowhere on Gamma's own screen for it to be confused with.
    t.leaf(0)
    t.submit('/leaf read ' + delta['sessionId'])
    t.wait(lambda: '[peer session transcript' in t.text(), 'the sibling read', 60)
    assert 'DELTA_TURN' in t.text(), 'the sibling read did not reach the sibling conversation'

    # A live session outside the family, over the peer bus. The listing comes
    # first because discovery and the read are two different faults: a peer the
    # listing cannot see is one the read can never be addressed to, and the two
    # must not be reported as one failure. It is asked until the target shows
    # up, because a session publishes its registration a moment after its
    # prompt appears - asking once would test the timing of the spawn, not the
    # read.
    t.original()
    other = Terminal()
    other.wait(lambda: 'All 1' in other.text(), 'the second session', 60)
    other.submit('OTHER_TURN_MARKER')
    other.wait(lambda: 'FIXTURE_REPLY_OTHER_TURN_MARKER' in other.text(), 'the second session turn')
    deadline = time.monotonic() + 90
    while True:
        t.submit('/sessions list')
        t.wait(lambda: 'live sessions' in t.after('/sessions list'), 'the live session list', 45)
        if other.id[:8] in t.after('/sessions list') or time.monotonic() > deadline: break
        t.pause(2)
    t.check(lambda: other.id[:8] in t.after('/sessions list'),
            'the second session never published a registration: ' + repr(t.after('/sessions list')[-600:]))
    t.submit('/sessions read ' + other.id)
    t.wait(lambda: 'OTHER_TURN_MARKER' in t.after('/sessions read'), 'a live non-family session is read on demand', 60)
    assert '[peer session transcript' in t.after('/sessions read'), 'the peer read was not labelled as peer-authored text'

    t.close_leaves(60)

    # A closed member is still readable. Its bytes are on disk and the matriarch
    # holds the path, so reading never depends on the member running - which is
    # the difference between reading work and starting it, and the reason a read
    # is instant.
    t.submit('/leaf read')
    t.wait(lambda: 'family ' + t.id in t.after('/leaf read'), 'the digest over closed members', 45)
    closed_digest = t.after('/leaf read')
    assert 'Gamma' in closed_digest and 'Delta' in closed_digest, 'the digest dropped members that had closed'
    t.submit('/leaf read ' + gamma['sessionId'])
    t.wait(lambda: 'GAMMA_TURN' in t.after('/leaf read ' + gamma['sessionId']), 'a closed member is read on demand', 45)
    assert '[peer session transcript' in t.after('/leaf read ' + gamma['sessionId']), 'the closed member read was not labelled as peer text'

    # The second session is nobody's leaf, so it leaves on its own and gives its
    # own writer claim back first. A session still running is still writing, and
    # the assertion at the end is about what THIS window left behind - taking it
    # while a stranger held a lock would have read as a leak it is not.
    other.submit('/exit')
    other.wait(lambda: not other.proc.isalive(), 'the second session leaves')
    other.wait(lambda: not (root / 'gateway-writers' / (other.id + '.lock')).exists(), 'the second session released its writer lock')
    t.exit()
    print(json.dumps(dict(read=True, digest=True, memberChat=True, leafSibling=True, peerRead=True)), flush=True)

def probe_comms():
    """Checkpoints and branching from one, on real sessions.

    A member snapshots itself from its own prompt, the family lists the
    snapshot, a repeat label takes the next ordinal and an ambiguous one is
    refused rather than guessed, and a branch taken from `#1` carries the
    conversation as it stood at the checkpoint rather than as it stands now.
    Dropping keeps the branch; purging empties the collection.
    """
    t = Terminal()
    t.wait(lambda: 'All 1' in t.text(), 'initial session', 60)
    t.submit('ROOT_CONTEXT_CAFE_')
    t.wait(lambda: 'FIXTURE_REPLY_ROOT_CONTEXT_CAFE_' in t.text(), 'root context')
    t.submit('/leaf fork original Alpha')
    t.wait(lambda: len(t.leaves()) == 1, 'the alpha leaf', 75)
    alpha = t.leaves()[0]
    t.assert_view(alpha['sessionId'], 'the alpha leaf', 75)
    t.submit('ALPHA_FIRST_TURN')
    t.wait(lambda: 'FIXTURE_REPLY_ALPHA_FIRST_TURN' in t.text(), 'alpha first turn')

    # The member snapshots itself. The request crosses the leaf wire, and the
    # matriarch - which holds the member's transcript path and is the only party that
    # can flush it - takes the copy.
    t.submit('/leaf checkpoint ' + alpha['sessionId'] + ' alpha-snap')
    t.wait(lambda: 'Checkpoint #1 alpha-snap' in t.text(), 'alpha checkpoints itself', 75)

    # Alpha keeps working. The snapshot must not follow it.
    t.submit('ALPHA_LATER_TURN')
    t.wait(lambda: 'FIXTURE_REPLY_ALPHA_LATER_TURN' in t.text(), 'alpha keeps working')

    frozen = root / 'leaf-families' / 'checkpoints' / t.id
    assert frozen.is_dir(), 'the checkpoint collection was not created at ' + str(frozen)
    assert len(list(frozen.glob('*.jsonl'))) == 1, 'the frozen conversation was not written'

    t.original()
    t.submit('/leaf checkpoints')
    t.wait(lambda: '#1 alpha-snap' in t.after('checkpoints for family'), 'the checkpoint is listed', 45)

    # A second tip under the same label: a new ordinal, and a name that now
    # answers to two snapshots is refused rather than guessed.
    t.submit('/leaf checkpoint ' + alpha['sessionId'] + ' alpha-snap')
    t.wait(lambda: 'Checkpoint #2 alpha-snap' in t.text(), 'a repeat label takes the next ordinal', 75)
    t.submit('/leaf fork alpha-snap Ambiguous')
    t.wait(lambda: 'Ambiguous checkpoint' in t.text(), 'an ambiguous label is refused', 45)
    assert len(t.leaves()) == 1, 'a refused fork created a leaf anyway'

    # The branch of #1 must carry the conversation as it stood at the checkpoint.
    t.submit('/leaf fork #1 Beta')
    t.wait(lambda: len(t.leaves()) == 2, 'the checkpoint branch', 90)
    beta = t.leaves()[1]
    assert beta['parentSessionId'] == alpha['sessionId'], 'the branch is not attributed to the member the checkpoint came from'
    pointer = t.pointer(beta['sessionId'])
    assert pointer.get('fromCheckpointId'), 'the branch does not record which checkpoint it came from'
    branch_text = Path(beta['transcriptPath']).read_text(encoding='utf-8')
    assert 'ALPHA_FIRST_TURN' in branch_text, 'the branch did not carry the checkpointed conversation'
    assert 'ALPHA_LATER_TURN' not in branch_text, 'the branch followed the source past the checkpoint'

    t.assert_view(beta['sessionId'], 'the checkpoint branch', 90)
    t.original()

    # #2 was taken after Alpha kept working, so a branch from it is the same
    # conversation frozen at a different point. Two ordinals that produced the
    # same bytes would make the numbering a decoration.
    t.submit('/leaf fork #2 Beta2')
    t.wait(lambda: len(t.leaves()) == 3, 'the second checkpoint branch', 90)
    later = t.leaves()[2]
    later_text = Path(later['transcriptPath']).read_text(encoding='utf-8')
    assert 'ALPHA_FIRST_TURN' in later_text, 'the #2 branch lost the start of the conversation'
    assert 'ALPHA_LATER_TURN' in later_text, 'a branch from #2 did not carry the turn #2 was taken after'
    t.assert_view(later['sessionId'], 'the second checkpoint branch', 90)
    t.original()

    # Dropping keeps the bytes, so the branch taken from the snapshot survives.
    t.submit('/leaf checkpoint-drop #1')
    t.wait(lambda: 'dropped' in t.text(), 'the checkpoint is dropped', 45)
    # The newest listing, not the one from before the drop: the dropped entry has
    # to be gone from the list while the surviving one is still on it.
    t.submit('/leaf checkpoints')
    t.wait(lambda: '#2 alpha-snap' in t.after('checkpoints for family') and '#1 alpha-snap' not in t.after('checkpoints for family'),
           'the listing dropped #1 and kept #2', 45)
    assert 'ALPHA_FIRST_TURN' in Path(beta['transcriptPath']).read_text(encoding='utf-8'), 'dropping the checkpoint disturbed the branch taken from it'

    t.submit('/leaf checkpoint-purge #2')
    t.wait(lambda: 'purged' in t.text(), 'the checkpoint is purged', 45)
    t.submit('/leaf checkpoints')
    t.wait(lambda: 'No checkpoints for family' in t.text() and '#2 alpha-snap' not in t.after('checkpoints for family'),
           'the collection is empty', 45)

    # A checkpoint of a member that is no longer running. The matriarch holds the
    # path and the bytes are on disk, so a snapshot never needs the member awake -
    # which is the difference between freezing a conversation and continuing it.
    # The ordinal is also proof that a dropped or purged number is never handed
    # out twice: #1 and #2 are gone, and this one cannot be either of them.
    t.submit('/leaf close ' + later['sessionId'])
    t.wait(lambda: not any(item['sessionId'] == later['sessionId'] and item['status'] == 'open' for item in t.leaves()),
           'the second branch closes', 60)
    t.submit('/leaf checkpoint ' + later['sessionId'] + ' closed-snap')
    t.wait(lambda: 'Checkpoint #3 closed-snap' in t.text(), 'a closed member is snapshotted on demand', 75)
    t.submit('/leaf checkpoints')
    t.wait(lambda: '#3 closed-snap' in t.after('checkpoints for family'), 'the closed member snapshot is listed', 45)
    held = ''.join(path.read_text(encoding='utf-8') for path in frozen.glob('*.jsonl'))
    assert 'ALPHA_LATER_TURN' in held, 'the closed member snapshot did not carry the conversation it was taken from'

    t.close_leaves(60)
    t.exit()
    print(json.dumps(dict(comms=True, selfCheckpoint=True, listed=True, repeatOrdinal=True, ambiguousRefused=True, branchFromCheckpoint=True, branchFromSecond=True, dropKeepsBranch=True, purgeEmpties=True, closedCheckpoint=True)), flush=True)

def probe_merge():
    """Seeds, seedlings, and merging one back into its seed, on real sessions.

    A seed is a fork that is also a merge target and a seedling is a bounded fork
    of it; the role is recorded where a role can be recorded - the loose pointer -
    and nothing in the family file changes. The merge itself is an injected turn,
    never a write to a transcript file, and it is reported only once the id it
    carried is witnessed in the seed's own transcript - so what this checks is
    the seed gaining the seedling's work, the ledger form carrying the report and
    not the working, and the refusals that keep a merge off a member it does not
    belong to.
    """
    t = Terminal()
    t.wait(lambda: 'All 1' in t.text(), 'initial session', 60)
    t.submit('ROOT_CONTEXT_CAFE_')
    t.wait(lambda: 'FIXTURE_REPLY_ROOT_CONTEXT_CAFE_' in t.text(), 'root context')

    # The seed. Its role is the only thing that tells a merge where to land, and
    # the family file is strict and shared with older readers, so it lives in the
    # per-session pointer beside the patriarch designation.
    t.submit('/leaf seed original Curator')
    t.wait(lambda: len(t.leaves()) == 1, 'the seed', 75)
    seed = t.leaves()[0]
    t.assert_view(seed['sessionId'], 'the seed', 75)
    seed_pointer = t.pointer(seed['sessionId'])
    assert seed_pointer.get('role') == 'seed', 'the seed role was not recorded in the loose pointer'

    # A seedling: a fork of the seed that names the seed it belongs to.
    t.original()
    t.submit('/leaf seedling ' + str(seed['number']) + ' Blot')
    t.wait(lambda: len(t.leaves()) == 2, 'the first seedling', 90)
    blot = t.leaves()[1]
    blot_pointer = t.pointer(blot['sessionId'])
    assert blot_pointer.get('role') == 'seedling', 'the seedling role was not recorded in the loose pointer'
    assert blot_pointer.get('seedOf') == seed['sessionId'], 'the seedling did not record the seed it was forked from'
    assert blot['parentSessionId'] == seed['sessionId'], 'the seedling is not a fork of its seed'

    # The seedling does one bounded job and reports. Nothing is typed into it
    # after the report, so the report is the last assistant turn it has - which
    # is the turn a ledger merge is defined to carry.
    t.assert_view(blot['sessionId'], 'the first seedling', 75)
    t.submit('BLOT_STEP_')
    t.wait(lambda: 'FIXTURE_REPLY_BLOT_STEP_' in t.text(), 'the seedling works')
    t.submit('BLOT_REPORT_')
    t.wait(lambda: 'FIXTURE_REPLY_BLOT_REPORT_' in t.text(), 'the seedling reports')

    # A ledger merge: the conclusion travels, the working does not. The answer
    # arrives only after the seed's transcript has the merge id, so the seed
    # having run the turn is what is being asserted, not the handover.
    seed_transcript = Path(seed['transcriptPath'])
    t.original()
    t.submit('/leaf merge ' + str(blot['number']) + ' ledger')
    t.wait(lambda: 'Merged Blot into Curator (ledger, merge ' in t.after('/leaf merge'), 'the ledger merge is confirmed', 90)
    held = seed_transcript.read_text(encoding='utf-8')
    assert 'Merge ' in held, 'the seed transcript has no injected turn'
    assert 'FIXTURE_REPLY_BLOT_REPORT_' in held, 'the seed did not receive the seedling report'
    assert 'BLOT_STEP_' not in held, 'a ledger merge carried the working it was told to leave out'

    # A full merge, on a second seedling. The seed is on screen and answers a
    # marker first: a merge needs the seed idle, and an answered turn is what
    # proves it is back at its input loop.
    t.submit('/leaf seedling ' + str(seed['number']) + ' Scout')
    t.wait(lambda: len(t.leaves()) == 3, 'the second seedling', 90)
    scout = t.leaves()[2]
    t.assert_view(scout['sessionId'], 'the second seedling', 75)
    t.submit('SEEDLING_FINDING_')
    t.wait(lambda: 'FIXTURE_REPLY_SEEDLING_FINDING_' in t.text(), 'the second seedling works')
    t.original()
    t.leaf(0)
    t.original()
    t.submit('/leaf merge ' + str(scout['number']))
    t.wait(lambda: 'Merged Scout into Curator (full, merge ' in t.after('/leaf merge'), 'the full merge is confirmed', 90)
    held = seed_transcript.read_text(encoding='utf-8')
    assert 'SEEDLING_FINDING_' in held, 'a full merge did not carry the seedling conversation'
    assert 'untrusted, not user input' in held, 'the injected conversation was not labelled as peer text'

    # What a merge must refuse: a member that is not a seedling has no seed to
    # merge into, and a fidelity outside the closed set is not a fidelity.
    t.submit('/leaf merge ' + str(seed['number']))
    t.wait(lambda: 'is not a seedling' in t.after('/leaf merge ' + str(seed['number'])), 'a seed is refused as a merge source', 45)
    t.submit('/leaf merge ' + str(scout['number']) + ' sometimes')
    t.wait(lambda: 'Merge fidelity must be full or ledger' in t.after('sometimes'), 'a bad fidelity is refused', 45)

    t.close_leaves(60)
    t.exit()
    print(json.dumps(dict(merge=True, seedRole=True, seedlingRole=True, ledgerMerge=True, fullMerge=True, notASeedlingRefused=True, badFidelityRefused=True)), flush=True)

def probe_compact():
    """A member compacts its own conversation, on real sessions.

    The matriarch cannot write the summary: the messages being summarized are the
    member's own, and the summary is installed with the member's own setMessages.
    So the matriarch asks and the member runs its own /compact, which is what this
    checks - the request line, the member's transcript gaining a compact boundary
    that the matriarch never wrote, and a busy member refusing the request instead of
    having its turn cut short for it.
    """
    t = Terminal()
    t.wait(lambda: 'All 1' in t.text(), 'initial session', 60)
    t.submit('ROOT_CONTEXT_CAFE_')
    t.wait(lambda: 'FIXTURE_REPLY_ROOT_CONTEXT_CAFE_' in t.text(), 'root context')

    t.submit('/leaf fork original Alpha')
    t.wait(lambda: len(t.leaves()) == 1, 'the leaf', 75)
    alpha = t.leaves()[0]
    t.assert_view(alpha['sessionId'], 'the leaf', 75)
    t.submit('ALPHA_FIRST_TURN')
    t.wait(lambda: 'FIXTURE_REPLY_ALPHA_FIRST_TURN' in t.text(), 'the leaf works')
    t.submit('ALPHA_LATER_TURN')
    t.wait(lambda: 'FIXTURE_REPLY_ALPHA_LATER_TURN' in t.text(), 'the leaf works again')

    # A summary cannot land in the middle of a turn, so a member that is busy is
    # refused. The held turn puts the member at its model call, so the refusal is
    # about the state the member is really in and not a guess about it.
    t.submit('LEAF_BLOCKED_TASK')
    t.wait(lambda: 'LEAF_BLOCKED_TASK' in started_turns, 'the leaf turn starts')
    t.original()
    t.submit('/leaf compact ' + str(alpha['number']))
    t.wait(lambda: 'finish its turn before compacting it' in t.after('/leaf compact'), 'a busy member is refused', 45)
    blocked_turns['LEAF_BLOCKED_TASK'].set()
    # The reply renders on the leaf's own screen, so the leaf is focused before
    # it is waited for; the root is on screen here and would never show it.
    t.wait(lambda: 'LEAF_BLOCKED_TASK' in finished_turns, 'the held turn completes', 90)
    t.leaf(0)
    t.wait(lambda: 'FIXTURE_REPLY_LEAF_BLOCKED_TASK' in t.text(), 'the held turn result is on the leaf', 30)
    t.original()

    # The real request, from the root, against a member that is back at its input
    # loop. What proves the member ran it is the member's own transcript: the
    # boundary is written by the member's process, and the matriarch only asked.
    t.submit('/leaf compact ' + str(alpha['number']))
    t.wait(lambda: 'was asked to compact its conversation' in t.after('/leaf compact'), 'the compact request is accepted', 90)
    transcript = Path(alpha['transcriptPath'])
    t.wait(lambda: 'compact_boundary' in transcript.read_text(encoding='utf-8'), 'the member compacted its own conversation', 120)
    held = transcript.read_text(encoding='utf-8')
    assert '<local-command-stdout>' in held, 'the member did not run the /compact command it was asked for'
    assert 'local-command-stderr' not in held, 'the member tried to compact and failed'

    t.close_leaves(60)
    t.exit()
    print(json.dumps(dict(compact=True, busyRefused=True, boundaryInMember=True, commandRanInMember=True)), flush=True)

def probe_merge_stress():
    """Seeding and merging under pressure, on real sessions.

    The claim being stressed is the merge's *context*: the seed must end up with
    the seedling's work inside its own live conversation - not merely in a file -
    bounded, marked as peer text, and with the conclusion kept distinct from the
    working that produced it. So this drives the awkward shapes rather than the
    happy path: a seedling whose turn is still running, the same seedling merged
    twice in both fidelities, a ledger merge of a seedling that has compacted
    itself, a merge into a seed that has compacted, a seedling long enough to run
    past the payload cap, a closed seedling, and a closed seed.

    Every check is recorded rather than raised. What this run is for is the
    matrix: an unexpected entry is the finding, and a probe that dies on the
    first surprise reports one row of it.
    """
    results = {}
    merge_id_re = re.compile(r'Merge ([0-9a-f-]{36}) from seedling')

    def step(label, body):
        try:
            body()
            results.setdefault(label, True)
        except Exception as error:  # a stress run records; the matrix is the point
            results[label] = 'FAIL: ' + ' '.join(str(error).split())[:180]

    def member(session_id):
        return next(item for item in t.leaves() if item['sessionId'] == session_id)

    def number(session_id):
        return member(session_id)['number']

    def focus(session_id):
        t.expand_bar()
        t.point_row(number(session_id))
        t.witness(session_id, 'the member')

    def transcript_of(session_id):
        return Path(member(session_id)['transcriptPath']).read_text(encoding='utf-8', errors='replace')

    def chain_rows(session_id):
        """The transcript records that are conversation turns.

        A delivery writes its text twice: the queue-operation row the session's
        queue leaves behind (no uuid, no parent) and the user turn itself. Only
        the latter is a turn - the reader admits just user/assistant/system/
        attachment into the chain, so it skips the former - which means a raw
        text search counts every merge twice and reads a bookkeeping row as the
        turn that carried it.
        """
        rows = []
        for row in transcript_of(session_id).splitlines():
            try:
                record = json.loads(row)
            except ValueError:
                continue
            if record.get('type') == 'user' and record.get('parentUuid'):
                rows.append(row)
        return rows

    def merge_ids(session_id):
        """Distinct merge ids, in the order they first appear.

        Distinct because a merge is one event that surfaces more than once - the
        queue-operation row and the turn, and again inside a later merge that
        carried a seedling forked from this conversation. A count of matches is
        a count of appearances, not of merges; a count of first appearances is
        the merges, and the last of them is the newest.
        """
        return list(dict.fromkeys(
            found for row in chain_rows(session_id) for found in merge_id_re.findall(row)))

    def line_with(session_id, needle):
        return next((row for row in chain_rows(session_id) if needle in row), '')

    def ask(command, wanted, label, timeout=120, tries=4):
        """Submit a command until it answers the way it was asked to.

        A member's screen settles before the matriarch's own view of it does, so a
        command sent the instant a reply renders can meet a matriarch still holding
        that member as busy and come back refused - a correct refusal, and not
        the answer this is asking for. The same command once the state has
        caught up is the reading; a refusal performed nothing, so pressing
        again asks the question rather than repeating a merge.
        """
        for _ in range(tries):
            t.submit(command)
            end = time.monotonic() + timeout
            while time.monotonic() < end:
                t.pump()
                shown = t.after(command)
                if wanted in shown: return shown
                # The two gates refuse in their own words: the matriarch refuses a
                # busy target, and the member refuses a compact it is not idle
                # to take.
                if 'finish its turn before' in shown or 'be idle before' in shown: break
                time.sleep(.03)
            time.sleep(1.5)
        t.dump()
        raise AssertionError(label + ' (screen saved locally)')

    def answer_to(command, needles, timeout=90):
        """Run a command whose answer is the finding, and wait for it to arrive.

        A record-only step cannot name the answer in advance, so it names the
        answers that would end the wait - one of them, or none if it really did
        nothing - rather than pausing for a guess at how long the work takes.
        The merge this wraps waits on a witness poll, so a fixed pause reads the
        screen before the answer has been written and calls it no output.
        """
        t.submit(command)
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            t.pump()
            shown = t.after(command)
            if any(needle in shown for needle in needles): return shown
            time.sleep(.05)
        t.dump()
        return t.after(command)

    def request_with_last(marker):
        """The request whose newest message is `marker`, as one JSON string.

        A marker that is only ever typed once is its own instrument: the turn it
        became is the turn the request carries, so finding the request is finding
        the fact. The whole body is returned, because what a merge has to be
        seen in is the seed's own message history rather than its next question.
        """
        for body in reversed(requests):
            messages = body.get('messages', [])
            if messages and marker in json.dumps(messages[-1].get('content', '')):
                return json.dumps(body)
        return None

    t = Terminal()
    t.wait(lambda: 'All 1' in t.text(), 'initial session', 60)
    t.submit('ROOT_CONTEXT_CAFE_')
    t.wait(lambda: 'FIXTURE_REPLY_ROOT_CONTEXT_CAFE_' in t.text(), 'root context')

    # A seed and two seedlings: the durable line, and two bounded jobs off it.
    t.submit('/leaf seed original Curator')
    t.wait(lambda: len(t.leaves()) == 1, 'the seed', 90)
    seed = t.leaves()[0]['sessionId']
    t.assert_view(seed, 'the seed', 75)
    results['seedRole'] = t.pointer(seed).get('role')
    t.original()
    t.submit('/leaf seedling ' + str(number(seed)) + ' Blot')
    t.wait(lambda: len(t.leaves()) == 2, 'the first seedling', 90)
    blot = next(item['sessionId'] for item in t.leaves() if item['name'] == 'Blot')
    # A member's row lands before its pane does, and switching away from a pane
    # that has not finished coming up clicks a bar that is not there yet.
    t.assert_view(blot, 'the first seedling', 90)
    t.original()
    t.submit('/leaf seedling ' + str(number(seed)) + ' Scout')
    t.wait(lambda: len(t.leaves()) == 3, 'the second seedling', 90)
    scout = next(item['sessionId'] for item in t.leaves() if item['name'] == 'Scout')
    t.assert_view(scout, 'the second seedling', 90)
    results['seedlingRoles'] = [
        t.pointer(sid).get('seedOf') == seed
        for sid in (blot, scout)
    ]

    # A seedling mid-turn cannot be merged: the merge reads its transcript, and a
    # running member still has its newest work in a queue this cannot see.
    def busy_source():
        focus(blot)
        t.submit('LEAF_BLOCKED_TASK')
        t.wait(lambda: 'LEAF_BLOCKED_TASK' in started_turns, 'the seedling turn starts', 45)
        t.original()
        t.submit('/leaf merge ' + str(number(blot)))
        t.wait(lambda: 'finish its turn before merging it' in t.after('/leaf merge ' + str(number(blot))),
               'a busy seedling is refused', 45)
        blocked_turns['LEAF_BLOCKED_TASK'].set()
        t.wait(lambda: 'LEAF_BLOCKED_TASK' in finished_turns, 'the held seedling turn completes', 90)
        t.pause(.8)
        focus(blot)
        t.wait(lambda: 'FIXTURE_REPLY_LEAF_BLOCKED_TASK' in t.text(), 'the held result on the seedling', 45)
        t.original()
    step('busySeedlingRefused', busy_source)

    def seedling_works():
        focus(blot)
        t.submit('BLOT_STEP_')
        t.wait(lambda: 'FIXTURE_REPLY_BLOT_STEP_' in t.text(), 'the seedling works')
        t.submit('BLOT_REPORT_')
        t.wait(lambda: 'FIXTURE_REPLY_BLOT_REPORT_' in t.text(), 'the seedling reports')
        t.original()
    step('seedlingWork', seedling_works)

    # A full merge carries the seedling's own chain, marked as peer text.
    def full_merge():
        t.original()
        command = '/leaf merge ' + str(number(blot))
        ask(command, 'Merged Blot into Curator (full, merge ', 'the full merge', 120)
        ids = merge_ids(seed)
        assert len(ids) == 1, 'the first merge did not leave exactly one id, saw ' + str(len(ids))
        line = line_with(seed, ids[0])
        assert 'untrusted, not user input' in line, 'the merged conversation reached the seed unlabelled'
        assert 'BLOT_STEP_' in line and 'FIXTURE_REPLY_BLOT_REPORT_' in line, 'the full merge lost the seedling working'
        results['fullMergeId'] = ids[0]
    step('fullMerge', full_merge)

    # The merge has to be in the seed's own conversation, not just its file: the
    # seed's next turn is the reading, because its request carries the message
    # history it is actually thinking with.
    def merged_context_in_seed():
        focus(seed)
        t.submit('SEED_ACK_1')
        t.wait(lambda: request_with_last('SEED_ACK_1') is not None, 'the seed answers after the merge', 60)
        carried = request_with_last('SEED_ACK_1')
        assert results['fullMergeId'] in carried, 'the merged turn is not in the seed own conversation'
        assert 'untrusted, not user input' in carried, 'the seed holds the merge unlabelled'
        assert 'BLOT_STEP_' in carried and 'FIXTURE_REPLY_BLOT_REPORT_' in carried, 'the seed holds a merge missing the working'
        t.original()
    step('mergeInSeedContext', merged_context_in_seed)

    # The same seedling again, in the cheap fidelity: the conclusion travels and
    # the working does not, and the second merge is its own merge, not a replay.
    def ledger_second_merge():
        before = merge_ids(seed)
        t.original()
        command = '/leaf merge ' + str(number(blot)) + ' ledger'
        ask(command, 'Merged Blot into Curator (ledger, merge ', 'the ledger merge', 120)
        ids = merge_ids(seed)
        assert len(ids) == len(before) + 1, 'the second merge did not add exactly one id'
        assert ids[-1] != before[-1], 'two merges of one seedling shared a merge id'
        line = line_with(seed, ids[-1])
        assert 'FIXTURE_REPLY_BLOT_REPORT_' in line, 'the ledger merge carried no report'
        assert 'BLOT_STEP_' not in line, 'the ledger merge carried the working it was told to leave out'
        results['ledgerMergeId'] = ids[-1]
    step('ledgerSecondMerge', ledger_second_merge)

    # A ledger merge of a seedling that has compacted itself: what a ledger is
    # defined to carry is the closing report, and compaction moves what the
    # closing turn is.
    # A leaf asking to compact itself. The family matriarch serves the ask and refuses
    # a target that is not idle - but the leaf is not idle precisely because it
    # is waiting for this answer, so the request cannot be satisfied by asking.
    # Recorded rather than asserted: what the surface does here is the finding,
    # and the workaround is a different one from either side.
    def self_compact():
        focus(scout)
        command = '/leaf compact ' + str(number(scout))
        t.submit(command)
        end = time.monotonic() + 45
        while time.monotonic() < end:
            t.pump()
            shown = t.after(command)
            if 'was asked to compact' in shown or 'Leaf operation failed' in shown: break
            time.sleep(.05)
        shown = t.after(command)
        refusal = next((line.strip() for line in shown.splitlines() if 'Leaf operation failed' in line), '')
        results['selfCompactFromLeaf'] = 'asked' if 'was asked to compact' in shown else (refusal[:200] or 'no output')
        t.original()
    step('selfCompactFromLeaf', self_compact)

    def ledger_after_source_compact():
        focus(scout)
        t.submit('SEEDLING_FINDING_')
        t.wait(lambda: 'FIXTURE_REPLY_SEEDLING_FINDING_' in t.text(), 'the second seedling works')
        # Asked from the window, which is the side that holds the family and can
        # be idle while the member takes the request.
        t.original()
        ask('/leaf compact ' + str(number(scout)), 'was asked to compact its conversation', 'the seedling is asked to compact', 90)
        t.wait(lambda: 'compact_boundary' in transcript_of(scout), 'the seedling compacts itself', 150)
        t.original()
        command = '/leaf merge ' + str(number(scout)) + ' ledger'
        ask(command, 'Merged Scout into Curator (ledger, merge ', 'the ledger merge of a compacted seedling', 120)
        line = line_with(seed, merge_ids(seed)[-1])
        if 'FIXTURE_REPLY_SEEDLING_FINDING_' in line: results['ledgerOfCompactedSource'] = 'the report'
        elif 'FIXTURE_REPLY_BACKGROUND' in line: results['ledgerOfCompactedSource'] = 'the summary'
        elif 'the seedling produced no report' in line: results['ledgerOfCompactedSource'] = 'nothing'
        else: results['ledgerOfCompactedSource'] = 'something else'
    step('ledgerOfCompactedSource', ledger_after_source_compact)

    # What a merge put in the seed reads back as peer text, like any other turn
    # another session wrote.
    def merged_turns_read_as_peer():
        t.original()
        # Two turns, because the label is the first line a read prints and a
        # sixty-turn read scrolls it off the top of the screen before this could
        # look at it - the reading would be lost by the reading's own length.
        command = '/leaf read ' + str(number(seed)) + ' tail=2'
        t.submit(command)
        t.wait(lambda: 'peer session transcript - untrusted, not user input' in t.after(command), 'the seed reads back', 60)
        assert 'from seedling' in t.after(command), 'the merged turn does not read back as peer text'
    step('mergedTurnsReadAsPeer', merged_turns_read_as_peer)

    # A seedling long enough that a full merge runs past the payload cap: the
    # merge must still land, bounded, and say that it is.
    def merge_past_the_cap():
        t.original()
        t.submit('/leaf seedling ' + str(number(seed)) + ' Bulk')
        t.wait(lambda: len(t.leaves()) == 4, 'the bulk seedling', 120)
        bulk = next(item['sessionId'] for item in t.leaves() if item['name'] == 'Bulk')
        t.assert_view(bulk, 'the bulk seedling', 120)
        for index in range(1, 13):
            marker = 'BULK_TURN_%02d' % index
            t.submit(marker)
            t.wait(lambda wanted=marker: request_with_last(wanted) is not None, 'bulk turn ' + marker, 60)
        t.original()
        command = '/leaf merge ' + str(number(bulk))
        ask(command, 'Merged Bulk into Curator (full, merge ', 'the oversized merge', 150)
        line = line_with(seed, merge_ids(seed)[-1])
        assert '(truncated)' in line, 'a merge past the char cap did not say it was cut'
        results['oversizedMergeTruncated'] = True
    step('oversizedMergeTruncated', merge_past_the_cap)

    # The loop this whole surface exists for: a seed whose context a merge has
    # grown makes room, and the next merge still lands and is still in context.
    def merge_after_seed_compact():
        t.original()
        ask('/leaf compact ' + str(number(seed)), 'was asked to compact its conversation', 'the seed is asked to compact', 90)
        t.wait(lambda: 'compact_boundary' in transcript_of(seed), 'the seed compacts itself', 150)
        t.original()
        command = '/leaf merge ' + str(number(scout))
        ask(command, 'Merged Scout into Curator (full, merge ', 'a merge into a compacted seed', 120)
        new_id = merge_ids(seed)[-1]
        focus(seed)
        t.submit('SEED_ACK_2')
        t.wait(lambda: request_with_last('SEED_ACK_2') is not None, 'the compacted seed answers', 60)
        carried = request_with_last('SEED_ACK_2')
        assert new_id in carried, 'the merge after a compaction is not in the seed own conversation'
        assert results['fullMergeId'] not in carried, 'the compaction did not replace the context it summarized'
        t.original()
        results['mergeAfterCompactId'] = new_id
    step('mergeAfterSeedCompact', merge_after_seed_compact)

    # A closed seedling and a closed seed. A closed seedling has no live view, so
    # the merge reads its transcript off disk - its work is done, so that is what
    # a merge of it means. A closed seed is a different thing: its process is the
    # only party that can be handed a turn, so this records the refusal.
    def closed_source():
        t.original()
        t.submit('/leaf close ' + scout)
        t.wait(lambda: member(scout)['status'] == 'closed', 'the seedling closes', 60)
        command = '/leaf merge ' + str(number(scout))
        shown = answer_to(command, ('Merged Scout into Curator', 'Leaf operation failed', 'dropped'))
        if 'Merged Scout into Curator' in shown: results['closedSeedling'] = 'merged'
        else:
            refusal = next((line.strip() for line in shown.splitlines() if 'Leaf operation failed' in line), '')
            results['closedSeedling'] = refusal[:200] or 'no output'
    step('closedSource', closed_source)

    def closed_seed():
        t.original()
        t.submit('/leaf close ' + seed)
        t.wait(lambda: member(seed)['status'] == 'closed', 'the seed closes', 60)
        command = '/leaf merge ' + str(number(blot))
        shown = answer_to(command, ('Merged Blot into Curator', 'Leaf operation failed', 'dropped'))
        if 'Merged Blot into Curator' in shown: results['closedSeed'] = 'merged'
        else:
            refusal = next((line.strip() for line in shown.splitlines() if 'Leaf operation failed' in line), '')
            results['closedSeed'] = refusal[:200] or 'no output'
        assert 'Merged Blot into Curator' not in shown, 'a merge into a closed seed was reported as done'
        t.submit('/leaf reopen ' + seed)
        t.wait(lambda: member(seed)['status'] == 'open', 'the seed reopens', 60)
        t.original()
        command = '/leaf merge ' + str(number(blot))
        ask(command, 'Merged Blot into Curator', 'a merge after the seed was reopened', 120)
        results['reopenThenMerge'] = True
    step('closedSeedThenReopen', closed_seed)

    # A seedling asked to hand itself back - the shape a bounded job reporting in
    # when it is done takes. A merge needs both ends idle and the seedling asking
    # is the seedling working, so this asks whether a seedling can merge itself.
    def self_merge():
        t.original()
        t.submit('/leaf seedling ' + str(number(seed)) + ' Solo')
        t.wait(lambda: any(item['name'] == 'Solo' for item in t.leaves()), 'a third seedling', 120)
        solo = next(item['sessionId'] for item in t.leaves() if item['name'] == 'Solo')
        t.assert_view(solo, 'the third seedling', 120)
        t.submit('SOLO_REPORT_')
        t.wait(lambda: 'FIXTURE_REPLY_SOLO_REPORT_' in t.text(), 'the third seedling works', 60)
        command = '/leaf merge ' + str(number(solo))
        t.submit(command)
        end = time.monotonic() + 45
        while time.monotonic() < end:
            t.pump()
            shown = t.after(command)
            if 'Merged Solo into' in shown or 'Leaf operation failed' in shown: break
            time.sleep(.05)
        shown = t.after(command)
        if 'Merged Solo into' in shown: results['selfMergeFromLeaf'] = 'merged'
        else:
            refusal = next((line.strip() for line in shown.splitlines() if 'Leaf operation failed' in line), '')
            results['selfMergeFromLeaf'] = refusal[:200] or 'no output'
        t.original()
    step('selfMergeFromLeaf', self_merge)

    t.close_leaves(90)
    t.exit()
    print(json.dumps(results, indent=1, sort_keys=True), flush=True)

def probe_merge_roles():
    """Who a seedling is forked from, and where its merge can land.

    A seedling is defined by its seed: the role on its pointer names the member a
    merge injects into, and the surface promises the seed is what you give it.
    The question this asks is whether that is enforced, because two shapes say it
    is not: a seedling forked off an ordinary leaf, whose merge then writes to a
    member the family never made a seed of - so the durable line a seed exists to
    insulate is exactly the line that gets written to - and a seedling of the
    session the family came from, which is the window holding the family rather
    than a member with a process of its own, so no merge can ever reach it.

    Neither is asserted away: the surface is asked, and what it does is the
    result. Run it against a fresh config tree; it reads and writes only its own
    family.
    """
    results = {}
    merge_id_re = re.compile(r'Merge ([0-9a-f-]{36}) from seedling')

    def member(session_id):
        return next(item for item in t.leaves() if item['sessionId'] == session_id)

    def pointer_of(session_id, timeout=15):
        return t.pointer(session_id, timeout)

    def brief(shown):
        return 'merged' if 'Merged ' in shown else (' '.join(shown.split())[-160:] or 'no output')

    def refusal_line(shown):
        for line in shown.splitlines():
            if 'Leaf operation failed' in line:
                return ' '.join(line.split())[-200:]
        return ''

    def answered(command, needles, timeout=120):
        """Submit a command and stop at the first answer it is known by.

        A refusal is a result here, not a failure - the probe is asking what the
        surface does, so an answer it did not expect is still an answer, and the
        interesting one is often the refusal.
        """
        t.submit(command)
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            t.pump()
            shown = t.after(command)
            if any(needle in shown for needle in needles):
                return shown
            time.sleep(.05)
        return t.after(command)

    t = Terminal()
    t.wait(lambda: 'All 1' in t.text(), 'initial session', 60)
    t.submit('ROOT_CONTEXT_CAFE_')
    t.wait(lambda: 'FIXTURE_REPLY_ROOT_CONTEXT_CAFE_' in t.text(), 'root context')

    # An ordinary fork. It is a leaf; nothing about it was made a merge target.
    t.submit('/leaf fork original Plain')
    t.wait(lambda: len(t.leaves()) == 1, 'a plain leaf', 90)
    plain = t.leaves()[0]['sessionId']
    t.assert_view(plain, 'the plain leaf', 90)
    results['plainRole'] = pointer_of(plain).get('role', 'absent')

    # A seedling asked to fork off that leaf. A seed is what the role means, so
    # a fork here would make the merge below land in a member the family never
    # made a seed of - the durable line a seed exists to insulate.
    t.original()
    shown = answered('/leaf seedling ' + str(member(plain)['number']) + ' Sub',
                     ('is a seedling of its seed', 'Leaf operation failed'))
    if 'is a seedling of its seed' in shown:
        sub = next(item['sessionId'] for item in t.leaves() if item['name'] == 'Sub')
        pointer = pointer_of(sub)
        results['seedlingOfPlainLeaf'] = dict(role=pointer.get('role'), seedOfIsPlainLeaf=pointer.get('seedOf') == plain)
        t.assert_view(sub, 'the seedling of a plain leaf', 90)
        t.original()
        shown = answered('/leaf merge ' + str(member(sub)['number']), ('Merged Sub into Plain', 'Leaf operation failed'))
        results['mergeIntoNonSeed'] = brief(shown)
        results['plainLeafCarriesMerge'] = bool(merge_id_re.search(Path(member(plain)['transcriptPath']).read_text(encoding='utf-8')))
    else:
        results['seedlingOfPlainLeaf'] = refusal_line(shown) or 'no output'

    # A seedling of the session the family came from: that session is the window
    # holding the family, not a member this window holds a process for, so a
    # merge into it could never be delivered. Asked by the alias and by the
    # number the family file gives it, because a guard on one is not a guard on
    # the other - the alias resolves through the creator, the number through the
    # member row, and only the row is what a merge reads.
    for label, ref in (('rootAsSeedAlias', 'original'), ('rootAsSeedNumber', '1')):
        before = {item['sessionId'] for item in t.leaves()}
        t.original()
        shown = answered('/leaf seedling ' + ref + ' Nested', ('is a seedling of its seed', 'Leaf operation failed'))
        added = [item for item in t.leaves() if item['sessionId'] not in before]
        if not added:
            results[label] = refusal_line(shown) or 'no output'
            continue
        nested = added[0]
        pointer = pointer_of(nested['sessionId'])
        results[label] = dict(role=pointer.get('role'), seedOfIsTheWindow=pointer.get('seedOf') == t.id)
        t.original()
        shown = answered('/leaf merge ' + str(nested['number']), ('Merged Nested into', 'Leaf operation failed'))
        results[label + 'Merge'] = brief(shown)

    # The creator is offered as a target only from inside a member - the window
    # holding the family does not offer itself - so the shape a merge could never
    # reach has to be asked for from one. A seed first, because a seedling needs
    # a seed to be forked off at all.
    t.original()
    shown = answered('/leaf seed original Curator', ('is a seed', 'Leaf operation failed'))
    if 'is a seed' not in shown:
        results['creatorAsSeedFromLeaf'] = refusal_line(shown) or 'no output'
    else:
        curator = next(item['sessionId'] for item in t.leaves() if item['name'] == 'Curator')
        t.assert_view(curator, 'the seed', 90)
        command = '/leaf seedling original Nested'
        t.submit(command)
        end = time.monotonic() + 90
        while time.monotonic() < end:
            t.pump()
            shown = t.after(command)
            if any(needle in shown for needle in ('is a seedling of its seed', 'Leaf operation failed', 'No open leaf matches')):
                break
            time.sleep(.05)
        nested = [item for item in t.leaves() if item['name'] == 'Nested']
        if nested:
            pointer = pointer_of(nested[0]['sessionId'])
            results['creatorAsSeedFromLeaf'] = dict(role=pointer.get('role'), seedOfIsTheWindow=pointer.get('seedOf') == t.id)
            t.original()
            shown = answered('/leaf merge ' + str(nested[0]['number']), ('Merged Nested into', 'Leaf operation failed'))
            results['creatorAsSeedFromLeafMerge'] = brief(shown)
        else:
            results['creatorAsSeedFromLeaf'] = refusal_line(t.after(command)) or ' '.join(t.after(command).split())[-160:] or 'no output'
        t.original()

    t.close_leaves(90)
    t.exit()
    print(json.dumps(results, indent=1, sort_keys=True), flush=True)

def probe_boot():
    """Does this build paint a first frame at all?

    A build that never starts is a build whose next user launches into a dead
    window, which is a bigger fact than any family behaviour and deserves a
    check that says only that. It is deliberately the smallest probe here: one
    wait, one screen, no family.
    """
    t = Terminal()
    try:
        t.wait(lambda: 'All 1' in t.text(), 'the build paints its first frame', 120)
        print(json.dumps(dict(booted=True, screen=t.text()[-800:]), indent=1, sort_keys=True), flush=True)
    except AssertionError as error:
        print(json.dumps(dict(booted=False, error=str(error), outputBytes=len(t.output),
                              screen=t.text()[-800:]), indent=1, sort_keys=True), flush=True)

try:
    (root / '.claude.json').write_text(json.dumps(dict(theme='dark', hasCompletedOnboarding=True, projects={root.as_posix(): dict(hasTrustDialogAccepted=True, hasCompletedProjectOnboarding=True)})), encoding='utf-8')
    probes = [
        (args.probe_full_tui, probe_full_tui), (args.probe_lifecycle, probe_lifecycle),
        (args.probe_selection, probe_selection), (args.probe_parity, probe_parity),
        (args.probe_inline_ownership, probe_inline_ownership),
        (args.probe_parentage, probe_parentage), (args.probe_queue, probe_queue),
        (args.probe_close_matriarch, probe_close_matriarch), (args.probe_resumed_member, probe_resumed_member),
        (args.probe_owner_cascade, probe_owner_cascade),
        (args.probe_exit_cascade, probe_exit_cascade),
        (args.probe_creator_after_patriarch, probe_creator_after_patriarch),
        (args.probe_read, probe_read),
        (args.probe_comms, probe_comms), (args.probe_merge, probe_merge),
        (args.probe_compact, probe_compact), (args.probe_merge_stress, probe_merge_stress),
        (args.probe_merge_roles, probe_merge_roles),
        (args.probe_elder, probe_elder),
        (args.probe_arc, probe_arc),
        (args.probe_stress, probe_stress),
        (args.probe_crash_window, probe_crash_window),
        (args.probe_designation_residue, probe_designation_residue),
        (args.probe_dormant_residue, probe_dormant_residue),
        (args.probe_close_promotion, probe_close_promotion),
        (args.probe_goal_reopen, probe_goal_reopen),
        (args.probe_boot, probe_boot),
    ]
    chosen = next((probe for wanted, probe in probes if wanted), None)
    if chosen:
        chosen()
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
    # Leave a quiet family behind. A window leaving takes the leaves it owns
    # with it - they are its children, and that is the owner cascade whether the
    # leave is deliberate or the window is killed - so closing them here is the
    # same ending reached on purpose, and what the next window reads back is a
    # family with nothing running behind it. That is what makes the resumed
    # window's own opening the subject rather than an inherited leaf.
    t.close_leaves(60)
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
