"""Two live families, each with a leaf, proving one leaf reaches another across sessions.

Both sessions and both leaves are real CLIs on the local fixture model. What is
under test is the cross-session path: a leaf of family A discovers a leaf of
family B on the peer bus, reaches it by address, and the reply arrives at exactly
that leaf and nowhere else.
"""
import argparse
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
from winpty import PtyProcess

parser = argparse.ArgumentParser()
parser.add_argument('cli', type=Path)
args = parser.parse_args()
root = Path(tempfile.mkdtemp(prefix='gateway-two-family-'))
processes = []
requests = []
errors = []
reply_nonce = 'LEAF_REPLY_FROM_BETA_' + uuid.uuid4().hex[:8]
# The leaf's own self-label carries the family it belongs to, which is what a
# cross-family listing has to show.
label_for = {}


def content_text(content):
    if isinstance(content, str):
        return content
    return '\n'.join(block.get('text', '') if block.get('type') != 'tool_result' else content_text(block.get('content')) for block in (content or []))


ANSI = re.compile(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))')


def stripped(terminal):
    """A terminal's bytes without the controls, so a screen label can be read."""
    terminal.pump()
    return ANSI.sub('', terminal.output.replace('\x1b[1C', ' '))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        messages = body.get('messages', [])
        last_assistant = next((index for index in range(len(messages) - 1, -1, -1) if messages[index].get('role') == 'assistant'), -1)
        latest = '\n'.join(content_text(message.get('content')) for message in messages[last_assistant + 1:])
        requests.append(latest)
        # A leaf told to answer another leaf answers by address, which is the
        # only way one family's member reaches another family's member: a leaf
        # number or name means nothing outside its own family.
        reply_to = re.search(r'SEND_LEAF_REPLY_TO=([0-9a-f-]{36})', latest)
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        frames = [
            dict(type='message_start', message=dict(id='msg_' + uuid.uuid4().hex, type='message', role='assistant', model='claude-sonnet-4-6', content=[], stop_reason=None, stop_sequence=None, usage=dict(input_tokens=100, output_tokens=0))),
            dict(type='content_block_start', index=0, content_block=dict(type='text', text='')),
            dict(type='content_block_delta', index=0, delta=dict(type='text_delta', text='RESPONSE_TERMINAL_READY')),
            dict(type='content_block_stop', index=0),
            dict(type='message_delta', delta=dict(stop_reason='end_turn', stop_sequence=None), usage=dict(output_tokens=30)),
            dict(type='message_stop'),
        ]
        if reply_to:
            frames[1] = dict(type='content_block_start', index=0, content_block=dict(type='tool_use', id='tool_' + uuid.uuid4().hex, name='SendMessage', input={}))
            frames[2] = dict(type='content_block_delta', index=0, delta=dict(type='input_json_delta', partial_json=json.dumps(dict(
                to='gateway:' + reply_to.group(1), summary='Cross-family leaf reply', message=reply_nonce))))
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
    """A real session in a real PTY, with the fixture standing in for the model."""

    def __init__(self):
        self.id = str(uuid.uuid4())
        self.output = ''
        self.chunks = queue.Queue(maxsize=256)
        env = {key: os.environ[key] for key in ('PATH', 'SystemRoot', 'TEMP', 'TMP', 'COMSPEC') if key in os.environ}
        url = f'http://127.0.0.1:{server.server_port}'
        env.update(HOME=str(root), USERPROFILE=str(root), CLAUDE_CONFIG_DIR=str(root), ANTHROPIC_AUTH_TOKEN='local-fixture-only', ANTHROPIC_BASE_URL=url, CLAUDE_CODE_GATEWAY_BASE_URL=url, CLAUDE_CODE_USE_GATEWAY='1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1', DISABLE_TELEMETRY='1', DISABLE_ERROR_REPORTING='1', NODE_ENV='production')
        self.proc = PtyProcess.spawn(subprocess.list2cmdline([shutil.which('bun'), str(args.cli.resolve()), '--session-id', self.id, '--model', 'claude-sonnet-4-6', '--tools', 'Read', '--allowedTools', 'Read']), cwd=str(root), env=env, dimensions=(40, 120))
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
                self.output = (self.output + self.chunks.get_nowait())[-262144:]
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

    def family(self):
        return json.loads((root / 'leaf-families' / (self.id + '.json')).read_text(encoding='utf-8'))

    def leaf(self, name):
        """Ask this session for a leaf and wait until it is a live session of its own."""
        self.submit('/leaf new ' + name)
        def born():
            try:
                members = self.family()['members']
            except (OSError, ValueError, KeyError):
                return None
            return next((member for member in members if member.get('name') == name), None)
        member = wait(born, f'{name} member', [self], timeout=120)
        label_for[member['sessionId']] = f'Leaf {member["number"]}: {name} (of session {self.id})'
        wait(lambda: (root / 'gateway-sessions' / (member['sessionId'] + '.json')).exists(), f'{name} on the peer bus', [self], timeout=120)
        return member


def wait(predicate, label, terminals, timeout=45):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        for terminal in terminals:
            terminal.pump()
        outcome = predicate()
        if outcome:
            return outcome
        time.sleep(0.025)
    print(json.dumps(dict(timeout=label, requests=[text[:120] for text in requests[-6:]], alive=[t.proc.isalive() for t in terminals], labels=label_for, output=[stripped(t)[-1200:] for t in terminals])), flush=True)
    raise AssertionError('Timed out: ' + label)


def peer(session_id):
    """What a live session publishes about itself, read at the moment of sending."""
    directory = root / 'gateway-sessions'
    registration = json.loads((directory / (session_id + '.json')).read_text(encoding='utf-8'))
    return dict(id=session_id, registration=registration)


def send(sender, receiver, text):
    source, target = sender['registration'], receiver['registration']
    message = dict(id=str(uuid.uuid4()), fromSessionId=sender['id'], fromRuntimeId=source['peer']['runtimeId'], toSessionId=receiver['id'], summary='Cross-family leaf test', text=text, createdAt='2026-09-09T00:00:00.000Z')
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


def inbox(session_id):
    path = root / 'gateway-sessions' / (session_id + '.inbox')
    return json.loads(path.read_text(encoding='utf-8'))['records'] if path.exists() else []


def transcript(session_id):
    return '\n'.join(path.read_text(encoding='utf-8') for path in (root / 'projects').glob('*/' + session_id + '.jsonl'))


try:
    (root / '.claude.json').write_text(json.dumps(dict(theme='dark', hasCompletedOnboarding=True, projects={root.as_posix(): dict(hasTrustDialogAccepted=True, hasCompletedProjectOnboarding=True)})), encoding='utf-8')
    (root / 'fixture.txt').write_text('Local cross-family fixture.', encoding='utf-8')
    first = Terminal()
    wait(lambda: 'session:' in stripped(first) and 'for shortcuts' in stripped(first), 'first prompt', [first])
    second = Terminal()
    terminals = [first, second]
    wait(lambda: 'session:' in stripped(second) and 'for shortcuts' in stripped(second), 'second prompt', terminals)
    alpha = first.leaf('Alpha')
    beta = second.leaf('Beta')
    # Each leaf is a live session on the shared bus under the name of the family
    # it belongs to, so the other family can see it without knowing where it came
    # from. Without this a leaf would only be reachable from its own family.
    assert peer(alpha['sessionId'])['registration']['peer']['name'] == label_for[alpha['sessionId']], 'A leaf must advertise the family it belongs to'
    # And the other family sees it: a listing run in family A names family B's
    # leaf, which is how one family finds the other's member at all.
    first.submit('/sessions list')
    wait(lambda: 'Beta (of session' in stripped(first), 'the other family\'s leaf in a listing', terminals, timeout=60)

    # Family B's leaf reaches family A's leaf by address. The message asks for an
    # answer, which the model sends as a peer message of its own.
    request_id = send(peer(alpha['sessionId']), peer(beta['sessionId']), 'SEND_LEAF_REPLY_TO=' + alpha['sessionId'] + '\nAnswer the other family\'s leaf.')
    wait(lambda: any('SEND_LEAF_REPLY_TO=' in text for text in requests), 'leaf model turn', terminals, timeout=120)
    wait(lambda: any(reply_nonce in record['message']['text'] and record['state'] == 'delivered' for record in inbox(alpha['sessionId'])), 'reply delivered to the other family\'s leaf', terminals, timeout=120)
    # ...and only there. A reply that also landed in either root session would
    # mean the address was a fan-out, not a one-to-one route.
    assert not any(reply_nonce in record['message']['text'] for record in inbox(first.id)), 'reply reached the sending family\'s root'
    assert not any(reply_nonce in record['message']['text'] for record in inbox(second.id)), 'reply reached the receiving family\'s root'
    assert not any(reply_nonce in record['message']['text'] for record in inbox(beta['sessionId'])), 'reply was delivered back to its own sender'

    # The receiving leaf woke up and took it: a leaf nobody is watching is
    # paused, so a message that only queued would sit there until a person
    # looked at the family - which is the failure this pins.
    wait(lambda: reply_nonce in transcript(alpha['sessionId']), 'reply in the receiving transcript', terminals, timeout=120)
    print(json.dumps(dict(alpha=alpha['sessionId'], beta=beta['sessionId'], reply=reply_nonce, deliveredToLeaf=True, oneToOne=True, modelTurns=len(requests))), flush=True)
finally:
    for proc in processes:
        if proc.isalive():
            proc.close(force=True)
    server.shutdown()
    server.server_close()
    shutil.rmtree(root, ignore_errors=True)
