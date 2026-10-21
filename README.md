# dsh-side-chat

A **side chat** for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI: open the right sidebar from the session header, add the **Side chat** (「侧边会话」) tab, and keep the main conversation untouched — while the side conversation still carries the same agent, the same tools, and **really edits the same workspace files**.

English | [中文](README.zh.md)

[![CI](https://github.com/flyer103/dsh-side-chat/actions/workflows/test.yml/badge.svg)](https://github.com/flyer103/dsh-side-chat/actions/workflows/test.yml)
[![Release](https://img.shields.io/github/v/release/flyer103/dsh-side-chat)](https://github.com/flyer103/dsh-side-chat/releases)
[![npm](https://img.shields.io/npm/v/@flyer103/dsh-side-chat)](https://www.npmjs.com/package/@flyer103/dsh-side-chat)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Quick start

```bash
# npm (recommended)
dsh plugin --profile desktop add @flyer103/dsh-side-chat

# GitHub, default branch or a pinned tag
dsh plugin --profile desktop add github:flyer103/dsh-side-chat
dsh plugin --profile desktop add github:flyer103/dsh-side-chat#v0.6.0

# local checkout (records a link: dependency)
cd /path/to/dsh-side-chat
dsh plugin --profile desktop add "$(pwd)"

# tarball built with `npm pack`
dsh plugin --profile desktop add /absolute/path/flyer103-dsh-side-chat-0.6.0.tgz
```

Use the profile you actually run: `desktop` for the Desktop app, `web` for a web profile. Prefer quitting the Desktop app before installing into `desktop` (the CLI waits on the profile write lock) and reopen it afterwards; either way a restart is required. `add` also appends the bundle to the profile's `dsh.profile.bundles`; you do not edit the profile's `cordis.patch.yml` by hand. Re-running is safe.

Alternatively, from a local checkout:

```bash
node scripts/install.mjs --profile desktop            # idempotent; never restarts DSH
node scripts/install.mjs --profile desktop --dry-run  # show the plan only
```

Then **restart DSH**, open a session, and expand the right sidebar from the session header (**「Open sidebar」** / 「打开侧边栏」). On the sidebar's guide page, click the **「Side chat」** (「侧边会话」) card; the side chat opens as a native tab in that column. (There is no session-header side-chat button and no floating overlay — the entry lives in the right sidebar, also reachable from the tab strip's add control; inside an open side-chat tab, the status bar's **New side chat** button opens another one.) Send the first message: that tab's side chat is created on that send and destroyed when you close its tab. Every click of the guide card, and every press of a tab's **New side chat** button, opens another side-chat tab in the same pane, each with its own side session and a chip numbered within the parent session (**Side chat**, **Side chat 2**, …; 「侧边会话」, 「侧边会话 2」…). Collapsing the sidebar or switching to another tab only pauses a side chat; opening a tab without sending costs nothing. Closing one side-chat tab destroys only that side chat — the other side chats and the main session are unaffected.

## What it does

- **Native sidebar tab** — lives in the session's right sidebar next to the other tabs; no standalone session-header button and no floating overlay.
- **Several at once** — a parent session can hold multiple independent side-chat tabs, each its own ephemeral side session with a numbered chip; open another from the guide card or from a tab's **New side chat** button.
- **Inherits context** — the parent's completed turns plus a snapshot of what the main session is doing right now, taken when that side chat is created.
- **Inherits the agent** — same working directory, preset composition, tools, skills, model routing, sandbox mode and approval policy.
- **Really edits files** — write/edit/bash changes land in the same workspace and the main session sees them.
- **Isolates the transcript** — side-chat turns never appear in the main conversation, the session list, or the subagent catalog.
- **Streams the reply** — assistant text, reasoning and tool calls render token by token from a live event stream while the turn runs; when the transport cannot stream, the tab falls back to polling.
- **Shows its own usage** — a slim dock under the composer (the same spot as DSH's main composer dock) shows this side chat's total tokens, cache-hit percentage, and a small context-occupancy ring + percentage. Hover for the exact uncached-input, cache-read and output counts (plus a cache-write count when the provider reports one) and the approximate `~used / window` pair. The dock starts hidden until the side chat has a usage sample, and it resets with each new side session.
- **Destroys on close** — closing a tab disposes that tab's side chat and the host tries to remove its persisted artifact; a closed side chat cannot be reopened, and the other side chats and the main session are unaffected. Collapsing the sidebar or switching tabs only pauses it.

## Compatibility

- DSH `0.2.1-rc.2` (Desktop profile, Web GUI) — the tested target. This release was verified against a real `dsh web` process in an isolated DSH home with a fresh `web` profile: the plugin launches, all eight host routes answer (including the SSE route's JSON fallback), and the client bundle is served.
- No `engines.dsh` and no DSH peer dependency are declared, so DSH does not version-gate installation. That is separate from the tested version: newer DSH releases are untested.
- Web platform only (`dsh.client.platform: web`); no CLI/TUI surface.
- Node.js `>= 22`; the plugin itself is dependency-free ESM with no `@deepseek-ai/*` imports.
- UI copy follows the DSH language setting (Settings → General → Language): Chinese and English are built in, and any other language falls back to English. Technical details — host error messages, routes, event and tool names — stay in English.

## Known limitations

- Approval prompts are not shown inside the side-chat tab: the side session inherits the parent's approval policy, and if that policy asks a human, the side session waits. Use a non-interactive policy (for example `danger-full-access`) for side chats that must write files.
- A closed tab cannot be restored: reopening the guide card or pressing **New side chat** starts a new side chat, whose agent is created on the next message.
- P1, designed but not implemented: model picker, surviving a GUI restart, approval rendering in the tab.
- The inherited context is a snapshot taken when that side chat is created; later main-session turns are not pushed into an existing side chat, and each side chat keeps its own snapshot.
- Token streaming rides on a streamable `fetch` response. If the page transport buffers the response (detected by a missing first frame), the tab falls back to snapshot polling: the running indicator returns and the reply still appears while it grows, at poll granularity.
- Each side chat's first request is roughly as large as the parent's next request (it carries the inherited history), so N concurrent side chats multiply that first-request cost.
- The usage dock is approximate and side-scoped: its token totals and cache-hit percentage cover what this side chat itself billed — its own requests, including the inherited context its first request re-sends — and never the parent's earlier requests; its context percentage is absolute for the same reason, and it omits DSH's projected-token correction, so it can trail the main composer's context bar by up to one step. It shows no turns, steps or tok/s, has no click-open dialogs, and cannot follow DSH's Performance & usage detailed/compact preference; its content is fixed.
- A reattached side-chat tab whose session log exceeds the 2000-entry snapshot page can undercount earlier usage in that dock. A tab that has watched the side chat since its first message is unaffected, because every committed event reaches it.

## Documentation

- [docs/USAGE.md](docs/USAGE.md) — full semantics: inheritance, isolation, mutation, lifecycle, installation, rollback, troubleshooting.
- [docs/DESIGN.md](docs/DESIGN.md) — scope, phases and adversarial notes.
- [docs/CONTRACT.md](docs/CONTRACT.md) — host routes, Sidebar tab integration and rendering contract.

## Repository layout

| path | role |
|---|---|
| `lib/index.js` | host half: routes, live attempt accumulation and the SSE stream, fork seed, boundary injection, per-instance session registry, close/dispose |
| `lib/client.js` | client half: right-Sidebar tab type + guide entry, the per-tab body (streaming messages + composer + usage dock), numbered tab chips, the new-side-chat button and the close handler |
| `cordis.patch.yml` | bundle patch inserting the `dsh-side-chat` row |
| `scripts/install.mjs` | idempotent installer/remover for a local checkout |
| `dsh.plugin.json` | community manifest metadata; DSH does not read it (official display metadata comes from `package.json` and optional `locale/*.json`) |
| `tests/` | `node --test` unit tests |

## Uninstall

```bash
dsh plugin --profile desktop remove @flyer103/dsh-side-chat
```

Then restart DSH. No transcript, schema or workspace data is migrated or deleted; side chats are ephemeral.

## License

MIT
