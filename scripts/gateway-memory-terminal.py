"""Local-only streamed-response memory replay through Windows ConPTY."""
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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from winpty import PtyProcess

parser = argparse.ArgumentParser()
parser.add_argument('cli', type=Path)
parser.add_argument('--turns', type=int, default=30)
parser.add_argument('--chunks', type=int, default=40)
args = parser.parse_args()
cli = args.cli.resolve()
assert cli.is_file()
root = Path(tempfile.mkdtemp(prefix='gateway-memory-terminal-'))
requests = 0
finished = threading.Event()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        global requests
        body = self.rfile.read(int(self.headers.get('Content-Length', '0'))).decode('utf-8')
        requests += 1
        matches = re.findall(r'Synthetic terminal memory fixture turn (\d+)', body)
        turn = int(matches[-1]) if matches else 0
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        def event(kind, **fields):
            self.wfile.write(('event: ' + kind + '\ndata: ' + json.dumps(dict(type=kind, **fields)) + '\n\n').encode())
            self.wfile.flush()
        try:
            event('message_start', message=dict(id=f'msg_{turn}', type='message', role='assistant', model='claude-sonnet-4-6', content=[], stop_reason=None, stop_sequence=None, usage=dict(input_tokens=100, output_tokens=0)))
            event('content_block_start', index=0, content_block=dict(type='text', text=''))
            for chunk in range(args.chunks):
                event('content_block_delta', index=0, delta=dict(type='text_delta', text=f'**Fixture {turn} chunk {chunk}**\n\n' + 'Synthetic memory output paragraph. ' * 30 + '\n\n'))
                time.sleep(0.01)
            event('content_block_delta', index=0, delta=dict(type='text_delta', text=f'\nTERMINAL_MEMORY_DONE_{turn}\n'))
            event('content_block_stop', index=0)
            event('message_delta', delta=dict(stop_reason='end_turn', stop_sequence=None), usage=dict(output_tokens=1000))
            event('message_stop')
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            finished.set()

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
proc = None
chunks = queue.Queue(maxsize=256)
try:
    (root / '.claude.json').write_text(json.dumps(dict(theme='dark', hasCompletedOnboarding=True, projects={root.as_posix(): dict(hasTrustDialogAccepted=True, hasCompletedProjectOnboarding=True)})), encoding='utf-8')
    env = {key: os.environ[key] for key in ('PATH', 'SystemRoot', 'TEMP', 'TMP', 'COMSPEC') if key in os.environ}
    url = f'http://127.0.0.1:{server.server_port}'
    if 'MEMORY_FULLSCREEN' in os.environ:
        env['CLAUDE_CODE_NO_FLICKER'] = os.environ['MEMORY_FULLSCREEN']
    env.update(HOME=str(root), USERPROFILE=str(root), CLAUDE_CONFIG_DIR=str(root), ANTHROPIC_AUTH_TOKEN='local-fixture-only', ANTHROPIC_BASE_URL=url, CLAUDE_CODE_GATEWAY_BASE_URL=url, CLAUDE_CODE_GATEWAY_TOKEN='local-fixture-only', CLAUDE_CODE_USE_GATEWAY='1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1', DISABLE_TELEMETRY='1', DISABLE_ERROR_REPORTING='1', GATEWAY_MEMORY_TELEMETRY_DIR=str(root / 'memory'), NODE_ENV=os.environ.get('MEMORY_NODE_ENV', 'production'))
    command = subprocess.list2cmdline([shutil.which('bun'), str(cli), '--model', 'claude-sonnet-4-6', '--tools', ''])
    proc = PtyProcess.spawn(command, cwd=str(root), env=env, dimensions=(40, 120))
    def drain():
        try:
            while proc.isalive():
                chunks.put(proc.read(65536))
        except (EOFError, OSError):
            pass
    threading.Thread(target=drain, daemon=True).start()
    def pump(seconds):
        deadline = time.monotonic() + seconds
        text = ''
        while time.monotonic() < deadline:
            try:
                text = (text + chunks.get(timeout=min(0.05, max(0.001, deadline-time.monotonic()))))[-65536:]
            except queue.Empty:
                pass
        return text
    def sample(turn):
        cmd = f'$p=Get-Process -Id {proc.pid}; [pscustomobject]@{{pid=$p.Id;privateBytes=$p.PrivateMemorySize64;workingSet=$p.WorkingSet64;handles=$p.HandleCount;cpu=$p.CPU}} | ConvertTo-Json -Compress'
        result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', cmd], capture_output=True, text=True, timeout=10, check=True)
        print(json.dumps(dict(turn=turn, requests=requests, **json.loads(result.stdout))), flush=True)
    startup = ''
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        startup = (startup + pump(0.2))[-65536:]
        if 'session:' in startup and 'Leaves' in startup:
            break
    else:
        raise RuntimeError('Fixture did not reach the interactive prompt')
    pump(1)
    sample(0)
    for turn in range(1, args.turns + 1):
        finished.clear()
        proc.write(f'\x1b[200~Synthetic terminal memory fixture turn {turn}.\x1b[201~')
        pump(1)
        proc.write('\r')
        deadline = time.monotonic() + 30
        seen = ''
        marker = f'TERMINAL_MEMORY_DONE_{turn}'
        while time.monotonic() < deadline:
            seen = (seen + pump(0.1))[-65536:]
            if finished.is_set() and marker in seen:
                break
        else:
            raise RuntimeError(f'Fixture turn {turn} did not finish; requests={requests}; process_alive={proc.isalive()}')
        pump(0.3)
        if turn % 5 == 0:
            sample(turn)
    proc.write('/exit')
    pump(0.8)
    proc.write('\r')
    pump(2)
    transcripts = list((root / 'projects').glob('*/*.jsonl'))
    assert transcripts, 'Replay must persist a transcript'
    persisted = '\n'.join(file.read_text(encoding='utf-8') for file in transcripts)
    for turn in range(1, args.turns + 1):
        assert f'TERMINAL_MEMORY_DONE_{turn}' in persisted, f'Transcript lost turn {turn}'
    print(json.dumps(dict(persistedTurns=args.turns, verified=True)), flush=True)
    telemetry_files = list((root / 'memory').glob('*.jsonl'))
    assert len(telemetry_files) == 1, 'Replay must capture memory telemetry'
    for file in telemetry_files:
        rows = [json.loads(line) for line in file.read_text(encoding='utf-8').splitlines()]
        assert rows[-1]['reason'] == 'shutdown', 'Replay must shut down gracefully'
        assert rows[-1]['activity']['replQueryEnds'] == args.turns
        if os.environ.get('MEMORY_MAX_SCREEN_MB'):
            assert rows[-1]['caches']['screenBufferBytes'] <= float(os.environ['MEMORY_MAX_SCREEN_MB']) * 1024 * 1024
        if os.environ.get('MEMORY_MAX_PRIVATE_MB'):
            assert rows[-1]['privateBytes'] <= float(os.environ['MEMORY_MAX_PRIVATE_MB']) * 1024 * 1024
        print(json.dumps(dict(telemetry=rows)), flush=True)
finally:
    if proc is not None and proc.isalive():
        proc.close(force=True)
    server.shutdown()
    server.server_close()
    shutil.rmtree(root, ignore_errors=True)
