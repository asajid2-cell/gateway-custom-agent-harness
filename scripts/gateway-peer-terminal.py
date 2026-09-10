"""Local-only two-terminal peer delivery test; no live provider or user sessions."""
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
from winpty import PtyProcess

parser = argparse.ArgumentParser()
parser.add_argument('cli', type=Path)
args = parser.parse_args()
root = Path(tempfile.mkdtemp(prefix='gateway-peer-terminal-'))
processes = []
requests = []
gate_entered = threading.Event()
gate_release = threading.Event()
errors = []


def content_text(content):
    if isinstance(content, str):
        return content
    return '\n'.join(block.get('text', '') if block.get('type') != 'tool_result' else content_text(block.get('content')) for block in (content or []))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        messages = body.get('messages', [])
        last_assistant = next((index for index in range(len(messages) - 1, -1, -1) if messages[index].get('role') == 'assistant'), -1)
        latest = '\n'.join(content_text(message.get('content')) for message in messages[last_assistant + 1:])
        requests.append(latest)
        if 'TERMINAL_BUSY_BASE' in latest and 'TERMINAL_BUSY_PEER' not in latest:
            gate_entered.set()
            if not gate_release.wait(30):
                errors.append('busy gate expired')
        tool_call = 'TERMINAL_BUSY_BASE' in latest and 'TERMINAL_BUSY_PEER' not in latest
        marker = 'TERMINAL_BUSY_PEER' if 'TERMINAL_BUSY_PEER' in latest else 'TERMINAL_IDLE_PEER' if 'TERMINAL_IDLE_PEER' in latest else 'TERMINAL_READY'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        frames = [
            dict(type='message_start', message=dict(id='msg_' + uuid.uuid4().hex, type='message', role='assistant', model='claude-sonnet-4-6', content=[], stop_reason=None, stop_sequence=None, usage=dict(input_tokens=100, output_tokens=0))),
            dict(type='content_block_start', index=0, content_block=dict(type='text', text='')),
            dict(type='content_block_delta', index=0, delta=dict(type='text_delta', text='RESPONSE_' + marker)),
            dict(type='content_block_stop', index=0),
            dict(type='message_delta', delta=dict(stop_reason='end_turn', stop_sequence=None), usage=dict(output_tokens=30)),
            dict(type='message_stop'),
        ]
        if tool_call:
            frames[1] = dict(type='content_block_start', index=0, content_block=dict(type='tool_use', id='tool_' + uuid.uuid4().hex, name='Read', input={}))
            frames[2] = dict(type='content_block_delta', index=0, delta=dict(type='input_json_delta', partial_json=json.dumps(dict(file_path=str(root / 'fixture.txt')))))
            frames[4]['delta']['stop_reason'] = 'tool_use'
        try:
            for frame in frames:
                self.wfile.write(('event: ' + frame['type'] + '\ndata: ' + json.dumps(frame) + '\n\n').encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()


class Terminal:
    def __init__(self, resume_id=None):
        self.id = resume_id or str(uuid.uuid4())
        self.output = ''
        self.chunks = queue.Queue(maxsize=256)
        env = {key: os.environ[key] for key in ('PATH', 'SystemRoot', 'TEMP', 'TMP', 'COMSPEC') if key in os.environ}
        url = f'http://127.0.0.1:{server.server_port}'
        env.update(HOME=str(root), USERPROFILE=str(root), CLAUDE_CONFIG_DIR=str(root), ANTHROPIC_AUTH_TOKEN='local-fixture-only', ANTHROPIC_BASE_URL=url, CLAUDE_CODE_GATEWAY_BASE_URL=url, CLAUDE_CODE_USE_GATEWAY='1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1', DISABLE_TELEMETRY='1', DISABLE_ERROR_REPORTING='1', NODE_ENV='production')
        self.proc = PtyProcess.spawn(subprocess.list2cmdline([shutil.which('bun'), str(args.cli.resolve()), '--resume' if resume_id else '--session-id', self.id, '--model', 'claude-sonnet-4-6', '--tools', 'Read', '--allowedTools', 'Read']), cwd=str(root), env=env, dimensions=(40, 120))
        processes.append(self.proc)
        def drain():
            try:
                while self.proc.isalive():
                    self.chunks.put(self.proc.read(65536))
            except (EOFError, OSError):
                pass
        threading.Thread(target=drain, daemon=True).start()

    def pump(self):
        while True:
            try:
                self.output = (self.output + self.chunks.get_nowait())[-131072:]
            except queue.Empty:
                return

    def submit(self, text):
        self.proc.write('\x1b[200~' + text + '\x1b[201~')
        end = time.monotonic() + 1
        while time.monotonic() < end:
            self.pump()
            time.sleep(0.025)
        self.proc.write('\r')

    def registration(self):
        return json.loads((root / 'gateway-sessions' / (self.id + '.json')).read_text(encoding='utf-8'))


def wait(predicate, label, terminals, timeout=45):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        for terminal in terminals:
            terminal.pump()
        if predicate():
            return
        time.sleep(0.025)
    print(json.dumps(dict(timeout=label, requests=len(requests), shapes=[dict(busy='TERMINAL_BUSY_PEER' in text, base='TERMINAL_BUSY_BASE' in text, oldWrapper='A background agent completed a task:' in text, chars=len(text)) for text in requests], alive=[t.proc.isalive() for t in terminals])), flush=True)
    raise AssertionError('Timed out: ' + label)


def send(sender, receiver, text):
    source, target = sender.registration(), receiver.registration()
    message = dict(id=str(uuid.uuid4()), fromSessionId=sender.id, fromRuntimeId=source['peer']['runtimeId'], toSessionId=receiver.id, summary='Terminal collaboration test', text=text, createdAt='2026-09-09T00:00:00.000Z')
    frame = dict(type='message', token=target['token'], senderToken=source['token'], message=message)
    with open(target['peer']['endpoint'], 'r+b', buffering=0) as pipe:
        pipe.write((json.dumps(frame) + '\n').encode('utf-8'))
        response = bytearray()
        while not response.endswith(b'\n'):
            chunk = pipe.read(4096)
            if not chunk:
                raise AssertionError('Peer closed without a receipt')
            response.extend(chunk)
    receipt = json.loads(response)
    assert receipt.get('state') == 'queued', 'Expected durable queue acceptance'
    return message['id']


try:
    (root / '.claude.json').write_text(json.dumps(dict(theme='dark', hasCompletedOnboarding=True, projects={root.as_posix(): dict(hasTrustDialogAccepted=True, hasCompletedProjectOnboarding=True)})), encoding='utf-8')
    (root / 'fixture.txt').write_text('Local peer boundary fixture.', encoding='utf-8')
    a = Terminal()
    wait(lambda: 'session:' in a.output and 'Leaves' in a.output, 'sender prompt', [a])
    b = Terminal()
    terminals = [a, b]
    wait(lambda: 'session:' in b.output and 'Leaves' in b.output, 'recipient prompt', terminals)
    wait(lambda: all((root / 'gateway-sessions' / (t.id + '.json')).exists() for t in terminals), 'registrations', terminals)
    exact = 'TERMINAL_IDLE_PEER\nExact text: café 世界 "quoted" \\path\n/clear is literal'
    idle_id = send(a, b, exact)
    wait(lambda: 'RESPONSE_TERMINAL_IDLE_PEER' in b.output, 'idle peer response', terminals)
    assert any(exact in text for text in requests), 'Idle payload changed before the model'
    wait(lambda: b.registration()['peer']['status'] == 'idle', 'recipient idle after peer', terminals)
    send(a, b, 'TERMINAL_BUSY_BASE: wait at the fixture gate.')
    wait(gate_entered.is_set, 'busy model boundary', terminals)
    busy_id = send(a, b, 'TERMINAL_BUSY_PEER\nThis is a new request, not a completed background task.')
    gate_release.set()
    wait(lambda: 'RESPONSE_TERMINAL_BUSY_PEER' in b.output, 'busy peer response', terminals)
    assert not any('A background agent completed a task:' in text and 'TERMINAL_BUSY_PEER' in text for text in requests), 'Peer request mislabelled as completed task'
    def persisted():
        path = root / 'gateway-sessions' / (b.id + '.inbox')
        records = json.loads(path.read_text(encoding='utf-8'))['records']
        return all(any(r['message']['id'] == id and r['state'] == 'delivered' for r in records) for id in (idle_id, busy_id))
    wait(persisted, 'both transcript receipts', terminals)
    assert not errors, errors
    # The model reply must not hide the actual incoming request from the human.
    assert 'Gateway peer collaboration request from' in b.output, 'Peer request not visible in terminal'
    transcript = '\n'.join(path.read_text(encoding='utf-8') for path in (root / 'projects').glob('*/*.jsonl'))
    assert idle_id in transcript and busy_id in transcript, 'Persisted peer identity missing'
    assert 'TERMINAL_BUSY_PEER' in transcript, 'Busy peer content missing from transcript'
    b.submit('/exit')
    wait(lambda: not b.proc.isalive(), 'recipient graceful exit', terminals)
    resumed = Terminal(b.id)
    terminals = [a, resumed]
    wait(lambda: 'session:' in resumed.output and 'Leaves' in resumed.output, 'resumed prompt', terminals)
    wait(lambda: (root / 'gateway-sessions' / (resumed.id + '.json')).exists(), 'resumed registration', terminals)
    baseline = len(requests)
    send(a, resumed, 'TERMINAL_IDLE_PEER new request after resume')
    wait(lambda: len(requests) > baseline and 'RESPONSE_TERMINAL_IDLE_PEER' in resumed.output, 'resumed fresh peer turn', terminals)
    assert not any('TERMINAL_BUSY_PEER' in text for text in requests[baseline:]), 'Previously delivered busy request re-executed after resume'
    print(json.dumps(dict(idleResponse=True, busyResponse=True, payloadExact=True, receiptsPersisted=True, peerVisible=True, resumeNoReplay=True, modelRequests=len(requests))), flush=True)
finally:
    gate_release.set()
    for proc in processes:
        if proc.isalive():
            proc.close(force=True)
    server.shutdown()
    server.server_close()
    shutil.rmtree(root, ignore_errors=True)
