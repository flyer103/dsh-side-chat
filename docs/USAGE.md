# Usage — dsh-side-chat

This is the semantic reference for `@flyer103/dsh-side-chat`: what a side chat inherits,
what it isolates, what it may change, and what closing it destroys. It describes the
shipped `0.1.0` on DSH `0.2.1-rc.2`; see [DESIGN.md](DESIGN.md) for rationale and
[CONTRACT.md](CONTRACT.md) for the host/client wire contract.

English | [中文](../README.zh.md)

## Requirements

| item | value |
|---|---|
| DSH | tested on `0.2.1-rc.2`; the host half is a plain ESM Cordis plugin |
| UI surface | Web GUI only (`dsh.client.platform: web`), including the Desktop app window |
| Node.js | `>= 22` for the repository and its tests; the plugin has no runtime dependencies |
| profile | a normal DSH profile such as `desktop` or `web` |
| services | `webServer`, `agents`, `timer` are required; `sessionPersistence` is used when present |

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
npm pack                       # writes flyer103-dsh-side-chat-0.1.0.tgz
dsh plugin --profile desktop add "$(pwd)/flyer103-dsh-side-chat-0.1.0.tgz"
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
button appears in the next session you open.

## First use

1. Open any session. The session header shows a **「侧边会话」** button.
2. Click it. The panel opens immediately at the right edge — no agent or fork work happens
   yet.
3. Send the first message. That send creates the side session: it forks the parent's
   context, injects the boundary message, and starts the agent.
4. Keep talking, stop a running turn, or close the panel. Closing destroys the side
   session.

A side chat is created lazily. Opening and closing the panel without sending a message
produces no session, no model request, and no cost.

## Inheritance semantics

### Completed-turn seed

The side session is seeded with the parent session's event prefix through its last
completed turn (`turn/end`). A turn still in flight is not part of the seed because an
unclosed turn cannot be forked.

The create response reports `inheritedEventCount`: the number of parent events copied into
the seed. That number is also the panel's floor: the host never re-sends events below it,
so the panel shows only the conversation that happens after the boundary. A parent with no
completed turn yet produces an unseeded side session (floor `0`).

### In-flight context snapshot

Everything the parent committed after that boundary — user messages, assistant text, tool
calls, failed tool results — is read from the parent's live log and appended as reference
text inside the injected boundary message. This is what lets a side chat know what the
main session is doing *right now*, not just what it finished.

The snapshot filters system noise (runtime-context blocks, `<system-reminder>` payloads,
plugin-injected messages and other non-user sources) so the side agent sees the
conversation rather than harness plumbing. It is capped; when the parent did a lot after
the boundary, the most recent activity is kept and older items are marked as omitted.

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
- One side session exists per parent session. Clicking the button again after closing
  starts a new one; the old one cannot be reopened.
- The side session owns its own persisted log on disk. The main session's log is untouched.
- Host handles live in memory. A page refresh or a GUI restart loses the panel binding even
  though the process may still hold the agent; treat a refresh as the end of that side chat
  (see Known limitations).
- The panel does not attach to the session through the generic client `sessions` service:
  a parentless subagent-origin session is not addressable there. Its only message source is
  the host's read-only `/side-chat/api/snapshot` route, which answers for sessions this
  plugin created and returns `not-found` for anything else — the panel cannot read other
  sessions.

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
- Concurrency: a side chat and its parent can act at the same time, and there is no extra
  file lock between them. Avoid editing the same file from both at once.

## Panel behavior

- Floating panel at the right edge, `min(460px, 46vw)` wide, above the main UI.
- Header: status dot (idle/running), title and close button.
- Messages: user bubbles with timestamps; assistant Markdown (reasoning folded, tool calls
  folded with their results); running indicator; pending messages; error banner. Markdown
  uses the shell's renderer when available and a built-in fallback otherwise.
- Composer: `Enter` sends, `Shift+Enter` inserts a newline. The send button becomes
  **Stop** while a turn is running and the composer is empty; typing a draft turns it back
  into Send, and the message queues behind the running turn.
- Sent messages show optimistically until the committed transcript echoes them.
- The message list follows the newest message while you stay at the bottom; scrolling up
  stops the auto-follow.
- Panel state is per session: opening the side chat for another session replaces the visible
  panel, and each session keeps its own transcript state until closed. The header button is
  disabled while that session's panel is open — close it with the panel's × button.

### How messages reach the panel

The panel polls the host (`/side-chat/api/snapshot`) — roughly every 0.4 s while the side
agent runs and every 1.5 s when idle — and renders **committed** session events. A reply
appears when the assistant message commits, not token by token; the running indicator and
the optimistic pending bubble cover the in-between state. Polling pauses while the browser
tab is hidden and resumes when it becomes visible again.

## Token cost

The side session sends the inherited history with its first request, so that request is
roughly as large as the parent's next request. Each side chat then grows on its own —
turns in the main session after creation are not added to it. Treat the first message as
"one extra parent-sized request" when estimating cost.

## Approval behavior

The side session inherits the parent's approval policy. With a `never` policy (for example
the `danger-full-access` preset) tools run without prompts.

With a policy that asks the human, the approval prompt is **not rendered inside the side
panel**, and the side agent waits for an answer that the panel cannot give. Until approval
surfacing ships (P1), use a profile/preset whose policy does not require interactive
confirmation for side chats that need to write files or run commands.

## Lifecycle and destruction

| action | effect |
|---|---|
| click 「侧边会话」 | client state only; the panel opens, no agent |
| first send | create: fork seed, snapshot, boundary message, agent |
| close (×) | client clears state, then calls `close`; host removes the handle before disposing it |
| close during a running turn | dispose cancels the turn; the handle is gone |
| close result | the agent is disposed; the host then deletes the side session's own persisted directory itself with `node:fs/promises.rm` (best effort, guarded to that directory) |
| reopen | not possible; a new click starts a new side session |

Disposal always happens; artifact deletion is best effort. If the persistence service
service is unavailable, or the sandbox refuses the delete, close still succeeds and only
leaves the side session's own artifact on disk as an orphan — it is never shown in the GUI
or the session list, and the main session and workspace are never affected. A racing
`close`/`prompt` returns `not-found` rather than double-freeing.

## Compatibility

- Verified target: DSH `0.2.1-rc.2`, Desktop profile, Web GUI. Verified in an isolated copy of
  the desktop profile: the plugin launches, the seven host routes answer, and the client
  bundle is served.
- Web platform only. There is no CLI/TUI UI for the panel; the host routes exist whenever
  the profile loads the plugin.
- `package.json` declares no `engines.dsh` and no DSH peer dependency, so DSH does not
  version-gate installation. That is not a compatibility promise: newer DSH versions are
  untested. `dsh.plugin.json` records the tested DSH version as metadata only; DSH does not
  read that file.
- Node.js `>= 22` for the repository tooling; the plugin code itself is dependency-free
  ESM.
- The host and client halves share no imports, only the JSON routes in
  [CONTRACT.md](CONTRACT.md).

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

**The session header has no 「侧边会话」 button.**

1. Confirm the bundle is composed: `dsh --profile <name> --dump-config | grep -A2 dsh-side-chat`.
   If nothing shows, the package is not in `dsh.profile.bundles`; re-run the install command
   for the profile you actually run (`desktop` for the Desktop app, `web` for a web process).
2. Restart DSH. A change made while the profile was running is not guaranteed to load
   without a restart, and the `web` profile is startup-only.
3. Check that the client half loaded: the Plugins page (or the plugin inventory) should
   list the `dsh-side-chat` row as active; browser devtools show a client import error if it
   did not.

**The panel opens but the first message fails.**

The panel shows an error banner with the host's error code. `create-failed` means the fork
or agent creation rejected — check the DSH log. `not-found` means the parent session is
gone (closed, or the GUI reloaded): close the panel and start a new side chat.
`unknown-source` means the session id the button used no longer exists.

To check the host half directly, call a route with an empty body; a live plugin answers
`{"ok":true,...}`:

```bash
curl -s -X POST "<dsh-web-base-url>/side-chat/api/list" \
  -H 'Content-Type: application/json' -d '{}'
```

**The side chat seems stuck.**

It may be waiting for an approval its policy requires the human to answer (see the
approval section), or a tool is still running. Press Stop to cancel the turn.

**A refresh lost the side chat.**

Expected in this phase: host handles are in memory and the panel binding is not restored.
Close the panel and open a new side chat.

**A reply appears all at once instead of streaming.**

Expected: the panel renders committed session events from the snapshot route, so an
assistant message shows up when the turn commits. The running indicator shows progress in
the meantime.

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

- **Approval prompts are not surfaced in the panel.** See above.
- **A side chat cannot be reopened.** Closing destroys it; a refresh or GUI restart loses
  the panel binding.
- **Artifact deletion is best effort.** The agent is always disposed, but the side session's
  own session log can be left on disk as an orphan when removal fails.
  It is never listed in the GUI or session list.
- **Replies are not token-streamed.** The panel polls committed events; an assistant reply
  appears when its message commits, with a running indicator before that.
- **One visible panel at a time.** Each session keeps its own side-chat state, but opening
  the side chat for another session replaces the visible panel. The session-header button
  is disabled while that session's panel is open.
- **History is not refreshed.** The snapshot is taken once, at creation.
- **P1 items are designed but not implemented:** model picker for the side session,
  multiple concurrent side chats per parent, side-session history across a GUI restart,
  approval rendering in the panel.
- **One side session per parent session** in this phase.
- The panel is Web-only, and the plugin is not a replacement for the native conversation UI.

## File map

| file | role |
|---|---|
| `lib/index.js` | host half: `webServer` routes, fork seed + recent-context snapshot, boundary injection, per-source session registry, close/dispose |
| `lib/client.js` | client half: session-header button, `shell.overlay` panel, snapshot rendering, composer, RPC calls |
| `cordis.patch.yml` | bundle patch inserting the `dsh-side-chat` loader row |
| `package.json` | `dsh.bundle.patch`, `dsh.client` (web platform), package identity, `node >= 22` |
| `dsh.plugin.json` | community manifest metadata; DSH itself does not read this file (see the README) |
| `scripts/install.mjs` | idempotent local installer/remover with `--dry-run` |
| `tests/` | `node --test` unit tests for the host and client halves |

## Related documents

- [README](../README.md) — positioning, comparison, quick start.
- [DESIGN.md](DESIGN.md) — scope, phases and adversarial notes.
- [CONTRACT.md](CONTRACT.md) — routes, slots and rendering contract.
- [API-NOTES.md](API-NOTES.md) — the DSH `0.2.1-rc.2` API findings behind the implementation.
