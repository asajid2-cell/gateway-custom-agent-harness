# AGENTS.md

This is the order to do things in if you were handed this repo and asked to
build it, run it, or explain it to someone. Read this first, then take
[architecture](architecture.md) for what the parts are and
[internals](internals.md) for how they work.

## What this repo is

It is the layer, not the program. Everything the fork adds is here - the model
gateway, the session family and peer bus, the question rail, the vault, the
release tooling and the tests that pin them - and the claude code snapshot it
builds on is not, because it is not ours to publish.

The fork also changes a fair amount of the snapshot itself, and those versions
are not published either. `upstream-touched.txt` lists their paths - 454 of
them - so you know where the join is without shipping the pieces.

So copy this tree over a snapshot and you have the fork's files. What you have
to restore is the wiring between them.

## What you need

A claude code source snapshot of the same generation the fork was taken from;
close is usually enough, and API drift is what bites. `bun` 1.4.x, because both
the launchers and the build assume it, and `node` 20 or newer for the `.mjs`
test scripts. Nothing else at build time.

Keep the snapshot out of this repo, and out of any fork of it.

## Putting it back together

Unpack the snapshot somewhere you can throw away, then lay this tree on top.
Every path here is a path the snapshot does not have apart from `README.md`, so
the copy only adds files:

```
rsync -a --exclude .git /path/to/this/repo/ ~/gw-build/
```

Now restore the wiring. Nine tenths of it is in `src/utils` (133 files) and
`src/components` (116): session storage, message origins, model routing,
settings, and the mount points for the new dialogs. The rest is spread over
`src/tools` (42, the tool registry), `src/services` (34, provider clients,
compaction, quota), `src/hooks` and `src/ink` (53, the render and input hooks
the new UI attaches to), `src/commands` and `src/cli` (30, the command table and
its handlers), and `src/entrypoints` (5, the startup path). The full list is in
`upstream-touched.txt`.

The compiler is the guide here. Start at the entrypoint and the command table -
once tools and commands are registered, most of the remaining errors are
consequences of those two and go away on their own. Build, fix the first error,
repeat.

Two things the prompt usually forgets. The build has to inline Markdown and
`.txt` assets, because the skills in `src/skills/bundled` and the classifier
prompts in `src/utils/permissions/yolo-classifier-prompts` are read as text at
build time - if the snapshot's build script does not handle those module types,
add it. And the dependencies have to be reconciled: `package.json` and
`bun.lock` are snapshot files, so take theirs, run `bun install`, and add
whatever the overlay imports that they don't have.

## Building

```
bun install
bun run build            # bundles src/entrypoints/cli.tsx to dist/cli.js
bun ./dist/cli.js --version
```

The snapshot does not typecheck cleanly by itself, so `bun run typecheck` will
not reach zero and chasing it is a waste of a day. Take a baseline before you
touch anything and compare against that.

Worth running, because they pin the behaviour you just rebuilt:

```
bun test scripts/question-rail.test.mjs
bun test scripts/leaf-family.test.ts scripts/leaf-merge.test.ts
bun test scripts/vault-obligations.test.ts scripts/vault-recall.test.ts
node --test scripts/model-gateway.test.mjs
```

## Running it

`scripts/cc` on Linux and macOS, `scripts/cc.cmd` on Windows, or
`bun ./dist/cli.js` if you want to skip the launcher. The launchers set the
config directory and the starting model route; `MODEL_GATEWAY_DEFAULT` is the
knob, and the `scripts/cc-*.cmd` variants show it in use.

## Packaging

Only worth doing if you actually need installers:

```
bun scripts/stage-codex.mjs --version 0.166.0
bun scripts/stage-artifact.mjs --out <stage>
bun scripts/release/package-release.mjs --stage <stage> --out <out>
```

That embeds a pinned bun runtime and writes `install-manifest.json` and
`package-report.json`. The `runtime.present`, the runtime digest and the smoke
proof in those two files are the evidence that the artifact does not need bun on
the target - read them back rather than trusting the archive. The native
installers are `scripts/release/build-msi.mjs` (WiX 5),
`scripts/release/windows/build-windows-installer.mjs` (Inno Setup 6),
`scripts/release/build-deb.mjs` and `scripts/release/package-macos.sh`.

On Windows, pin bun 1.4.2 or later when packaging. 1.4.0 and 1.4.1 segfault in
JavaScriptCore's GC (oven-sh/bun#41343, #40607), and the failure looks like a
packaging bug until you check the report and see the version.

## Answering questions

If someone asks what a part is, [architecture](architecture.md) maps it. If
they ask how something works - the family, the peer bus, routing, the rail, the
vault - [internals](internals.md) is written for exactly that. If they ask what
they will see when they run it, the human docs in [human/](../human) are what
they were written for.

When the prose and the tests disagree, the tests are right. `scripts/*.test.ts`
is where the behaviour was actually decided.
