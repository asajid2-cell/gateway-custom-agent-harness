"""Windows ConPTY smoke test for the interactive CLI (dist/cli.js).

Drives the real TUI through a pseudo-terminal so keystrokes arrive the way a
console delivers them, then reports a pass/fail matrix for the input, resize
and shutdown paths that unit tests cannot reach.

Usage:
    python scripts/tui-conpty-smoke.py
    python scripts/tui-conpty-smoke.py --cli dist/cli.js --json
    python scripts/tui-conpty-smoke.py --keep   # keep the captured transcript

Environment:
    Requires Windows and pywinpty (`pip install pywinpty`). No secrets are
    typed and the CLI runs against a throwaway config directory, so this is
    safe to run on a development machine.

ConPTY CAVEAT — do not read a delayed first paint as a product fault.
    ConPTY is a dumb terminal: it answers neither the primary device-attribute
    request (ESC[c) nor the cursor-position report (ESC[?6n / ESC[6n) that the
    renderer uses to measure the terminal. Until the client sends its first
    key, the welcome screen can therefore stay blank for ~5 s while those
    queries time out. Windows Terminal answers them in milliseconds. The
    harness injects one neutral key after startup and only then judges the
    first screen.

Known expected failure (2026-11-04, release/windows @ bc90d80):
    Double Ctrl-C on the login dialog emits the full terminal-teardown
    sequence (mouse/kitty/focus/paste off, cursor shown) but the process does
    not exit. The harness reports this as FAIL on purpose; the fix belongs to
    the main line, not this branch.
"""

import argparse
import json
import os
import re
import sys
import tempfile
import threading
import time
import uuid

# `[^\x07\x1b]` matters: the element-map OSC payloads can arrive split across
# reads, and a greedy `[^\x07]*` would swallow every later screen byte while
# waiting for a terminator that already went past.
ANSI_RE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-_])")

DOUBLE_PRESS_TIMEOUT_MS = 800


def require_winpty():
    if sys.platform != "win32":
        raise SystemExit("tui-conpty-smoke: Windows only (ConPTY)")
    try:
        from winpty.enums import Backend
        from winpty.ptyprocess import PtyProcess
    except ImportError as error:
        raise SystemExit(
            f"tui-conpty-smoke: pywinpty is required ({error}); run: pip install pywinpty"
        )
    return PtyProcess, Backend


def plain(text):
    return ANSI_RE.sub("", text).replace("\r", "")


def compact(text):
    return re.sub(r"\s+", "", plain(text))


def widest_divider(text):
    runs = [len(match) for match in re.findall("\u254c+", plain(text))]
    return max(runs) if runs else 0


class Session:
    def __init__(self, PtyProcess, Backend, argv, cwd, config_dir, rows=32, cols=120):
        self.chunks = []
        self.lock = threading.Lock()
        self.started = time.monotonic()
        env = os.environ.copy()
        env.update(
            {
                "CLAUDE_CONFIG_DIR": config_dir,
                "USERPROFILE": os.path.dirname(config_dir),
                "HOME": os.path.dirname(config_dir),
                "TERM": "xterm-256color",
                "GATEWAY_CREDENTIALS_MODE": "bundled",
            }
        )
        for name in (
            "WT_SESSION",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
        ):
            env.pop(name, None)
        self.child = PtyProcess.spawn(
            argv,
            cwd=cwd,
            env=env,
            dimensions=(rows, cols),
            backend=Backend.ConPTY,
        )
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        while True:
            try:
                chunk = self.child.read(65536)
            except EOFError:
                return
            except Exception:
                return
            if not chunk:
                if not self.child.isalive():
                    return
                continue
            with self.lock:
                self.chunks.append((time.monotonic(), chunk))

    def output(self, since=0.0):
        with self.lock:
            return "".join(chunk for at, chunk in self.chunks if at >= since)

    def elapsed(self):
        return time.monotonic() - self.started

    def wait_until(self, predicate, timeout, label):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            if not self.child.isalive():
                return predicate()
            time.sleep(0.05)
        return predicate()

    def write(self, data):
        self.child.write(data)

    def resize(self, rows, cols):
        self.child.setwinsize(rows, cols)


def run(cli, keep, as_json=False):
    PtyProcess, Backend = require_winpty()
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    cli_path = cli if os.path.isabs(cli) else os.path.join(root, cli)
    if not os.path.exists(cli_path):
        raise SystemExit(f"tui-conpty-smoke: missing {cli_path}; run `bun run build` first")

    config_root = tempfile.mkdtemp(prefix="tui-conpty-smoke-")
    config_dir = os.path.join(config_root, ".claude")
    os.makedirs(config_dir, exist_ok=True)
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")

    results = []

    def record(item, status, evidence):
        results.append({"item": item, "status": status, "evidence": evidence})

    session = Session(PtyProcess, Backend, ["bun", cli_path], root, config_dir)
    try:
        first_output = session.wait_until(lambda: bool(session.output()), 30, "first output")
        if not first_output:
            record("tui starts under ConPTY", "FAIL", "no output within 30s")
            return finish(results, config_root, keep, session, as_json)

        # ConPTY never answers the DA/CPR probes, so the first paint waits for
        # the query timeouts (~5 s measured). Do NOT inject a key first: input
        # during the probe window delays the paint instead of unblocking it.
        def painted_screen():
            screen = compact(session.output())
            return any(
                marker in screen
                for marker in (
                    "Choosethetextstyle",
                    "WelcometoClaudeCode",
                    "Letsgetstarted",
                    "Securitynotes",
                )
            )

        painted = session.wait_until(painted_screen, 25, "onboarding paint")
        screen_tail = compact(session.output())[-90:]
        record("tui starts under ConPTY", "PASS" if painted else "FAIL",
               f"painted after {session.elapsed():.1f}s, {len(session.output())} bytes; "
               f"tail=...{screen_tail}")

        # --- resize: the divider is drawn full-width, so it measures the reflow
        for cols in (60, 140):
            before = len(session.output())
            session.resize(32, cols)
            time.sleep(0.5)
            resize_only = len(session.output()) - before
            session.write("\x1b[B")
            time.sleep(1.0)
            divider = widest_divider(session.output()[before:])
            ok = divider and abs(divider - (cols - 4)) <= 6
            record(
                f"resize to {cols} cols reflows",
                "PASS" if ok else "FAIL",
                f"resize-only {resize_only} bytes, widest divider {divider} "
                f"(expected {cols - 4})",
            )
            if not session.child.isalive():
                record("still alive after resize", "FAIL", "process exited during resize")
                return finish(results, config_root, keep, session, as_json)

        # --- keys: every one must be accepted without killing the process.
        # Enter is deliberately last: it opens the login dialog, and Esc would
        # dismiss it before the Ctrl-C test can run there.
        for label, data, wait in (
            ("arrow down", "\x1b[B", 0.5),
            ("arrow up", "\x1b[A", 0.5),
            ("shift+tab", "\x1b[Z", 0.8),
            ("alt+v", "\x1bv", 0.8),
            ("bracketed paste", "\x1b[200~paste-probe\x1b[201~", 0.8),
            ("Ctrl-U", "\x15", 0.5),
            ("Enter", "\r", 1.2),
        ):
            since = time.monotonic()
            session.write(data)
            time.sleep(wait)
            back = len(session.output(since))
            alive = session.child.isalive()
            record(f"key: {label}", "PASS" if alive else "FAIL",
                   f"accepted, {back} bytes back" if alive else "process died on this key")
            if not alive:
                break

        whole = session.output()
        record("bracketed paste enabled", "PASS" if "\x1b[?2004h" in whole else "FAIL",
               "ESC[?2004h sent" if "\x1b[?2004h" in whole else "not sent")
        record("cursor hidden while drawing", "PASS" if "\x1b[?25l" in whole else "FAIL",
               "ESC[?25l sent" if "\x1b[?25l" in whole else "not sent")

        # --- Ctrl-C: one press asks, a second press must terminate the process
        # Make sure the login dialog is on screen; that is where the
        # double-press exit handler is exercised. Reaching it can take one or
        # two Enters (theme pick -> security notice -> login prompt).
        def on_login_screen():
            screen = compact(session.output())
            return "Securitynotes" in screen or "Login" in plain(session.output())

        for _ in range(2):
            if on_login_screen():
                break
            session.write("\r")
            session.wait_until(on_login_screen, 6, "login dialog")
        on_login = on_login_screen()
        record("Ctrl-C test context", "PASS" if on_login else "PARTIAL",
               "login dialog" if on_login else "login dialog not reached; testing the current screen")
        if session.child.isalive():
            # Press 1: poll long enough to see the confirmation text (the frame
            # throttle can delay it past 0.6 s), then let the 800 ms window
            # expire so the next pair is unambiguous.
            since = time.monotonic()
            session.write("\x03")
            deadline = time.monotonic() + 1.5
            pending = False
            # The renderer separates words with cursor-forward sequences, so
            # after stripping ANSI the phrase is "PressCtrl-Cagaintoexit".
            while time.monotonic() < deadline:
                if "againtoexit" in compact(session.output(since)):
                    pending = True
                    break
                time.sleep(0.03)
            record("Ctrl-C once asks for confirmation",
                   "PASS" if pending and session.child.isalive() else "FAIL",
                   f"alive={session.child.isalive()}, pending message={pending} "
                   f"after {time.monotonic() - since:.2f}s")
            time.sleep(1.0)

            if session.child.isalive():
                # Presses 2 and 3, 150 ms apart: inside the window from each other.
                session.write("\x03")
                time.sleep(0.15)
                session.write("\x03")
                exited = session.wait_until(
                    lambda: not session.child.isalive(), 10, "exit after double Ctrl-C"
                )
                record(
                    "Ctrl-C twice exits",
                    "PASS" if exited else "FAIL",
                    "process exited" if exited else
                    f"still alive 10s after confirmation (known main-line blocker)",
                )
                tail = plain(session.output())[-400:]
                torn_down = "\x1b[?2004l" in session.output() and "\x1b[?25h" in session.output()
                record("terminal modes restored",
                       "PASS" if torn_down else "FAIL",
                       "teardown sequences observed" if torn_down else
                       f"no teardown seen; tail={tail[-120:]!r}")

        return finish(results, config_root, keep, session, as_json)
    finally:
        try:
            if session.child.isalive():
                session.child.terminate(force=True)
        except Exception:
            pass


def finish(results, config_root, keep, session, as_json=False):
    failed = sum(1 for r in results if r["status"] == "FAIL")
    if as_json:
        print(json.dumps({"pass": len(results) - failed, "fail": failed, "results": results}, indent=2))
    else:
        width = max((len(r["item"]) for r in results), default=8)
        for r in results:
            print(f"{r['item'].ljust(width)} | {r['status']:6} | {r['evidence']}")
        print(f"\n{len(results) - failed}/{len(results)} PASS, {failed} FAIL")
    if keep:
        path = os.path.join(config_root, "transcript.txt")
        with open(path, "w", encoding="utf-8", errors="replace") as handle:
            handle.write(session.output() if session else "")
        print(f"transcript: {path}", file=sys.stderr)
    return 1 if failed else 0


def main():
    parser = argparse.ArgumentParser(description="Windows ConPTY TUI smoke test")
    parser.add_argument("--cli", default=os.path.join("dist", "cli.js"))
    parser.add_argument("--json", action="store_true", help="print the matrix as JSON")
    parser.add_argument("--keep", action="store_true", help="keep the captured transcript")
    args = parser.parse_args()
    return run(args.cli, args.keep, args.json)


if __name__ == "__main__":
    code = main()
    sys.stdout.flush()
    os._exit(code)
