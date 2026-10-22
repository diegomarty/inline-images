# Contributing to Inline Images

Thanks for helping. Inline Images is a Claude Code mod: a hooks module the engine loads, which draws pictures in the terminal transcript. This guide covers running it from a clone, checking a change, and opening a pull request.

## What you need

- **Claude Code 2.1.308 or later.** It runs the mod, its validator and its tests.
- **A terminal that draws pictures**, to see a change as most users will: Ghostty or kitty. Also check one that does not (Terminal.app, or Ghostty inside tmux), where pictures are drawn in cells.
- **The fullscreen interface** (`"tui": "fullscreen"`) for anything that involves the pointer: chips, hover cards, clicks.
- **A converter for pictures that are not PNG or GIF**: `sips` on macOS and PowerShell on Windows are built in; on Linux, ImageMagick.
- **Python 3 with Pillow**, only if you change the icon or the README's illustrations.

## Run the mod from your clone

```bash
git clone https://github.com/diegomarty/inline-images.git
cd inline-images
claude --plugin-dir .
```

To have every new session load it, and reload it whenever you save a file, add the clone's path to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`. Separate it from other paths with `:`.

Do not also install the mod from the marketplace while you run it from a folder: it would load twice, and every picture would be drawn twice.

## How the code is laid out

| File | What it does |
| --- | --- |
| `hooks/register.tsx` | The hooks module: every event the mod handles, and how it reads, keeps and draws pictures |
| `hooks/gif.ts` | The GIF decoder: frames, delays and disposal, each frame shrunk as it is decoded |
| `hooks/pixels.ts` | BMP parsing, and the painter that draws a picture in block-element cells |
| `hooks/budget.ts` | The memory budget: least recently used, by bytes |
| `hooks/chip.tsx` | The surface module of a chip and of a picture's click region |
| `hooks/probe.tsx` | The surface module that measures each block of an answer |
| `hooks/register.test.tsx` | The tests, run against the engine |
| `types/index.d.ts` | The contract of the mod's `$.state` values |
| `scripts/` | The icon and the README's illustrations, drawn with Pillow |

The engine's API is described by the types it writes to `.claude-plugin/types/` the first time it loads the mod. That folder is ignored by git. Grep it for an event or a method before you use it, since the API is early access and changes between Claude Code versions.

## Check a change

Run these before you open a pull request. CI runs the first two on every pull request.

```bash
claude plugin validate . --profile directory   # the manifest, the marketplace, the module, the icon
claude plugin test .                           # the tests, against the engine
npx -p typescript tsc -p .                     # type-check; needs the types the engine wrote
```

Then try the change in a real session, in a terminal that draws pictures and in one that does not.

### Tests

- **Every fix comes with a test** that fails without it, and every feature with tests of what it draws.
- **The `world` in `register.test.tsx` stands for what is beneath the mod**: files, processes (`head`, `dd`, `sips`, `git`), the prompt box, and what the engine draws. It behaves like the engine where that matters. For example, `fs.read` rejects files of 4 MiB or more, and `fs.stat` rejects missing files. If your change runs a new process, teach the `world` to answer it the way the real one does.
- **Check a system command for real at least once.** Run it on your machine with the same arguments the mod uses. `sips`, for example, behaves in ways a mock would not guess. `node --experimental-strip-types scripts/system-check.ts` runs every operation of [`hooks/system.ts`](hooks/system.ts) for real on the system it is on; CI runs it on macOS, Ubuntu and Windows.

### Style

- Match the code around you: two spaces, no semicolons, a space before a function's parentheses.
- Comments say what a thing is or why it is so, not what the next line does.
- Keep `$` at the call site (`$.fs.read(...)`), pass it only to top-level functions, and never store it. `claude plugin validate` refuses a module that does otherwise.

## Commits

Commits follow [Conventional Commits](https://www.conventionalcommits.org), as in [midudev/better-claude](https://github.com/midudev/better-claude):

- **One change per commit.** A feature and a fix go in separate commits, even when you make them together.
- **A short subject**, under about 70 characters, in the imperative, lowercase after the type: `fix: recreate the cache folder after a session ends`.
- **Types:** `feat`, `fix`, `perf`, `docs`, `test`, `ci`, `build`, `chore`. No scope is needed, as the repository holds one plugin.
- **A body only when the why is not obvious**: one short paragraph, not a list of what the diff already shows.
- **A version bump** is its own commit: `chore: bump to 0.3.0`.

## Pull requests

1. Branch from `main`: `feat/<what>` or `fix/<what>`.
2. Keep the pull request to one topic.
3. In its description, say what changed, why, and how you tried it: which terminals, fullscreen or not. Add a screenshot or a short recording for anything visible.
4. CI must pass.
5. Update the README when what the mod does, or its limits, change.

## Releases

Maintainers release. They raise the version in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` (CI fails when the two differ), commit it, and push a `v<version>` tag. The Release workflow checks that the tag matches the version, runs the checks and publishes the GitHub release.

## Reporting a problem

Open an issue with:

- your terminal and its version, and whether you run inside tmux or over ssh;
- your Claude Code version (`claude --version`), and whether you use the fullscreen interface;
- what you did, what you expected and what you saw: a screenshot helps most;
- any `inline-images:` line in the transcript, or in the debug log (`claude --debug`).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
