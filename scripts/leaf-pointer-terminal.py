"""Compiled ConPTY leaf UX acceptance against a local-only model fixture."""
import argparse
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import pyte
from winpty import PtyProcess

parser = argparse.ArgumentParser()
parser.add_argument('cli', type=Path)
parser.add_argument('--fullscreen', action='store_true')
parser.add_argument('--columns', type=int, default=120)
parser.add_argument('--rows', type=int, default=40)
args = parser.parse_args()
root = Path(tempfile.mkdtemp(prefix='leaf-pointer-'))
requests = []
processes = []

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        messages = body.get('messages', [])
        latest = json.dumps(messages[-1].get('content', '') if messages else '')
        marker = 'FRESH_ONLY_TASK' if 'FRESH_ONLY_TASK' in latest else 'FORK_ONLY_TASK' if 'FORK_ONLY_TASK' in latest else 'ROOT_CONTEXT_CAFE_' if 'ROOT_CONTEXT_CAFE_' in latest else 'BACKGROUND'
        if marker != 'BACKGROUND': requests.append(body)
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
        for frame in frames:
            self.wfile.write(('event: ' + frame['type'] + '\ndata: ' + json.dumps(frame) + '\n\n').encode())
        self.wfile.flush()

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()

class Screen(pyte.Screen):
    reply = lambda self, text: None
    def report_device_status(self, mode, **kwargs):
        if mode == 6:
            private = '?' if kwargs.get('private') else ''
            self.reply(f'\x1b[{private}{self.cursor.y + 1};{self.cursor.x + 1}R')
    def report_device_attributes(self, mode=0, **kwargs):
        self.reply('\x1b[?1;2c')

class Terminal:
    def __init__(self, session_id=None):
        self.id = session_id or str(uuid.uuid4())
        self.chunks = queue.Queue(maxsize=256)
        self.screen = Screen(args.columns, args.rows)
        self.stream = pyte.Stream(self.screen)
        self.output = ''
        env = {key: os.environ[key] for key in ('PATH', 'SystemRoot', 'TEMP', 'TMP', 'COMSPEC') if key in os.environ}
        url = f'http://127.0.0.1:{server.server_port}'
        env.update(HOME=str(root), USERPROFILE=str(root), CLAUDE_CONFIG_DIR=str(root), ANTHROPIC_AUTH_TOKEN='local-fixture-only', ANTHROPIC_BASE_URL=url, CLAUDE_CODE_GATEWAY_BASE_URL=url, CLAUDE_CODE_USE_GATEWAY='1', CLAUDE_CODE_NO_FLICKER='1' if args.fullscreen else '0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1', DISABLE_TELEMETRY='1', DISABLE_ERROR_REPORTING='1', NODE_ENV='production')
        self.proc = PtyProcess.spawn(subprocess.list2cmdline([shutil.which('bun'), str(args.cli.resolve()), '--resume' if session_id else '--session-id', self.id, '--model', 'claude-sonnet-4-6']), cwd=str(root), env=env, dimensions=(args.rows, args.columns))
        processes.append(self.proc)
        self.screen.reply = self.proc.write
        def drain():
            try:
                while self.proc.isalive(): self.chunks.put(self.proc.read(65536))
            except (EOFError, OSError): pass
        threading.Thread(target=drain, daemon=True).start()
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
        self.proc.write('\x1b[200~' + text + '\x1b[201~'); self.pause(.5); self.proc.write('\r')
    def point(self, label):
        self.pause(.2)
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
    def family(self):
        path = root / 'leaf-families' / (self.id + '.json')
        return json.loads(path.read_text(encoding='utf-8')) if path.exists() else {'members': []}
    def original(self):
        self.click('All ' + str(len(self.family()['members']) + 1))
        self.click('Original')
        self.wait(lambda: 'session:' in self.text() and 'wheel switches' not in self.text(), 'original prompt restored')
        self.pause(.5)

try:
    (root / '.claude.json').write_text(json.dumps(dict(theme='dark', hasCompletedOnboarding=True, projects={root.as_posix(): dict(hasTrustDialogAccepted=True, hasCompletedProjectOnboarding=True)})), encoding='utf-8')
    t = Terminal()
    t.wait(lambda: 'All 1' in t.text(), 'initial carousel', 60)
    t.submit('ROOT_CONTEXT_CAFE_世界')
    t.wait(lambda: len(requests) >= 1 and 'FIXTURE_REPLY_ROOT_CONTEXT_CAFE_' in t.text(), 'root response')
    t.submit('/leaf fork original ForkOne')
    t.wait(lambda: len(t.family()['members']) == 1 and 'ForkOne [idle]' in t.text(), 'fork created')
    t.submit('FORK_ONLY_TASK')
    t.wait(lambda: len(requests) >= 2 and 'FIXTURE_REPLY_FORK_ONLY_TASK' in t.text(), 'fork response')
    assert 'ROOT_CONTEXT_CAFE_' in json.dumps(requests[-1]), 'Fork context missing'
    t.click('✎ Rename')
    t.wait(lambda: 'Enter saves' in t.text(), 'leaf rename field')
    t.proc.write('\x15'); t.pause(); t.proc.write('RenamedLeaf\r')
    t.wait(lambda: t.family()['members'][0]['name'] == 'RenamedLeaf', 'leaf rename saved')
    t.original()
    t.wait(lambda: 'session:' in t.text(), 'original restored')
    t.submit('/leaf new FreshOne')
    t.wait(lambda: len(t.family()['members']) == 2 and 'FreshOne [idle]' in t.text(), 'fresh leaf created')
    t.submit('FRESH_ONLY_TASK')
    t.wait(lambda: len(requests) >= 3 and 'FIXTURE_REPLY_FRESH_ONLY_TASK' in t.text(), 'fresh response')
    assert 'ROOT_CONTEXT_CAFE_' not in json.dumps(requests[-1]), 'Fresh leaf inherited context'
    t.wait(lambda: 'FreshOne [idle]' in t.text(), 'fresh turn idle before wheel')
    t.pause(.5)
    t.wheel('2 FreshOne', False)
    t.wait(lambda: 'RenamedLeaf [idle]' in t.text(), 'wheel switched leaf')
    t.click('All 3', hold=True)
    t.wait(lambda: 'All sessions' in t.text(), 'hold expanded picker')
    t.click('2 FreshOne [idle]')
    t.wait(lambda: 'FreshOne [idle]' in t.text() and 'All sessions' not in t.text(), 'picker switched leaf')
    t.original()
    t.click('✎ Rename')
    t.wait(lambda: 'Session metadata' in t.text(), 'pencil opens root rename')
    t.proc.write('\x15'); t.pause(); t.proc.write('RootRenamed\r')
    t.wait(lambda: 'Session metadata' not in t.text() and 'RootRenamed' in t.text(), 'root rename saved')
    t.pause(.5)
    t.submit('/exit')
    t.wait(lambda: not t.proc.isalive(), 'graceful exit')
    resumed = Terminal(t.id)
    resumed.wait(lambda: 'All 3' in resumed.text(), 'restored carousel', 45)
    resumed.click('All 3')
    resumed.click('1 RenamedLeaf [idle]')
    resumed.wait(lambda: 'FORK_ONLY_TASK' in resumed.text(), 'restored leaf history')
    resumed.submit('/leaf')
    resumed.wait(lambda: 'Create a leaf' in resumed.text(), 'creation menu inside leaf')
    resumed.proc.write('MenuFork'); resumed.pause()
    resumed.click('Copy context')
    resumed.wait(lambda: len(resumed.family()['members']) == 3 and 'MenuFork [idle]' in resumed.text(), 'menu context fork')
    assert resumed.family()['members'][-1]['parentSessionId'] == resumed.family()['members'][0]['sessionId'], 'Menu fork ancestry'
    resumed.submit('/leaf')
    resumed.wait(lambda: 'Create a leaf' in resumed.text(), 'new-chat menu inside leaf')
    resumed.proc.write('MenuFresh\r')
    resumed.wait(lambda: len(resumed.family()['members']) == 4 and 'MenuFresh [idle]' in resumed.text(), 'menu fresh chat')
    assert resumed.family()['members'][-1]['forkMessageId'] is None, 'Menu new copied context'
    print(json.dumps(dict(fullscreen=args.fullscreen, columns=args.columns, rows=args.rows, forkContext=True, freshIsolation=True, clickSwitch=True, wheelSwitch=True, holdPicker=True, rootRename=True, leafRename=True, restoredHistory=True, creationMenu=True, modelRequests=len(requests))), flush=True)
finally:
    import psutil
    for process in processes:
        try:
            parent = psutil.Process(process.pid)
            owned = parent.children(recursive=True) + [parent]
        except psutil.NoSuchProcess:
            continue
        for child in reversed(owned):
            try: child.terminate()
            except psutil.NoSuchProcess: pass
        _, alive = psutil.wait_procs(owned, timeout=10)
        assert not alive, 'Owned terminal fixture processes did not exit'
    server.shutdown(); server.server_close()
    print('EVIDENCE_DIRECTORY=' + str(root), flush=True)
