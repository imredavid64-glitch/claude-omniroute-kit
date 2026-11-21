# claude-omniroute-kit

One command sets up **Claude Code behind a local [OmniRoute](https://www.npmjs.com/package/omniroute) gateway** with automatic provider failover and token optimization.

- **Failover that keeps the agent alive.** Claude Code talks to two OmniRoute "combos" (`unlimited`, `unlimited-fast`). If your first provider hits a rate limit, the next one answers. Only models that pass a *real tool-call probe* are admitted, because a text-only fallback stalls an agent.
- **Token optimization.** [RTK](https://github.com/rtk-ai/rtk) condenses Bash/tool output; OmniRoute's conservative compression (lite + session-dedup) trims the rest.
- **Secure by default.** Fresh secrets per machine, storage encryption on, API key required, bound to loopback only.

## Double-click installers (.exe / .pkg)

For people who don't want a terminal: one file to open.

| OS | File | What it does |
| --- | --- | --- |
| Windows | `ClaudeOmniRouteSetup.exe` | Confirm prompt, unpacks to `%LOCALAPPDATA%\claude-omniroute-kit`, installs Node.js LTS if missing (winget, with a direct-download fallback), adds Start-menu shortcuts (*Setup (re-run)*, *Health check*), then runs the guided setup in a console window. A log is saved to `setup.log` in that folder. |
| macOS | `ClaudeOmniRouteSetup.pkg` | Installs the kit plus `/Applications/Claude OmniRoute Setup.command`, then opens it in Terminal. The setup runs as **you**, not root, because it writes to `~/.claude`. Offers `brew install node` if Node is missing. |

**Build them yourself** (installers are not checked into the repo):

```powershell
powershell -ExecutionPolicy Bypass -File packaging\windows\build-exe.ps1   # on Windows -> dist\ClaudeOmniRouteSetup.exe
```
```sh
sh packaging/macos/build-pkg.sh 1.0.0                                      # on a Mac     -> dist/ClaudeOmniRouteSetup.pkg
```

Both builders run the secret scan first and refuse to build if it fails. `.github/workflows/release.yml` builds both on GitHub (Windows and macOS runners) and attaches them to a release when you push a `v*` tag.

**Unsigned = a warning on first open.** Windows SmartScreen shows "Unknown publisher" (More info > Run anyway); macOS Gatekeeper needs right-click > Open. Removing the warnings requires a code-signing certificate (Windows) / Apple Developer ID plus notarization (macOS). The macOS builder will sign if you set `KIT_SIGN_IDENTITY`; nothing here signs the Windows exe.

Test hooks for the Windows installer: `OMNIROUTE_KIT_HOME` (install dir), `OMNIROUTE_KIT_ARGS` (e.g. `--dry-run`), `OMNIROUTE_KIT_NOPAUSE=1`.

## Quick start (from source)

Windows (PowerShell):

```powershell
.\install.ps1
```

macOS / Linux:

```sh
sh install.sh
```

Needs Node **22.22.2+** (or 24-26). The script offers to install Node on Windows via winget. Then open a **new terminal** and run `claude`.

Unattended: `sh install.sh --yes` (keyless providers only, plus any keys in env vars `GROQ_API_KEY`, `NVIDIA_API_KEY`, `OPENROUTER_API_KEY`).
Preview without changing anything: `--dry-run`.

## What you must bring (nothing secret is in this kit)

This kit contains **no credentials, tokens, cookies, account emails or connection IDs**. `node tools/scan-secrets.mjs` proves it and the test suite enforces it. Each person connects their own accounts. The installer handles each kind differently:

| Kind | Providers | What happens |
| --- | --- | --- |
| **Keyless** | DuckDuckGo AI Chat, Kilo Gateway anonymous tier | Connected automatically. Zero signup. Gives you a working (modest) floor immediately. |
| **Free API key** | Groq, NVIDIA NIM, OpenRouter | Prompted (hidden input, Enter skips) with the signup link. Or set the env var. No card needed for any of these. |
| **Subscription OAuth** | Claude, ChatGPT/Codex, Antigravity, Antigravity CLI, GitHub Copilot | Opt-in per provider, default **No**. Launches the provider's own browser/device login. |

> **Terms of service.** Routing a consumer subscription (Claude Pro/Max, ChatGPT, Copilot, Antigravity) through a third-party gateway can breach that provider's terms or trigger account action. The installer warns before each one and defaults to No. It is your account and your call. Deliberately excluded: `kimi-coding` (accounts get banned) and providers whose "free" tier requires a card (SambaNova, Cerebras, HuggingFace, Vercel AI Gateway).

With **only keyless providers**, expect weaker models and tighter limits than a subscription. Add a Groq or NVIDIA key (a minute each) for a big improvement.

## What the installer does

1. **Preflight**: Node version, npm, Claude Code (offers to install it).
2. **OmniRoute**: `npm i -g omniroute@3.8.53` (the tested version; override with `--omniroute-version`).
3. **Gateway**: generates fresh `JWT_SECRET`, `API_KEY_SECRET`, `STORAGE_ENCRYPTION_KEY` and a dashboard password into `~/.omniroute/.env` (mode 600). Sets `REQUIRE_API_KEY=true`, binds `127.0.0.1`, starts it, then **verifies it is unreachable from your LAN addresses**.
4. **Gateway API key** for Claude Code (created through the dashboard session API).
5. **Providers** as in the table above.
6. **Combos**: probes every candidate model with a real `tool_use` request, keeps the ones that pass in priority order, and (re)creates `unlimited` / `unlimited-fast`.
7. **Compression**: `lite` + `session-dedup` on; tool-result truncation, caveman and OmniRoute's rtk engine **off** (see below). The previous config is saved to `compression-settings.bak-pre-kit.json`.
8. **RTK**: installs it (winget / brew / official script, asking first), verifies with `rtk gain`.
9. **Claude Code settings**: *merges* into `~/.claude/settings.json` (backup first, never replaces your other keys): gateway URL + key, combo model names, context-window variables, and the RTK hook **only if RTK actually works**. Also adds `@RTK.md` to `CLAUDE.md`.
10. **Optional plugins** (Vercel, Resend). Off unless you say yes.
11. **Autostart** at login (Windows Startup entry / launchd / systemd user unit). Claude Code stops working if the gateway is down, so this defaults to yes.
12. **End-to-end check**: a tool call through each combo.

Re-running is safe: it reuses secrets, reuses the gateway key, and never duplicates hooks.

## Token optimization: what to expect

| Layer | State | Why |
| --- | --- | --- |
| RTK Bash hook | on (if installed) | Rewrites noisy commands (`git`, `ls`, test runners...) to compact output. Biggest single win. |
| OmniRoute `lite` + `session-dedup` | on | Whitespace and duplicate-block removal. Measured about **9%** on a whitespace-heavy payload. Expect modest, not 50-90%. |
| Lite tool-result truncation (2000 chars) | **off** | It silently chops file reads Claude Code depends on. |
| Caveman engine | **off** | Rewrites your prompts (lossy). |
| OmniRoute rtk engine | **off** | Overlaps with the RTK hook. |

## Security notes

- The dashboard password is `INITIAL_PASSWORD` in `~/.omniroute/.env`. **Back that file up**: losing `STORAGE_ENCRYPTION_KEY` makes stored provider credentials unreadable (you would re-connect providers).
- The gateway key is written in plain text into `~/.claude/settings.json` (that is how Claude Code reads it). Do not commit or share that file.
- `--lan` binds all interfaces; only use it behind a firewall.
- `permissions.defaultMode = bypassPermissions` is **not** applied. Opt in with `--bypass-permissions` only if you understand it lets Claude run any tool without asking.
- The installer refuses to run against an existing OmniRoute database it did not create (new secrets would make it undecryptable). Use `--adopt --password <pw>` to configure an existing instance, or `--port`/`--data-dir` for a separate one.

## Day-2 operations

```sh
node installer/doctor.mjs                       # read-only health check (auth enforced? combos alive? RTK hooked?)
node installer/install.mjs --only combos        # free tiers rot: re-probe and rebuild combos
node installer/install.mjs --only providers,combos,claude   # after adding a provider
```

**Context window.** `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is `1000000` only when a Claude subscription is first in the combo, otherwise `128000` (override with `--context-tokens`). If a long session fails over from a 1M model to a 128K one mid-way, you can hit context errors. That is the price of failover.

**Roll back.** Restore `~/.claude/settings.json.bak-omniroute-kit-<timestamp>`; put `~/.omniroute/compression-settings.bak-pre-kit.json` back via the dashboard; delete the autostart entry (Windows: `OmniRoute Gateway.vbs` in your Startup folder); `npm rm -g omniroute` to remove the gateway.

## Layout

```
install.ps1 / install.sh      bootstrap (checks Node, then runs the installer)
installer/install.mjs         the 12 steps; --help lists every flag
installer/doctor.mjs          read-only health check
installer/lib/                pure logic (settings merge, combo selection) + I/O helpers
config/                       the "setup" itself: combos, providers, compression, settings template, plugins
packaging/windows/            setup.ps1 (runs inside the exe) + build-exe.ps1 (IExpress)
packaging/macos/build-pkg.sh  builds the .pkg (macOS only)
.github/workflows/release.yml builds both installers in CI
tools/scan-secrets.mjs        proves nothing sensitive is in the kit (--live also checks the author's real secrets are absent)
tools/refresh-combos-from-live.mjs   maintainer: diff/update combos.json from a running gateway
test/                         18 tests: node --test
```

## Verification status (read this)

Verified on the author's Windows 11 machine, Node 24, OmniRoute 3.8.53, Claude Code 2.1.268:

- 18 unit tests pass (settings merge idempotence and non-destructiveness, combo selection, CLI-output parsing, Node gate, secret scanner self-test).
- Secret scan clean, including a check that the author's real gateway token appears nowhere.
- `config/combos.json` matches the author's live gateway exactly (23 + 10 members).
- `--dry-run` correctly detects an existing install and port conflict and refuses to touch them.

**The `.exe` and `.pkg` builders are written and syntax-checked (the PowerShell scripts parse, the shell script passes `sh -n`) but neither installer has been built or launched yet.** The macOS one additionally needs a Mac to build.

**Not yet exercised end to end:** a full fresh install against a clean OmniRoute (boot, key creation, provider adds, probes, combo create, compression PUT). Those steps call OmniRoute's dashboard API and CLI; their request shapes come from OmniRoute's docs and the author's earlier working sessions, and every step has a fallback (for example, if automatic key creation fails the installer asks you to paste a key from the dashboard). macOS/Linux autostart and install paths were written but never run. If a step fails, the error names it and `--only <step>` re-runs just that step.

## Third-party software

OmniRoute and RTK are separate projects with their own licenses and terms; this kit only automates installing and configuring them.
