# Gateway, for humans

Gateway is a coding agent that runs in a terminal. You describe a task; it
reads the folder you started it in, edits the files, runs commands, and shows
you what changed. It signs in to Claude, ChatGPT/Codex, OpenCode, CommandCode,
Mistral and DeepSeek with accounts you supply.

Sessions are not isolated. A session can split its context into *leaves* that
work in parallel and check each other, so a mistake or a derailment in one is
usually caught by another.

## Install

Everything is at https://ahmedsajid.ca/gateway/ — the page asks for a
username and password, then offers:

- **Windows**: `GatewaySetup.exe`. SmartScreen says "Windows protected your
  PC" because the build is unsigned: **More info**, then **Run anyway**.
- **Linux**: the one-line `curl ... | sh` command, or the `.deb`.
- **macOS**: the `.pkg`, or the same one-liner.

Every download carries its own runtime, so there is nothing to install first.

Open a **new** terminal afterwards and run:

```
gateway
```

## First run

Sign in from inside the session:

- `/login` — Claude or ChatGPT/Codex.
- `/opencodelogin`, `/mistrallogin`, `/commandcodelogin`, `/deepseeklogin` —
  provider API keys.

Each sign-in is saved under a numbered name (`claude1`, `opencode1`, ...), so
you can keep several accounts and switch between them.

To check an install without starting a session:

```
gateway login --status
```

It reports `"mode": "bundled"` on a healthy install.

## Where your things live

| What | Where |
|---|---|
| Program files | the folder you installed into |
| Settings and sessions | `~/.claude` (`%USERPROFILE%\.claude` on Windows) |
| Keys | the install's own keysafe folder |
| Launcher log | the install's `launcher.jsonl` |

Uninstalling removes the program files and PATH entry, and leaves your
settings, sessions and keys alone - reinstalling keeps your accounts.

## Next

[`using.md`](using.md) covers day-to-day use: sessions, models, leaves, and
what to do when something does not start.
