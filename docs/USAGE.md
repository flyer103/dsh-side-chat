# Usage — dsh-side-chat

This is the semantic reference for `@flyer103/dsh-side-chat`: what a side chat inherits,
what it isolates, what it may change, and what closing it destroys. It describes the
shipped `0.6.0` on DSH `0.2.1-rc.2`; see [DESIGN.md](DESIGN.md) for rationale and
[CONTRACT.md](CONTRACT.md) for the host/client wire contract.

English | [中文](../README.zh.md)

## Requirements

| item | value |
|---|---|
| DSH | tested on `0.2.1-rc.2`; the host half is a plain ESM Cordis plugin |
| UI surface | Web GUI only (`dsh.client.platform: web`), as a native tab in the right Sidebar; includes the Desktop app window |
| Node.js | `>= 22` for the repository and its tests; the plugin has no runtime dependencies |
| profile | a normal DSH profile such as `desktop` or `web` |
| services | `webServer`, `agents`, `timer` are required; `sessionPersistence` is used when present |
| UI language | follows the DSH language setting: `zh` and `en` are built in; other languages fall back to English |

The plugin imports nothing from `@deepseek-ai/*`, so there is no build step and no version
coupling beyond the DSH APIs above.

## Install

A side chat is a profile plugin. `dsh plugin --profile <name> add <spec>` installs the
package and appends it to the profile's `dsh.profile.bundles`; the profile's own
`cordis.patch.yml` is not edited and **no patch row should be added by hand**. The plugin's
`cordis.patch.yml` is the bundle patch, applied automatically once the package is listed as
a bundle. Installation is version-gated only by what the package declares: this package
declares no `engines.dsh` and no DSH peer, so DSH does not block it.

Pick the profile you actually run: `desktop` for the Desktop application, or `web` (or
another profile you created) for a `dsh web` process. A profile is modified only when it is
the one named here.

### From a local checkout

```bash
cd /path/to/dsh-side-chat
dsh plugin --profile desktop add "$(pwd)"
```

pnpm records a `link:` dependency, so the profile keeps loading this checkout. Re-running
the command is safe; it reports `Already installed` instead of adding a duplicate.

### From GitHub

```bash
dsh plugin --profile desktop add github:flyer103/dsh-side-chat
```

This requires the repository to be pushed to GitHub first (the plugin is not published to
npm). The repository has no build step and no `prepare` script, so no package build approval
is needed. Use a pinned commit when you need reproducibility:
`github:flyer103/dsh-side-chat#<commit>`.

### From a tarball

```bash
cd /path/to/dsh-side-chat
npm pack                       # writes flyer103-dsh-side-chat-0.6.0.tgz
dsh plugin --profile desktop add "$(pwd)/flyer103-dsh-side-chat-0.6.0.tgz"
```

An `https:` tarball URL is accepted the same way.

### With the bundled installer (local checkout only)

```bash
node scripts/install.mjs --profile desktop            # install
node scripts/install.mjs --profile desktop --dry-run  # show the plan, change nothing
node scripts/install.mjs --profile desktop --uninstall
```

The script wraps the same `dsh plugin` commands, verifies that
`dsh --profile <name> --dump-config` composes the `dsh-side-chat` row, never restarts
DSH, and never edits the profile's `cordis.patch.yml`.

### Desktop profile note

Quit the Desktop app before running a `dsh plugin --profile desktop` command, then reopen
it afterwards. The app owns its profile's package operations, and a change made while it
is running is only guaranteed to load after a restart. The `desktop` profile must have
been initialized once by opening the app.

### Verify and restart

```bash
dsh --profile desktop --dump-config | grep -A2 '== @flyer103/dsh-side-chat'
```

You should see the inserted row:

```yaml
- id: dsh-side-chat
  name: '@flyer103/dsh-side-chat'
```

Restart DSH (quit and reopen the Desktop app, or restart the `dsh web` process). The
「侧边会话」 card appears on the right Sidebar's guide page in the next session you open.

## First use

1. Open any session. In the session header, click **「Open sidebar」** (「打开侧边栏」) to
   expand the right sidebar.
2. The sidebar's guide page lists the **「Side chat」/「侧边会话」** card. Click it; the side
   chat opens as a native tab in that column. If the sidebar already shows other tabs, use
   the tab strip's add control to open the guide page. No agent or fork work happens yet;
   there is no session-header side-chat button and no floating overlay, and every click on
   the guide card opens a new tab rather than focusing an existing one.
3. Send the first message. That send creates that tab's side session: it forks the parent's
   context, injects the boundary message, and starts the agent.
4. Open another side chat whenever you need one: click the guide card again, or press the
   **New side chat** (「新建侧边会话」) button in any side-chat tab's status bar. Each
   additional tab is an independent side session, created on its first message, and its chip
   is numbered within the parent session (**Side chat 2** / 「侧边会话 2」, …).
5. Keep talking, stop a running turn, or close one tab. Collapsing the sidebar or switching
   to another tab only pauses that tab's live updates and keeps its side session; closing a
   tab destroys only that side chat, and the other side chats and the main session keep
   running.

A side chat is created lazily. Opening and closing a tab without sending a message produces
no session, no model request, and no cost — opening any number of tabs costs nothing until
each one sends.

## Inheritance semantics

### Completed-turn seed

The side session is seeded with the parent session's event prefix through its last
completed turn (`turn/end`). A turn still in flight is not part of the seed because an
unclosed turn cannot be forked.

The create response reports `inheritedEventCount`: the number of parent events copied into
the seed. That number is also the tab's floor: the host never re-sends events below it, so
the tab shows only the conversation that happens after the boundary. A parent with no
completed turn yet produces an unseeded side session (floor `0`).

Each side chat takes its own seed when its own tab creates it, so two side chats opened at
different times can start from different parent states.

### In-flight context snapshot

Everything the parent committed after that boundary — user messages, assistant text, tool
calls, failed tool results — is read from the parent's live log and appended as reference
text inside the injected boundary message. This is what lets a side chat know what the
main session is doing *right now*, not just what it finished.

The snapshot filters system noise (runtime-context blocks, `<system-reminder>` payloads,
plugin-injected messages and other non-user sources) so the side agent sees the
conversation rather than harness plumbing. It is capped; when the parent did a lot after
the boundary, the most recent activity is kept and older items are marked as omitted. Like
the seed, this snapshot is per side chat: it is read when that tab's side session is
created.

### Inherited runtime

The side session runs a composed copy of the parent's agent preset
(`agentPresets.composeFrom`), so it gets the same tools, skills, prompt sections and
permission rows. It also inherits:

- working directory (`cwd`)
- provider / model / max output tokens
- sandbox mode
- approval policy

### Not inherited

- The main session's transcript is never written to. Side-chat turns do not appear in the
  main conversation.
- The side session is not listed in the session list or workspace.
- Later main-session messages are not pushed into an existing side chat. The snapshot is
  taken at creation; a side chat does not follow the main session afterwards.
- Side-chat content is never merged back into the main transcript.
- Sub-agents are off-limits: the boundary and developer instructions tell the side agent
  not to interact with existing or new sub-agents, even if the parent used them.

## Isolation semantics

- The side agent is created with `origin: 'subagent'`, which keeps it out of the session
  list. It deliberately has no `parentSession`, so it does not appear in the subagent
  catalog either.
- One side session per side-chat tab. A parent session can hold several side-chat tabs in
  the same pane; each tab owns its own side session, persisted log, live stream and
  status/draft state. Closing a tab ends only that side session — it cannot be reopened —
  and the other side chats and the parent session are unaffected.
- The side session owns its own persisted log on disk. The main session's log is untouched.
- Host handles live in memory. A GUI or host restart loses every side session. A page reload
  drops the client tab state; if the rebuilt tab reuses the same per-tab identity while the
  host process is still running, `create` is idempotent per identity and reattaches to the
  existing side session, otherwise the next message starts a new one (see Known
  limitations).
- The tab does not attach to the session through the generic client `sessions` service: a
  parentless subagent-origin session is not addressable there. Its message sources are the
  host's live `/side-chat/api/events` stream and the read-only
  `/side-chat/api/snapshot` polling route; both answer only for sessions this plugin
  created and return `not-found` for anything else — the tab cannot read other sessions.

## Mutation semantics — the point of this plugin

Unlike read-only side-chat plugins, this one is expected to change files:

- Tool calls run with the same tool chain and the same working directory as the parent, so
  `write`, `edit`, `bash` and other enabled tools act on the **same files**.
- A file edited from a side chat is really edited. The main session sees the change on its
  next read; nothing is sandboxed away or simulated.
- The boundary instructions tell the side agent that forked history is *reference only*:
  do not continue the parent's task, but do perform real, minimal edits when the user asks
  for them, and report what changed.
- Side-chat changes are never mirrored into the main transcript, so the main session is not
  told about them by the plugin. Say what you changed, or let the main session discover it.
- Git state is a non-goal: the plugin does not branch, commit, push, or revert on your
  behalf. Commands you ask for are ordinary tool calls in the workspace.
- Concurrency: a side chat and its parent — and several side chats of the same parent — can
  act at the same time, and there is no extra file lock between them. Avoid editing the same
  file from more than one of them at once.

## Sidebar tab behavior

- The side chat is a native tab type of the right sidebar (`kind: side-chat`, registered
  with `multiple: true`), so one parent session can open several side-chat tabs in the same
  pane; every tab body fills that column. The first side chat of a parent session is
  labelled **Side chat** (「侧边会话」 when DSH is in Chinese); later ones append their
  ordinal — **Side chat 2**, **Side chat 3** (「侧边会话 2」, 「侧边会话 3」). There is no
  floating window, no fixed width, no shadow or mask, and no page overlay.
- The tab body has a status bar (status dot plus the localized status — Not created yet /
  Running… / Sending… / Idle, or 尚未创建 / 运行中 / 发送中 / 空闲 — and the localized queue
  count while messages queue, plus the **New side chat** / 「新建侧边会话」 button that
  opens another side-chat tab in the same pane), the message list, the composer, and — once
  the side chat has usage data — the usage dock under the composer.
- Messages: user bubbles with timestamps; assistant Markdown streamed token by token while
  the turn runs (reasoning folded, tool calls folded with their arguments and results);
  running/thinking indicator when no live text is visible yet; optimistic pending messages;
  error banner. Markdown uses the shell's renderer when available and a built-in fallback
  otherwise.
- Composer: `Enter` sends, `Shift+Enter` inserts a newline. The send button becomes
  **Stop** while a turn is running and the composer is empty; typing a draft turns it back
  into Send, and the message queues behind the running turn.
- The message list follows the newest message while you stay at the bottom; scrolling up
  stops the auto-follow.
- Several side chats can run at once: the guide card opens a new tab on every click, and
  each tab's status-bar new-side-chat button does the same. Each additional tab starts empty
  and creates its own side session on its first message.
- Each side-chat tab keeps its own side session, transcript, scroll position and draft. The
  tab type sets `keepMounted`, so switching tabs, switching sessions, collapsing the column
  or changing dock mode preserves every tab's state.
- Collapsing the sidebar or switching to another tab makes that tab invisible: its live
  updates pause and its agent and transcript are kept. Closing one tab is the destructive
  action for that side chat only (see lifecycle).

### How messages reach the tab

While the tab is visible it keeps one live connection open: `POST
/side-chat/api/events`, an SSE stream carrying an opening baseline (fork floor, committed
events, current status and the in-flight assistant attempt), every newly committed session
event, agent status/error notifications, and a `live` replacement for the attempt that is
currently being generated. The tab renders that attempt — reasoning, tool-call arguments
and Markdown text — as it arrives, so a reply types itself into the panel; when the
attempt settles, the committed `assistant/message` replaces the live row. The host clears
the live attempt on commit (and says so on the stream), so the streaming row and the
committed row never both render. When several side chats are open, each visible tab keeps
its own connection for its own side session; they do not share one.

A hidden tab aborts the stream — its right sidebar is collapsed, it is not the active tab,
or the browser tab is hidden — and reconnects with a fresh baseline when it becomes
visible again. The baseline includes the in-flight attempt, so text produced while the tab
was hidden is recovered.

If the transport cannot stream — no readable response body, a JSON refusal, or a response
that buffers and delivers no opening frame within about 2.5 s (for example a proxied or
bridged page) — that tab permanently falls back to `/side-chat/api/snapshot` polling:
roughly every 0.4 s while the side agent runs and every 1.5 s when idle. The snapshot also
carries the in-flight attempt, so fallback tabs still see text grow, at poll granularity;
the running indicator and the optimistic pending bubble cover the rest. A tab never runs
both paths at once, and a stream that drops after its baseline reconnects with backoff. The
same committed entries also feed the bottom usage dock; there is no separate statistics
request, route or timer.

### Usage dock

Under the composer card the panel shows a slim metrics row with this side chat's total
tokens, cache-hit percentage, and a small context-occupancy ring with its percentage — the
same relationship to the composer as DSH's own composer dock. It appears once the side chat
has its first usage sample; before that (and before any side session exists) the row is
absent, and the context ring appears only after a context window is known. The row resets
when a new side session is created and stays fixed for the life of the current one.

Hovering the readings exposes the exact numbers: the token tooltip lists the exact bucket
counts behind the total (uncached input, cache read and output, plus a cache-write segment
when the provider reports cache-write tokens), and the context tooltip shows the approximate
`~used / window` pair. Totals and the cache-hit denominator always include cache-write
tokens. There are no click-open dialogs; turns, steps and tokens per second are not shown in
this version.

The counters are side-scoped: they are folded from the committed events the tab already
receives above the fork floor — this side chat's own requests, including the inherited
context its first request re-sends — so they never include the parent's earlier requests, and
they update as each step settles. `assistant/message` and `assistant/attempt` settlements
supply the usage, with the settlement's stream usage chunk as fallback; a retried step
replaces its earlier sample instead of double-counting (`llm/retry-started` closes the slot).
The cache-hit percentage is the cache-read share of billed input tokens (uncached input +
cache read + cache write).

Context occupancy is deliberately different: it is absolute and approximate. The side chat's
prompt really carries the inherited context, so the percentage is the provider-reported
prompt size of the newest sample — including that inherited part — divided by the route's
context window. The host supplies that denominator on the snapshot and stream `hello`
payloads (as an optional field) because a seeded side session usually never appends its own
`request/context` event; if the side chat later appends one (for example after a model
switch), that window takes precedence. The number deliberately omits DSH's projected-token
correction for content added since the sample, so it can trail the main composer's meter by
up to one step. Treat it as an early-warning signal, not an exact reading.

The dock follows the DSH language setting like the rest of the panel. Its content is fixed:
it does not follow the Performance & usage detailed/compact preference, and there is no
setting to hide it.

## Localization

The tab's user-facing copy follows DSH's language setting (Settings → General → Language /
语言). Chinese and English are built in: choosing 中文 renders the Chinese copy and choosing
English renders English, without a restart. Switching the language re-renders already-open
tabs immediately — the tab chips (including the numbered titles of later side chats), the
sidebar's guide card, the status bar and its new-side-chat button, empty states, composer
placeholders, fold and tool labels, the usage dock's labels and tooltips, and error titles
all follow. The tab title and guide entries are thunks re-read by the sidebar projection, so
they switch in place.

Other active languages (for example one added by an external language pack) fall back
through DSH's locale chain to English, so the tab never shows a raw key or blank copy.

Technical detail stays in English by design: host-returned error messages, routes, event
and tool names, and tool arguments/output are not translated. An error strip shows the
localized title on its first line and the untouched host message on a second monospace
line, which is omitted when it would only repeat the error code.

## Token cost

Each side chat sends its inherited history with its first request, so that request is
roughly as large as the parent's next request. Each side chat then grows on its own — turns
in the main session after creation are not added to it — and its snapshot is taken when
that tab creates it, so side chats opened at different times carry different history.
Treat each side chat's first message as "one extra parent-sized request": with N concurrent
side chats, that inherited-context cost is multiplied by N. The dock under each tab's
composer totals that side chat's own spend as it goes: the inherited prompt its first request
re-sends is part of that total, while the parent's earlier requests are never folded in. Use
its context percentage to watch how full the window is getting, and the main session's own
statistics for the whole-log view.

## Approval behavior

The side session inherits the parent's approval policy. With a `never` policy (for example
the `danger-full-access` preset) tools run without prompts.

With a policy that asks the human, the approval prompt is **not rendered inside the
side-chat tab**, and the side agent waits for an answer that the tab cannot give. Until
approval surfacing ships (P1), use a profile/preset whose policy does not require
interactive confirmation for side chats that need to write files or run commands.

## Lifecycle and destruction

| action | effect |
|---|---|
| open the guide card / press a tab's new-side-chat button | a new client tab instance only; no agent |
| first send in that tab | create that tab's side session: fork seed, snapshot, boundary message, agent |
| collapse sidebar / switch tab | that tab's live updates pause; its tab state, draft and side session are kept |
| close the tab | client clears that tab's state, then calls `close` if its side session exists; host removes the handle before disposing it |
| close during a running turn | dispose cancels that side session's turn; the handle is gone; other side chats keep running |
| close result | that tab's agent is disposed; the host then deletes that side session's own persisted directory from the Host process with `node:fs/promises.rm` (best effort, guarded to that directory); the other side chats and the main session are unaffected |
| reopen | the closed side session cannot be reopened; opening the guide card or the new-side-chat button starts a new tab, whose side session is created on the next message |

Disposal happens whenever a side session existed; artifact deletion is best effort. If the
persistence service cannot locate the artifact or the removal fails, close still succeeds
and only leaves the side session's own artifact on disk as an orphan — it is never shown in
the GUI or the session list, and the main session and workspace are never affected. Closing
a tab that never sent a message only discards the empty client tab, and closing one
side-chat tab never disposes another tab's side session or touches the parent session. A
racing `close`/`prompt` returns `not-found` rather than double-freeing.

## Compatibility

- Verified target: DSH `0.2.1-rc.2`, Desktop profile, Web GUI. This release was verified
  against a real `dsh web` process in an isolated DSH home with a fresh `web` profile: the
  plugin launches, all eight host routes answer (including the SSE route's JSON fallback),
  and the client bundle is served. The stream frame contract is covered by the host/client
  unit tests and an in-process end-to-end check over a real HTTP server.
- Web platform only, and the entry point is the right sidebar's tab system
  (`ctx.sidebarRightTabs`, `ctx.sidebarRight`). There is no CLI/TUI UI for the tab; the host
  routes exist whenever the profile loads the plugin.
- `package.json` declares no `engines.dsh` and no DSH peer dependency, so DSH does not
  version-gate installation. That is not a compatibility promise: newer DSH versions are
  untested. `dsh.plugin.json` records the tested DSH version as metadata only; DSH does not
  read that file.
- Node.js `>= 22` for the repository tooling; the plugin code itself is dependency-free
  ESM.
- The host and client halves share no imports, only the routes in
  [CONTRACT.md](CONTRACT.md) — JSON calls plus one SSE event stream.

## Uninstall and rollback

```bash
dsh plugin --profile desktop remove @flyer103/dsh-side-chat
```

or

```bash
node scripts/install.mjs --profile desktop --uninstall
```

Then restart DSH. Rollback has no migration step: the dependency and the bundle row are the
only installed state, and no main-session transcript, schema, or workspace file was
modified by the plugin's installation. Side sessions are ephemeral by design, so there is
no history to migrate. If you installed into a throwaway profile, delete
`~/.dsh/profiles/<name>` after removing the plugin.

## Troubleshooting

**The right sidebar's guide page has no 「侧边会话」 card.**

1. Confirm the bundle is composed: `dsh --profile <name> --dump-config | grep -A2 dsh-side-chat`.
   If nothing shows, the package is not in `dsh.profile.bundles`; re-run the install command
   for the profile you actually run (`desktop` for the Desktop app, `web` for a web process).
2. Restart DSH. A change made while the profile was running is not guaranteed to load
   without a restart, and the `web` profile is startup-only.
3. Expand the current session's right sidebar with 「Open sidebar」. If the sidebar already
   shows other tabs, use the tab strip's add control to open the guide page.
4. Check that the client half loaded: the Plugins page (or the plugin inventory) should list
   the `dsh-side-chat` row as active; browser devtools show a client import error if it did
   not.

**The tab opens but the first message fails.**

The tab shows an error banner with the host's error code. `create-failed` means the fork or
agent creation rejected — check the DSH log. `not-found` means the parent session is gone
(closed, or the GUI reloaded): close the tab and open a new side chat. `unknown-source` means
the session the tab was opened for no longer exists.

To check the host half directly, call a route with an empty body; a live plugin answers
`{"ok":true,...}`:

```bash
curl -s -X POST "<dsh-web-base-url>/side-chat/api/list" \
  -H 'Content-Type: application/json' -d '{}'
```

**The side chat seems stuck.**

It may be waiting for an approval its policy requires the human to answer (see the
approval section), or a tool is still running. Press Stop to cancel the turn. Check that the
tab is the active tab in an expanded right sidebar; a hidden tab deliberately stops live
updates.

**A refresh lost the side chat.**

Tab state lives in memory and is not restored across a reload. If the rebuilt tab reuses the
same per-tab identity while the host process is still running, its `create` reattaches to
the existing side session (create is idempotent per instance key); otherwise you get a new
side chat. After a GUI or host restart every side session is gone. Reopen the guide card or
press the new-side-chat button; a new side chat is created on the next message.

**Clicking the guide card starts another side chat instead of focusing the old one.**

That is intended: one parent session can hold several independent side chats, and the guide
card — like the status bar's new-side-chat button — opens a new one on every activation.
Close the tabs you no longer need; closing one only destroys its own side session.

**A reply appears all at once instead of streaming.**

The tab tries the live event stream first. If the page transport buffers responses, or the
host cannot open the stream, the tab detects the missing opening frame and falls back to
snapshot polling for that tab; replies then arrive at poll granularity or, at worst, when
they commit. Reload the page to retry the stream. If streaming never works, check the
browser devtools network panel: `/side-chat/api/events` should be an open request with
`text/event-stream`, and the host log should show no route registration warning.

**`dsh plugin --profile desktop add ...` fails.**

Quit the Desktop app first, and make sure the `desktop` profile was initialized once by
opening the app. Do not point the installer at `web` while you run the Desktop app unless
that is the profile you mean to modify.

**GitHub or tarball install fails.**

The CLI needs `git` and network access for `github:` specs; `npm pack` output must be
referenced by an absolute path or an `https:` tarball URL. This package has no `prepare`
script, so no package build approval is required; if pnpm asks to allow build scripts, it
is about a dependency, not this plugin.

## Known limitations

- **Approval prompts are not surfaced in the side-chat tab.** See above.
- **A closed tab cannot be restored.** Closing destroys only that side session; a GUI or host
  restart also loses every side session. The other side chats are unaffected.
- **Every side chat carries its own inherited context.** Its first request is about as large
  as the parent's next request, so N concurrent side chats multiply that cost.
- **Artifact deletion is best effort.** The agent is always disposed, but the side session's
  own session log can be left on disk as an orphan when removal fails. It is never listed in
  the GUI or session list.
- **Token streaming needs a streamable response.** The browser GUI and the Desktop window
  stream normally; if a transport buffers the response (detected by a missing opening frame
  after ~2.5 s), the tab falls back to polling committed events, so replies then appear at
  poll granularity or on commit.
- **History is not refreshed.** The snapshot is taken once per side chat, when that tab
  creates it.
- **P1 items are designed but not implemented:** model picker for the side session,
  side-session history across a GUI restart, approval rendering in the tab.
- **The usage dock is approximate and side-scoped.** Token and cache-hit totals cover the
  side chat's own requests — including the inherited context its first request re-sends — and
  never the parent's earlier requests; context occupancy is the newest provider-reported
  prompt size without DSH's projected-token correction, so it can trail the main composer's
  meter by up to one step. The dock shows no turns, steps or tok/s and has no click-open
  dialogs.
- **A reattached tab can undercount earlier usage.** A tab that reattaches to an existing
  side session reloads at most the trailing 2000 entries of the session log, so usage events
  older than that snapshot page are not folded and the dock's totals are low. A tab that has
  watched the side chat since creation is unaffected, because it receives every committed
  event.
- **The dock does not follow Performance & usage.** DSH can render its own composer
  statistics in detailed or compact mode; the side-chat dock has fixed content and ignores
  that preference.
- The tab is Web-only, and the plugin is not a replacement for the native conversation UI.

## File map

| file | role |
|---|---|
| `lib/index.js` | host half: `webServer` routes including the SSE stream, live assistant-attempt folding, fork seed + recent-context snapshot, boundary injection, per-identity (per-tab) side-session registry, the optional `contextWindow` on snapshot/`hello`, close/dispose |
| `lib/client.js` | client half: right-Sidebar tab type + guide entry, one tab body per tab instance (SSE/poll message sources, streaming rendering, composer, bottom usage dock, RPC calls), numbered chips + the new-side-chat button, and the close handler |
| `cordis.patch.yml` | bundle patch inserting the `dsh-side-chat` loader row |
| `package.json` | `dsh.bundle.patch`, `dsh.client` (web platform), package identity, `node >= 22` |
| `dsh.plugin.json` | community manifest metadata; DSH itself does not read this file (see the README) |
| `scripts/install.mjs` | idempotent local installer/remover with `--dry-run` |
| `tests/` | `node --test` unit tests for the host and client halves |

## Related documents

- [README](../README.md) — positioning, comparison, quick start.
- [DESIGN.md](DESIGN.md) — scope, phases and adversarial notes.
- [CONTRACT.md](CONTRACT.md) — routes, Sidebar tab integration and rendering contract.
