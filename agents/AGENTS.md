# AGENTS.md - rebuild, build, run, explain

This file is for an agent working with this repository. It says what the tree
is, how to reassemble it onto a Claude Code source snapshot, how to build and
run it, and where the explanations live.

Read this first, then `architecture.md` (what the parts are) and `internals.md`
(how they work).

## What this repository is

It is the **Gateway layer only** - 640 files the fork adds: the model gateway,
the session family and peer bus, the question rail, the vault, the release
tooling and their tests. It is not a complete program.

The Claude Code snapshot it is built on is **not** distributed here. Neither
are the fork's modified versions of upstream files: `upstream-touched.txt`
lists the **paths** (454 of them) that the fork edits, adds to, or deletes
upstream, and nothing else.

Treat this tree as an overlay. Copy it over a snapshot and you have the fork's
files; the wiring between them and the snapshot is what you have to restore.

## What you need

- A Claude Code source snapshot of the same generation the fork was taken
  from. Close is usually enough; API drift is what breaks.
- `bun` 1.4.x (the launchers and the build assume it), and `node` 20+ for the
  `.mjs` test scripts.
- Nothing else at build time.

Do not commit the snapshot into this repository, and do not publish the
snapshot from a fork of it.

## Reassemble

1. **Unpack the snapshot** into a working tree, e.g. `~/gw-build`.
2. **Overlay this repository** on top:

   ```
   rsync -a --exclude .git /path/to/this/repo/ ~/gw-build/
   ```

   Every path in this repo is a path the snapshot does not have, except
   `README.md`, so the copy only adds files.
3. **Restore the wiring.** Open `upstream-touched.txt`. Fourteen directories
   carry almost all of it:

   | Area | Files | What usually changes |
   |---|---|---|
   | `src/utils` | 133 | session storage, message origins, model routing, settings |
   | `src/components` | 116 | mount points for the new dialogs and the question rail |
   | `src/tools` | 42 | register the fork's tools (leaf, peers, snip, workflows) |
   | `src/services` | 34 | provider clients, compaction, quota |
   | `src/hooks` | 32 | input/render hooks the new UI attaches to |
   | `src/ink` | 21 | terminal element map, rendering |
   | `src/commands` | 21 | command table |
   | `src/cli` | 9 | CLI flags and handlers |
   | `src/entrypoints` | 5 | the startup path: tool registry, command list, app mount |
   | `src/migrations`, `src/keybindings`, `src/types`, `src/screens`, `src/constants` | 21 | storage migrations, keys, message types, screens |

   The compiler is the guide: build, read the first error, restore the wiring
   that makes it go away. Start from the entrypoint and the command table -
   most other errors are consequences.
4. **Add the asset loaders.** The fork inlines Markdown skill prompts and
   `.txt` permission/plan prompts at build time. If the snapshot's build script
   does not handle `.md` and `.txt` modules, add that - otherwise the bundle
   will not resolve `src/skills/bundled/**` or
   `src/utils/permissions/yolo-classifier-prompts/**`.
5. **Reconcile dependencies.** `package.json` and `bun.lock` are upstream files
   and are not published here. Take the snapshot's, run `bun install`, and add
   whatever the overlay imports that the snapshot does not have.

## Build and verify

```
bun install
bun run build            # bundles src/entrypoints/cli.tsx to dist/cli.js
bun ./dist/cli.js --version
bun ./dist/cli.js        # starts a session
```

The snapshot does not typecheck cleanly on its own (modules are missing or
stubbed). Compare against a baseline taken before your changes, not against
zero:

```
bun run typecheck 2>&1 | tail -5
```

Targeted tests that do not need the full app:

```
bun test scripts/question-rail.test.mjs
bun test scripts/leaf-family.test.ts scripts/leaf-merge.test.ts
bun test scripts/vault-obligations.test.ts scripts/vault-recall.test.ts
node --test scripts/model-gateway.test.mjs
```

## Run

```
scripts/cc            # Linux / macOS
scripts/cc.cmd        # Windows (resolves scripts/cc.ps1 next to it)
```

or `bun ./dist/cli.js`. The launchers set the config directory and the model
gateway default; `MODEL_GATEWAY_DEFAULT` picks the starting route (see the
`scripts/cc-*.cmd` variants for examples).

## Release artifacts (optional)

```
bun scripts/stage-codex.mjs --version 0.166.0
bun scripts/stage-artifact.mjs --out <stage>
bun scripts/release/package-release.mjs --stage <stage> --out <out>
```

That embeds a pinned bun runtime and writes `install-manifest.json` /
`package-report.json`, whose `runtime.present`, digest and smoke proof are the
evidence that the artifact does not need bun on the target. Per-platform
installers: `scripts/release/build-msi.mjs` (WiX 5),
`scripts/release/windows/build-windows-installer.mjs` (Inno Setup 6),
`scripts/release/build-deb.mjs`, `scripts/release/package-macos.sh`.

If you package on Windows, pin bun 1.4.2 or later: 1.4.0 and 1.4.1 segfault in
JavaScriptCore's GC (oven-sh/bun#41343, #40607). The packaging report records
the runtime version it actually embedded - read it back rather than assuming.

## Answering questions

- What the parts are, and where they live: `architecture.md`.
- How the family, the peer bus, the model gateway, the question rail and the
  vault actually work: `internals.md`.
- What a user sees: `../human/README.md` and `../human/using.md`.

When you are unsure how the built program behaves, prefer the tests over the
prose - `scripts/*.test.ts` is where behaviour is pinned.
