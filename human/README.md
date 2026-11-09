# Gateway, for humans

Gateway runs in a terminal and works on the folder you start it in. You
describe what you want; it reads the files, edits them, runs commands, and
shows you what changed before it writes. It signs in to claude, chatgpt/codex,
opencode, commandcode, mistral and deepseek with accounts you supply.

A session can also split. It can fork itself into a leaf that works in parallel
and checks its reasoning, or open a fresh leaf on a stronger model for a second
opinion - the family keeps each other honest, which is most of the point.

## Installing

Everything is at https://ahmedsajid.ca/gateway/. The page asks for one
password, `gateway!`, then offers the downloads. Each one carries its own
runtime, so there is nothing to install before it.

On Windows, run GatewaySetup.exe. SmartScreen will say "Windows protected your
PC" because the build is unsigned: choose More info, then Run anyway. On Linux
and macOS there is a one-line `curl` command on the page, or the .deb and .pkg
if you would rather.

Afterwards open a new terminal - PATH changes do not reach windows that were
already open - and run:

```
gateway
```

## First run

Sign in from inside the session. `/login` covers claude and chatgpt/codex;
`/opencodelogin`, `/mistrallogin`, `/commandcodelogin` and `/deepseeklogin`
take provider keys.

Each login is saved under a numbered name like `claude1` or `opencode1`, so you
can keep several accounts and switch between them without signing out.

## Checking an install

```
gateway login --status
```

On a healthy install it reports `"mode": "bundled"`. That is also the cheapest
proof the runtime came along with the download.

## Your files

Program files live in the folder you installed into. Settings and sessions are
in `~/.claude`, which is the only place they have ever been. Keys are kept
separately, in the install's own keysafe folder, so two installs never share
credentials by accident. Uninstalling leaves your settings, sessions and keys
alone - reinstalling keeps your accounts.

Day to day use - models, leaves, questions, and what to do when nothing starts
- is in [using.md](using.md).
