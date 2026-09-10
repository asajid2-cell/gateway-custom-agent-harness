import argparse
import hashlib
import json
import os
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import time
import traceback
from pathlib import Path

try:
    import pyte
except ImportError as error:
    pyte = None
    PYTE_IMPORT_ERROR = error
else:
    PYTE_IMPORT_ERROR = None

from winpty import PtyProcess

ROOT = Path(__file__).resolve().parent.parent
ANSI = re.compile(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))')
SECRET = re.compile(r'(?i)(authorization|api[_ -]?key|token|secret|password)\s*[:=]\s*[^\s,]+')


def parse_args():
    parser = argparse.ArgumentParser(description='Run the real Gateway leaf-terminal acceptance.')
    parser.add_argument('--run', action='store_true', help='allow creation of a temporary terminal and child process')
    return parser.parse_args()


def sanitize(text):
    # Ink uses CUF to position adjacent cells. Preserve its column before
    # discarding ANSI controls so screen labels do not collapse in evidence.
    return SECRET.sub(r'\1=[REDACTED]', ANSI.sub('', text.replace('\x1b[1C', ' ')))


def verify_sanitize():
    assert sanitize('Leaf\x1b[1Cworkspace') == 'Leaf workspace'
    assert sanitize('\x1b[31mvisible\x1b[0m') == 'visible'


class TerminalScreen:
    """Incrementally reconstruct the authoritative current VT viewport."""

    def __init__(self, columns, rows):
        if pyte is None:
            raise RuntimeError(f'pyte terminal emulation is unavailable: {PYTE_IMPORT_ERROR}')

        class ObserverScreen(pyte.Screen):
            def report_device_status(self, mode, **kwargs):
                if kwargs.get('private') is True:
                    if mode == 6:
                        # Private DSR 6 reports cursor position. The PTY owns
                        # the response; this passive observer must not send a duplicate.
                        return
                    raise RuntimeError(f'Unsupported private DSR mode: {mode}')
                return super().report_device_status(mode, **kwargs)

        self.columns = columns
        self.rows = rows
        self.screen = ObserverScreen(columns, rows)
        self.stream = pyte.Stream(self.screen)
        self.observer_screen_type = ObserverScreen

    def verify_dsr_observer(self):
        before = self.rendered()
        self.feed('\x1b[?6')
        self.feed('n')
        assert self.rendered() == before
        self.feed('\x1b[6n')
        assert self.rendered() == before
        self.feed('\x1b[2;3H')
        self.feed('cursor')
        assert 'cursor' in self.rendered()

    def feed(self, raw):
        self.stream.feed(raw)

    def resize(self, columns, rows):
        self.columns = columns
        self.rows = rows
        self.screen.resize(lines=rows, columns=columns)

    def rendered(self):
        return '\n'.join(self.screen.display)


def normalized_screen(screen):
    return ' '.join(screen.replace('\u00a0', ' ').split())


def verify_terminal_screen():
    screen = TerminalScreen(40, 4)
    screen.feed('observer')
    screen.verify_dsr_observer()
    # A previous leaf frame must disappear after erase+home. The root footer is
    # deliberately split across cursor-addressed incremental chunks.
    screen.feed('\x1b[2J\x1b[HLeaf workspace\r\nUNSENT_DRAFT_1')
    assert 'Leaf workspace' in normalized_screen(screen.rendered())
    screen.feed('\x1b[2J\x1b[H\u276f \r\ncwd: C:/tmp\r\nsession: cc --resume root\r\n? for shortcuts\r\nLeav')
    screen.feed('es')
    rendered = normalized_screen(screen.rendered())
    assert 'Leaf workspace' not in rendered
    assert all(item in rendered for item in ('cwd:', 'session:', '--resume', '? for shortcuts', 'Leaves'))


def draft_metadata(members):
    metadata = []
    for member in members:
        draft = member.get('draft')
        if draft is None:
            metadata.append({'number': member['number'], 'present': False, 'type': 'missing', 'length': None, 'sha256': None})
        elif isinstance(draft, str):
            metadata.append({'number': member['number'], 'present': True, 'type': 'string', 'length': len(draft), 'sha256': hashlib.sha256(draft.encode('utf-8')).hexdigest()})
        else:
            metadata.append({'number': member['number'], 'present': True, 'type': type(draft).__name__, 'length': None, 'sha256': None})
    return metadata


def verify_draft_metadata():
    assert draft_metadata([{'number': 1}]) == [{'number': 1, 'present': False, 'type': 'missing', 'length': None, 'sha256': None}]
    assert draft_metadata([{'number': 1, 'draft': ''}]) == [{'number': 1, 'present': True, 'type': 'string', 'length': 0, 'sha256': hashlib.sha256(b'').hexdigest()}]
    assert draft_metadata([{'number': 1, 'draft': 'changed'}])[0]['sha256'] != draft_metadata([{'number': 1, 'draft': 'original'}])[0]['sha256']


def verify_saved_family(saved_family, creation_family):
    assert [member['sessionId'] for member in saved_family['members']] == [member['sessionId'] for member in creation_family['members']]
    assert [member.get('draft') for member in saved_family['members'][:5]] == [f"UNSENT_DRAFT_{member['number']}" for member in saved_family['members'][:5]]
    assert saved_family['members'][5].get('draft') == ''


def verify_saved_family_boundaries():
    creation = {'members': [
        {'sessionId': f'session-{number}', 'number': number}
        for number in range(1, 7)
    ]}
    saved = {'members': [
        {'sessionId': f'session-{number}', 'number': number, 'draft': f'UNSENT_DRAFT_{number}' if number < 6 else ''}
        for number in range(1, 7)
    ]}
    verify_saved_family(saved, creation)
    for number in range(1, 6):
        changed = {'members': [dict(member) for member in saved['members']]}
        changed['members'][number - 1]['draft'] = ''
        try:
            verify_saved_family(changed, creation)
        except AssertionError:
            pass
        else:
            raise AssertionError(f'accepted lost draft for member {number}')
        changed = {'members': [dict(member) for member in saved['members']]}
        changed['members'][number - 1]['draft'] = f'CHANGED_{number}'
        try:
            verify_saved_family(changed, creation)
        except AssertionError:
            pass
        else:
            raise AssertionError(f'accepted changed draft for member {number}')
    for nested_draft in (None, 'UNSENT_DRAFT_6'):
        changed = {'members': [dict(member) for member in saved['members']]}
        changed['members'][5].pop('draft', None) if nested_draft is None else changed['members'][5].update(draft=nested_draft)
        try:
            verify_saved_family(changed, creation)
        except AssertionError:
            pass
        else:
            raise AssertionError('accepted invalid nested draft')


def main():
    args = parse_args()
    candidate_text = os.environ.get('GATEWAY_ACCEPTANCE_CANDIDATE')
    if not args.run:
        raise SystemExit('Refusing to run: pass --run after setting GATEWAY_ACCEPTANCE_CANDIDATE.')
    if not candidate_text:
        raise SystemExit('GATEWAY_ACCEPTANCE_CANDIDATE is required.')
    candidate = Path(candidate_text).expanduser().resolve()
    if not candidate.is_file():
        raise SystemExit(f'GATEWAY_ACCEPTANCE_CANDIDATE is not an existing artifact: {candidate}')

    config = Path(tempfile.mkdtemp(prefix='gateway-real-terminal-'))
    # Keep only sanitized evidence after the run; session/config files can contain provider data.
    evidence = Path(tempfile.mkdtemp(prefix='gateway-terminal-evidence-'))
    print(f'EVIDENCE_DIRECTORY={evidence}', flush=True)
    events = []
    proc = None
    chunks = queue.Queue()
    raw_output = ''
    terminal = None

    def record(event, **details):
        events.append({'time': time.time(), 'event': event, **details})
        (evidence / 'terminal-events.json').write_text(json.dumps(events, indent=2), encoding='utf-8')

    def write_terminal_snapshot(name):
        # Historical stream evidence is diagnostic only; assertions inspect the
        # reconstructed current viewport below.
        historical = sanitize(raw_output)[-300000:]
        current = terminal.rendered() if terminal is not None else ''
        (evidence / name).write_text(
            'CURRENT_RENDERED_SCREEN\n' + current + '\n\nHISTORICAL_SANITIZED_STREAM\n' + historical,
            encoding='utf-8',
        )

    def start(columns, extra=()):
        nonlocal proc, chunks, terminal
        env = dict(os.environ)
        env.update(
            CLAUDE_CONFIG_DIR=str(config),
            CC_CLAUDE_SCRIPT_OVERRIDE=str(candidate),
            MODEL_GATEWAY_DEFAULT='gateway-gpt-luna',
            MODEL_GATEWAY_EFFORT='low',
            CLAUDE_CODE_NO_FLICKER='0',
        )
        env.pop('CC_RAW_ARGS', None)
        proc = PtyProcess.spawn(
            ['powershell.exe', '-NoProfile', '-File', str(ROOT / 'scripts/cc.ps1'), '--model', 'gateway-gpt-luna', *extra],
            cwd=str(config), env=env, dimensions=(32, columns),
        )
        chunks = queue.Queue()
        terminal = TerminalScreen(columns, 32)
        record('spawn', pid=getattr(proc, 'pid', None), columns=columns)

        def reader(owned_proc, owned_chunks):
            try:
                while True:
                    owned_chunks.put(owned_proc.read(4096))
            except EOFError:
                owned_chunks.put(None)

        threading.Thread(target=reader, args=(proc, chunks), daemon=True).start()

    def consume(part):
        nonlocal raw_output
        raw_output = (raw_output + part)[-300000:]
        terminal.feed(part)

    def drain():
        while True:
            try:
                part = chunks.get_nowait()
            except queue.Empty:
                return
            if part is None:
                return
            consume(part)

    def reset_output():
        # Retained for action attribution only. It never clears the VT state:
        # screen clearing and cursor movements are part of the raw stream.
        drain()

    def wait_for(label, required, timeout=90, absent=()):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            visible = normalized_screen(terminal.rendered())
            if all(item in visible for item in required) and not any(item in visible for item in absent):
                print(f'{label}=PASS', flush=True)
                record(label, required=required, absent=absent)
                return
            try:
                part = chunks.get(timeout=0.25)
            except queue.Empty:
                continue
            if part is None:
                raise RuntimeError('Terminal exited while waiting for ' + label)
            consume(part)
        write_terminal_snapshot('timeout-screen.txt')
        raise RuntimeError('Timeout at ' + label)

    def wait_any(label, choices, timeout=90):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            visible = normalized_screen(terminal.rendered())
            for choice in choices:
                if choice in visible:
                    print(f'{label}={choice}', flush=True)
                    record(label, choice=choice)
                    return choice
            try:
                part = chunks.get(timeout=0.25)
            except queue.Empty:
                continue
            if part is None:
                raise RuntimeError('Terminal exited while waiting for ' + label)
            consume(part)
        write_terminal_snapshot('timeout-screen.txt')
        raise RuntimeError('Timeout at ' + label)

    def wait_assistant(marker, timeout=90):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            for path in config.glob('projects/**/*.jsonl'):
                for line in path.read_text(encoding='utf-8').splitlines():
                    try:
                        record_json = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if record_json.get('type') == 'assistant' and marker in json.dumps(record_json.get('message', {})):
                        print('ASSISTANT_' + marker + '=PASS', flush=True)
                        record('assistant', marker=marker)
                        return
            time.sleep(0.2)
        raise RuntimeError('Assistant response timeout')

    def send(text):
        proc.write(text)
        time.sleep(0.2)
        proc.write('\r')

    def resize(rows, columns):
        proc.setwinsize(rows, columns)
        terminal.resize(columns, rows)

    def assert_root_prompt(width):
        # The cursor alone also occurs in onboarding selectors. Require the
        # current root viewport's prompt, cwd, resumable session, and footer.
        resize(28, width)
        wait_for(
            f'ROOT_PROMPT_READY_{width}',
            ['❯', 'cwd:', 'session:', '--resume', '? for shortcuts', 'Leaves'],
            absent=['Leaf workspace'],
        )

    def assert_leaf_panel(width, label):
        resize(28, width)
        wait_for(label, ['Leaf workspace', 'Tab/Shift+Tab:', 'Original; Esc: Original'])

    def return_to_root(label, timeout=90):
        proc.write('\x1b')
        wait_for(label, ['❯', 'cwd:', 'session:', '--resume', '? for shortcuts', 'Leaves'], timeout, absent=['Leaf workspace'])

    def complete_onboarding():
        # Theme selection is distinct from the ready prompt: its selector uses
        # the same cursor glyph. Advance only after its explicit heading.
        initial = wait_any('INITIAL_SCREEN', [
            'trust this folder', 'trust the files', 'Yes, I trust',
            'Select the text style', 'Choose the text style',
        ])
        if 'style' in initial:
            send('')
            reset_output()
            initial = wait_any('AFTER_THEME', ['Security notes:', 'Yes, I trust', 'terminal setup', 'Shift+Enter'])
        if initial == 'Security notes:':
            send('')
            reset_output()
            initial = wait_any('AFTER_SECURITY', ['Yes, I trust', 'terminal setup', 'Shift+Enter'])
        if initial in ['terminal setup', 'Shift+Enter']:
            proc.write('\x1b')
            reset_output()
            initial = wait_any('AFTER_SETUP', ['Yes, I trust'])
        if 'trust' in initial:
            wait_for('TRUST_READY', ['Yes, I trust this folder'])
            send('')
        return initial

    def shutdown():
        if proc is None or not proc.isalive():
            return
        pid = getattr(proc, 'pid', None)
        for _ in range(2):
            proc.write('\x03')
            time.sleep(0.25)
        deadline = time.monotonic() + 10
        while proc.isalive() and time.monotonic() < deadline:
            time.sleep(0.2)
        if proc.isalive() and isinstance(pid, int) and pid > 0:
            record('force_cleanup', pid=pid)
            # Only the PTY process we started and its descendants are targeted.
            subprocess.run(['taskkill.exe', '/PID', str(pid), '/T', '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=False)
            deadline = time.monotonic() + 5
            while proc.isalive() and time.monotonic() < deadline:
                time.sleep(0.1)
        if proc.isalive():
            raise RuntimeError('Owned terminal process did not exit')

    try:
        verify_sanitize()
        verify_terminal_screen()
        verify_draft_metadata()
        verify_saved_family_boundaries()
        print('TERMINAL_SCREEN_RECONSTRUCTION=PASS', flush=True)
        print('DRAFT_METADATA_SELFCHECK=PASS', flush=True)
        print('SAVED_FAMILY_BOUNDARY_SELFCHECK=PASS', flush=True)
        print('DRAFT_METADATA_SELFCHECK=PASS', flush=True)
        record('DRAFT_METADATA_SELFCHECK', status='PASS')
        start(120)
        complete_onboarding()
        assert_root_prompt(120)
        send('Reply exactly TERMINAL_ROOT_READY. Do not use tools.')
        wait_assistant('TERMINAL_ROOT_READY')

        reset_output()
        send('/leaf new Terminal acceptance')
        assert_leaf_panel(90, 'LEAF_PANEL_90')
        send('Reply exactly TERMINAL_LEAF_READY. Do not use tools.')
        wait_assistant('TERMINAL_LEAF_READY')
        return_to_root('FIRST_LEAF_RETURN_ROOT')
        for number in range(2, 6):
            reset_output()
            send('/leaf new Terminal ' + str(number))
            assert_leaf_panel(90, 'CREATE_LEAF_' + str(number))
            return_to_root('CREATE_LEAF_' + str(number) + '_RETURN_ROOT')

        family_files = list(config.glob('leaf-families/*.json'))
        assert len(family_files) == 1
        family_path = family_files[0]
        family = json.loads(family_path.read_text(encoding='utf-8'))
        assert len(family['members']) == 5
        reset_output()
        send('/leaf list')
        assert_leaf_panel(90, 'FIVE_LEAF_PANEL')
        time.sleep(0.5)
        for number in range(1, 6):
            reset_output()
            proc.write('UNSENT_DRAFT_' + str(number))
            time.sleep(0.2)
            proc.write('\t')
            wait_for('DRAFT_' + str(number) + '_PERSISTED', ['UNSENT_DRAFT_' + str(number)])
        return_to_root('FIVE_DRAFTS_RETURN_ROOT')
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            family = json.loads(family_path.read_text(encoding='utf-8'))
            if all(member.get('draft') == 'UNSENT_DRAFT_' + str(member['number']) for member in family['members']):
                break
            time.sleep(0.1)
        else:
            record('DRAFT_METADATA', phase='five_draft_failure', members=draft_metadata(family['members']))
            record('DRAFT_ASSIGNMENT', matches=[{'number': member['number'], 'matches': [n for n in range(1, 6) if member.get('draft') == 'UNSENT_DRAFT_' + str(n)]} for member in family['members']])
            raise RuntimeError('Distinct leaf drafts not persisted')
        first = family['members'][0]
        reset_output()
        send('/leaf fork ' + first['sessionId'] + ' Nested terminal')
        assert_leaf_panel(90, 'NESTED_PANEL')
        family = json.loads(family_path.read_text(encoding='utf-8'))
        assert len(family['members']) == 6
        assert family['members'][-1]['parentSessionId'] == first['sessionId']
        record('DRAFT_METADATA', phase='after_nested_creation', members=draft_metadata(family['members']))
        return_to_root('NESTED_RETURN_ROOT')
        saved_family = json.loads(family_path.read_text(encoding='utf-8'))
        record('DRAFT_METADATA', phase='after_nested_return_root', members=draft_metadata(saved_family['members']))
        verify_saved_family(saved_family, family)
        family = saved_family
        send('Reply exactly ORIGINAL_AFTER_LEAVES. Do not use tools.')

        wait_assistant('ORIGINAL_AFTER_LEAVES')
        print('REAL_TERMINAL_FIVE_DRAFTS_NESTED_RETURN=PASS', flush=True)

        shutdown()
        start(90, ('--resume', family['rootSessionId']))
        assert_root_prompt(90)
        reset_output()  # Attribute the first restored draft to this panel render.
        send('/leaf list')
        assert_leaf_panel(90, 'RESTORED_WORKSPACE')
        wait_for('RESTORED_FIRST_DRAFT', ['UNSENT_DRAFT_1'])
        reset_output()  # Attribute the next draft to this Tab action.
        proc.write('\t')
        wait_for('RESTORED_SECOND_DRAFT', ['UNSENT_DRAFT_2'])
        restored = json.loads(family_path.read_text(encoding='utf-8'))
        record('DRAFT_METADATA', phase='before_restart_equality_old_snapshot', members=draft_metadata(family['members']))
        record('DRAFT_METADATA', phase='after_restart_restored', members=draft_metadata(restored['members']))
        assert [m['sessionId'] for m in restored['members']] == [m['sessionId'] for m in family['members']]
        assert [m.get('draft') for m in restored['members']] == [m.get('draft') for m in family['members']]
        print('REAL_TERMINAL_RESTART_IDENTITIES_DRAFTS=PASS', flush=True)
    except Exception as error:
        frames = [
            {
                'file': Path(frame.filename).name,
                'line': frame.lineno,
                'function': frame.name,
            }
            for frame in traceback.extract_tb(error.__traceback__)
        ]
        record('failure', error_type=type(error).__name__, traceback=frames)
        write_terminal_snapshot('failure-screen.txt')
        print('FAILURE_FRAMES=' + json.dumps(frames, separators=(',', ':')), flush=True)

        print('REAL_TERMINAL_LEAF_SMOKE=FAIL type=' + type(error).__name__, flush=True)
        for label in ['Welcome', 'login', 'API Error', 'trust', 'Leaf workspace', 'error', 'theme']:
            visible = normalized_screen(terminal.rendered()) if terminal is not None else ''
            print('SCREEN_' + label.replace(' ', '_') + '=' + str(label in visible), flush=True)
        return 1
    finally:
        shutdown()
        record('complete')
        shutil.rmtree(config, ignore_errors=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
