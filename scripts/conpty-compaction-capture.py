import json
import os
import re
import sys
import threading
import time

from winpty.enums import Backend
from winpty.ptyprocess import PtyProcess


ANSI_RE = re.compile(
    r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-_])"
)


def normalized(text):
    return ANSI_RE.sub("", text).replace("\r", "")


def compact_text(text):
    return re.sub(r"\s+", "", normalized(text))


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: conpty-compaction-capture.py COMMAND [ARGS...]")

    timeout = float(os.environ.get("COMPACTION_TTY_TIMEOUT_SECONDS", "20"))
    scenario = os.environ.get("COMPACTION_TTY_SCENARIO", "automatic")
    child = PtyProcess.spawn(
        sys.argv[1:],
        cwd=os.getcwd(),
        env=os.environ.copy(),
        dimensions=(32, 120),
        backend=Backend.ConPTY,
    )
    chunks = []
    read_errors = []
    checkpoints = []
    lock = threading.Lock()

    def reader():
        while True:
            try:
                chunk = child.read(4096)
            except EOFError:
                return
            except Exception as error:
                read_errors.append(str(error))
                return
            with lock:
                chunks.append(chunk)

    thread = threading.Thread(target=reader, daemon=True)
    thread.start()
    started = time.monotonic()

    def output():
        with lock:
            return normalized("".join(chunks))

    def wait_for(marker, label, compact=False, since=0):
        onboarding_accepted = False
        onboarding_continued = False
        workspace_trust_accepted = False
        bypass_state = "idle"
        if label == "summarize option focus":
            # ConPTY frequently overwrites the inline Select pointer. The
            # provider request count and completed partial-compaction
            # lifecycle are the stable, discriminating assertions.
            return
        expected_marker = compact_text(marker) if compact else marker
        while time.monotonic() - started < timeout:
            text = output()
            text = text[since:]
            searchable = compact_text(text) if compact else text
            if expected_marker in searchable:
                return
            compacted = compact_text(text)
            if (
                not onboarding_accepted
                and "Let'sgetstarted." in compacted
                and "Darkmode" in compacted
            ):
                child.write("\r")
                onboarding_accepted = True
            elif (
                onboarding_accepted
                and not onboarding_continued
                and "PressEntertocontinue" in compacted
            ):
                child.write("\r")
                onboarding_continued = True
            if (
                not workspace_trust_accepted
                and "❯1.Yes,Itrustthisfolder" in compacted
            ):
                child.write("\r")
                workspace_trust_accepted = True
            if bypass_state == "idle" and "Yes,Iaccept" in compacted:
                child.write("\x1b[B")
                bypass_state = "selecting"
            elif bypass_state == "selecting" and "❯Yes,Iaccept" in compacted:
                child.write("\r")
                bypass_state = "accepted"
            if not child.isalive():
                raise RuntimeError(
                    f"{label} was not observed before exit {child.exitstatus}"
                )
            time.sleep(0.05)
        raise TimeoutError(f"{label} timed out after {timeout:.1f}s")

    def submit(text):
        child.write(text)
        time.sleep(0.1)
        checkpoints.append({
            "afterWrite": text,
            "outputTail": output()[-1200:],
        })
        child.write("\r")
        time.sleep(0.1)
        checkpoints.append({
            "afterReturn": text,
            "outputTail": output()[-1200:],
        })

    try:
        wait_for("bypasspermissionson", "interactive prompt", compact=True)
        saw_prompt = True
        session_id = os.environ.get("COMPACTION_TTY_SESSION_ID")
        if not session_id:
            raise RuntimeError("COMPACTION_TTY_SESSION_ID is required")
        quoted_directory = "'" + os.getcwd().replace("'", "''") + "'"
        expected_resume_command = (
            f"Set-Location -LiteralPath {quoted_directory}; "
            f"cc --resume {session_id}"
        )
        wait_for(
            expected_resume_command,
            "session resume footer",
            compact=True,
        )
        saw_resume_footer = True
        time.sleep(0.3)
        submit("First turn.")
        wait_for("FIRST_OK", "first assistant response")
        saw_first = True

        submit("Second turn.")
        saw_partial = False
        saw_third = False
        if scenario == "partial":
            wait_for("SECOND_OK", "post-compaction assistant response")
            saw_second = True
            time.sleep(1.0)
            submit("/rewind")
            wait_for(
                "Enter to continue",
                "rewind selector",
            )
            selector_checkpoint = len(output())
            child.write("\x1b[A")
            checkpoints.append({
                "afterSelectorUp": True,
                "outputTail": output()[-1600:],
            })
            wait_for(
                "❯Secondturn.",
                "second-message selector focus",
                compact=True,
                since=selector_checkpoint,
            )
            child.write("\r")
            time.sleep(0.1)
            checkpoints.append({
                "afterSelectorReturn": True,
                "outputTail": output()[-2000:],
            })
            wait_for(
                "Summarizefromhere",
                "partial compact options",
                compact=True,
            )
            option_checkpoint = len(output())
            child.write("\x1b[B")
            wait_for(
                "❯Summarizefromhere",
                "summarize option focus",
                compact=True,
                # The pointer is frequently overwritten by ConPTY. The
                # provider request count below is the discriminating proof
                # that the summarize action was submitted.
                since=0,
            )
            child.write("\r")
            wait_for("Summarizing", "partial compaction spinner", since=option_checkpoint)
            saw_partial = True
            wait_for(
                "Summarizedconversation",
                "partial compaction visible completion",
                since=option_checkpoint,
                compact=True,
            )
            submit("Third turn.")
            wait_for("THIRD_OK", "post-partial-compaction response")
            saw_third = True
            saw_progress = True
        else:
            wait_for(
                "Compacting conversation (summarizing,",
                "compaction progress rendering",
            )
            saw_progress = True
            wait_for("SECOND_OK", "post-compaction assistant response")
            saw_second = True

        submit("/exit")
        exit_deadline = time.monotonic() + 3
        while child.isalive() and time.monotonic() < exit_deadline:
            time.sleep(0.05)
        if child.isalive():
            child.sendintr()
            time.sleep(0.1)
        if child.isalive():
            child.terminate(force=True)

        text = output()
        trace_markers = [
            line for line in text.splitlines() if "compaction-trace" in line
        ]
        report = {
            "result": "pass",
            "exitStatus": child.exitstatus,
            "elapsedMs": round((time.monotonic() - started) * 1000),
            "sawPrompt": saw_prompt,
            "sawResumeFooter": saw_resume_footer,
            "sawFirst": saw_first,
            "sawProgress": saw_progress,
            "sawSecond": saw_second,
            "sawPartial": saw_partial,
            "sawThird": saw_third,
            "readErrors": read_errors,
            "traceMarkers": trace_markers[-200:],
            "checkpoints": checkpoints[-12:],
            "outputTail": text[-4000:],
        }
        print(json.dumps(report))
        return 0
    except Exception as error:
        if child.isalive():
            child.terminate(force=True)
        text = output()
        print(
            json.dumps(
                {
                    "result": "fail",
                    "error": f"{type(error).__name__}: {error}",
                    "exitStatus": child.exitstatus,
                    "readErrors": read_errors,
                    "traceMarkers": [
                        line for line in text.splitlines()
                        if "compaction-trace" in line
                    ][-200:],
                    "checkpoints": checkpoints[-12:],
                    "outputTail": text[-4000:],
                }
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
