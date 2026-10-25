# Design — dsh-side-chat

## Positioning

A DeepSeek Harness (DSH) profile plugin that gives the Web GUI **side chats** for the
current session: ephemeral, context-inheriting conversations that can **really modify
files** while the main thread keeps running, without writing anything into the main
session transcript.

Delta against the existing community plugins:

| Plugin | can modify files | inherits in-flight context | ephemeral |
|---|---|---|---|
| `Lukknow0/dsh-side-chat` | no (read-only QA) | yes | yes |
| `Diluka/dsh-side-session` | no (prompt forbids mutation) | yes (live-log snapshot) | yes |
| `Yur0918/dsh-sidepanel` | no (read-only persona side chat) | fork only | no |
| **this plugin** | **yes — full tool chain in the same workspace** | **yes** | **yes** |

## P0 (this phase)

1. **Entry**: the plugin registers a native tab type of the right Sidebar (`kind: side-chat`,
   `multiple: true`) plus a guide entry, so it is reached through the session header's "Open
   sidebar" control rather than a standalone button. Each activation of the guide entry, and
   each press of the tab status bar's new-side-chat button, opens another tab instance.
   Opening a tab performs no agent/fork work.
2. **Lazy creation**: the side session is created on the first submitted message.
3. **Context inheritance**: seed = the parent's event prefix through its last completed
   turn (`turn/end`); plus a live-log snapshot of everything committed after that boundary
   (in-flight user/assistant messages, tool calls) appended as reference context.
4. **Same agent**: `agentPresets.composeFrom` joins the parent's preset, so tools, skills,
   prompt sections and permission rows match; `cwd`, provider/model, sandbox mode and
   approval policy are inherited.
5. **Real mutations**: the boundary + developer instructions explicitly allow
   `write`/`edit`/`bash`-driven changes in the same working directory. Mutations are real;
   they are never mirrored into the main session.
6. **Isolation**: `origin: 'subagent'` keeps the side sessions out of the session list; no
   `parentSession` (avoids the subagent catalog). One side session per tab instance: a
   parent session may hold several side chats concurrently, and none of them is visible in
   the session list or the subagent catalog.
7. **Lifecycle**: closing one side-chat tab disposes that tab's side session and then
   best-effort deletes its persisted artifact (a failed removal is logged; the close still
   succeeds and the orphan never appears in any list). Other side chats and the main session
   are untouched; a closed side chat cannot be reopened.
8. **UI**: each side chat lives in its own right-Sidebar tab instance (body fills the
   column): user bubbles + assistant markdown, reasoning fold, tool chips with results,
   **token-streamed assistant output**, running/thinking state, optimistic pending messages,
   Stop, auto-follow scrolling, `Enter` send / `Shift+Enter` newline. Tab chips are numbered
   per parent session (plain title for the first, `Side chat 2` / 「侧边会话 2」… for later
   ones), and the status bar has a new-side-chat button. Collapsing the column or switching
   tabs pauses the live updates and keeps the sessions; closing a tab destroys only that
   tab's side session.
9. **Streaming**: the host folds `agent/assistant-stream` frames into a per-side-session live
   attempt and pushes it (plus committed events, status and errors) over
   `POST /side-chat/api/events` (SSE). The tab renders the active attempt as a normal
   assistant row while it streams and swaps in the committed message when it settles. When a
   stream cannot be established — no readable body, JSON refusal, or a transport that buffers
   the response — the tab degrades to the existing `snapshot` polling, which also carries the
   live attempt. Hiding the tab aborts the stream; showing it reconnects from the last seen
   sequence with a fresh live baseline. Live state and streams are per side session, so
   several tabs of one parent session stream independently.
10. **Usage dock**: a slim row under the composer — the same relationship as DSH's own
    composer dock — with total tokens, cache-hit percentage, and a context-occupancy ring
    plus percentage. Values are folded client-side from the committed events the tab already
    receives (assistant/message and assistant/attempt usage, the settlement's stream usage
    chunk as fallback, replacement on a same-turn/step retry). The token and cache totals
    count only what the side chat itself billed — its own requests, including the inherited
    prefix its first request re-sends — and never the parent's earlier usage, whose events are
    below the fork floor; context occupancy is absolute for the same reason, and approximate.
    The host contributes exactly one optional, additive `contextWindow` to the existing
    snapshot and SSE `hello` payloads so a seeded side session can show the denominator it
    usually never appends itself. Native tooltips carry the exact bucket counts (with a
    cache-write segment when the provider reports it) and `~used / window`; there are no
    dialogs, turns, steps or tok/s, no new route, no extra polling, and no config option.

## P1a — `@file` references (this phase)

The side-chat composer adopts the primary composer's file-reference flow: `@` opens a
workspace path menu for the side chat's inherited working directory, and a pick inserts the
same prompt text the primary composer would insert. Model-side semantics are already in
place — `file-reference-local` installs the stable `FILE_REFERENCE_PROMPT` section on every
agent that can call `read`, so a side chat receives the same `@path` guidance as the main
session. This phase therefore adds discovery, insertion and presentation only; it changes no
prompt, no DSH contract and adds no dependency.

### In scope

1. **Host route** `POST /side-chat/api/references` — a read-only, workspace-bounded path
   candidate lookup backed by the host's optional `ctx.fileReferences` service. The route
   exists for side sessions the plugin owns and for the parent session before the side
   session exists.
2. **Composer completion** — typing `@` at the start of input or after whitespace opens a
   candidate menu for the side chat's working directory; typed text narrows it; `@"` opens a
   quoted path that may contain spaces.
3. **Insertion** — the pick replaces the active token with exactly the spelling the primary
   composer produces (`@path`, `@"path with spaces"`, `@dir/`, `@"dir/` when the quote stays
   open), leaving the caret after it. A directory pick keeps completion open inside that
   directory.
4. **IME safety** — no completion request and no send while an input-method composition is
   in progress; `Enter` never submits a half-composed message.
5. **Chips** (presentation only) — committed user bubbles render file/folder references as
   chips using the same token grammar; no click action, no sidebar navigation.
6. **Graceful absence** — a profile without `ctx.fileReferences` simply has no menu; plain
   `@` text still sends (without that provider the model also gets no reference guidance
   section, which is upstream of this plugin).

### Out of scope

- `@session` references, `/` commands and the skill menu, attachments/images, drag & drop,
  model picker, approval rendering, plan mode (P1b).
- Reading or attaching file content; a reference is text the model must resolve with `read`.
- Clicking a chip to open the file in a sidebar; chip menus, directory drill UI beyond the
  continuation described above, per-profile configuration.
- Any change to the parent session, the fork boundary, or the DSH prompt/compose contract.

### Contract sketch

`CONTRACT.md` is the shipped wire contract and stays authoritative once this lands; the
sketch below fixes the semantics for review.

| path | request | response |
|---|---|---|
| `/side-chat/api/references` | `{ sourceId?, sessionId?, query }` | `{ ok: true, candidates: [{ path, kind: 'file' \| 'directory' }] }` \| `{ ok: false, code, message? }` |

- Exactly one of `sessionId` / `sourceId` must be usable. `sessionId` must name a side
  session this plugin created; `sourceId` must name a live agent (the parent) and covers the
  window before the first message creates the side session. When both are sent, `sessionId`
  wins.
- Discovery is bounded by the addressed agent's working directory; `query` is the text after
  `@` and is passed through unchanged. Only path candidates are returned — no file content,
  no size/type metadata.
- The provider is optional: `ctx.get('fileReferences')` absent or degraded answers
  `code: 'unavailable'`; the client then hides the menu for that tab.
- Errors: `unknown-source` (no such live parent), `not-found` (session not owned by this
  plugin), `bad-request` (non-string or over-long query, missing identity), `unavailable`,
  `internal`.
- The route keeps no cache and no durable state; the existing 1 MB request-body cap applies;
  `query` is capped at 512 characters. Requests abort their provider lookup when the client
  disconnects, so fast typing does not leave workspace scans running.

### Editor flow

- **Grammar**: the client replicates the browser-safe `activeAtToken` / `formatFileMention`
  behaviour (~60 lines with attribution) because the hand-written bundle cannot require
  `@deepseek-ai/dsh-file-reference/grammar` (not a client package). Unit tests pin the
  behaviour: token only at line start/after whitespace, `@` inside a word (an email) does not
  trigger, quoted paths, unsafe characters rejected.
- **Replaced range**: `[token start, caret]` on the current line. A file pick finishes the
  token; a directory pick inserts the trailing slash and keeps the menu open on the resulting
  query.
- **Fetch**: 120 ms debounce, exactly one request in flight per tab, the previous request
  aborted, monotonic request id drops stale answers. `sessionId` is sent only after the side
  session exists; before that the request carries the parent `sourceId`.
- **Menu**: rendered at the top of the composer card, above the textarea (no portal, no new
  dependency),
  listbox semantics with `aria-activedescendant`, Up/Down wrap, Enter/Tab pick, Escape close,
  click pick; mousedown on a row keeps textarea focus; a pick never submits. A loading or
  empty menu has nothing to pick, so Enter closes it and submits while Up/Down/Tab stay inert.
- **Chips**: committed user rows tokenize file and folder references with the primary
  reference rule (including trailing punctuation trimming) and render text nodes; the chip
  carries no click handler and no HTML injection.

### Acceptance

- Before the first message and after it, typing `@` in a side-chat tab lists paths of the
  parent workspace; typing narrows; Enter inserts the path and the send carries it; the model
  reads the referenced file (no content is sent by the pick).
- `@"` works for paths with spaces; selecting a directory inserts `@dir/` (or an open quoted
  form) and immediately lists that directory's children.
- A profile without the file-reference provider shows no menu; `@` text still sends.
- Chinese IME: typing `@`/paths during composition opens no menu, `Enter` during composition
  does not send; after composition the next change behaves normally.
- Two side-chat tabs hold independent menu state and each queries against its own session.
- Existing tests, `npm run check` and `npm test` stay green; no main-session behavior changes.

### Adversarial notes (P1a)

- **Before `create` resolves**: the menu addresses the parent agent by `sourceId`, so the
  very first message can use a reference. A `create` racing a keystroke cannot make the route
  fail: the next request simply switches to `sessionId` once the session exists.
- **Parent disposed while the menu is open**: the route answers `unknown-source`; the client
  closes the menu and keeps the draft. Sending then reports the same `not-found` the panel
  already handles.
- **Tab hidden or closed mid-request**: the fetch is aborted and the stale answer dropped;
  the route holds no state to leak, and the provider lookup is cancelled on disconnect.
- **Out-of-order answers / retry**: debounce plus monotonic request id; only the newest answer
  matching the current token is rendered.
- **Directory continuation**: after a directory pick the caret sits after the trailing slash;
  the token remains active, so the follow-up lookup lists that directory without a second
  trigger gesture.
- **Route abuse**: the route is read-only, bounded by an agent's working directory, and
  returns names only. It accepts any live `sourceId`, the same trust boundary `create`
  already crosses (which creates an agent in that workspace); it never reads file content and
  never answers for sessions the plugin does not own.
- **Provider absent or slow**: `unavailable` is cached per tab; slow lookups are aborted by
  the next keystroke rather than queued.
- **Unsafe mentions**: `formatFileMention` rejects control characters and embedded quotes, so
  those candidates are not inserted (the raw text stands); the menu never renders candidate
  text as HTML.
- **IME + Enter + menu**: pick, send and close are mutually exclusive key paths; a composing
  Enter reaches neither pick nor send.
- **Two tabs**: menu state lives in the per-tab runtime record, not in module scope.

### Delivery slices

1. Host route + route tests (inert until the client uses it).
2. Client grammar, token replacement and their tests (no UI yet).
3. Client menu + debounced fetch + styles + locale keys + tests.
4. IME guard + reference chips + tests.
5. User docs (CONTRACT/USAGE/README) once behaviour lands; a version bump/release commit is
   separate and not part of this slice.

### Rollback

The route registration and menu rendering are additive. Reverting the slices removes them;
there is no persistence, schema or prompt change to migrate.

## P1b (designed, not implemented)

- Model picker for the side session.
- Surfacing the side session's **approval prompts** in the panel (today the side session
  inherits the parent's approval policy; if that policy asks the human, the request has no
  answerer inside the panel).
- Side-session history across a GUI restart (today: in-memory handles only).

## Non-goals

- Merging side-chat content back into the main transcript.
- Making the side session visible in the workspace/session list.
- Mutating git state (branch/commit/push) on the user's behalf.
- Replacing the native conversation UI.
- Click-open statistics dialogs, turn/step counts and tok/s in the v1 side-chat dock;
  matching DSH's Performance & usage detailed/compact preference.

## Adversarial notes

- **Crash mid-creation**: `agents.create` rejects; the client shows the error and keeps the
  panel empty. No half-registered handle is stored before `create` resolves.
- **Double send / double create**: `create` is idempotent per identity (the per-tab
  `instanceKey`, or `source:<sourceId>` when no key is sent) and concurrent creates share
  one in-flight result; the client also guards with a single in-flight send per tab. A
  reissued identity (a retry, or a reload that keeps the tab identity) reattaches to the
  still-running side session instead of creating a second one.
- **Close during a running turn**: `close` disposes only that side session's handle; the
  dispose path cancels its turn. Other side chats keep running, and the client stops
  polling status for that id.
- **Parent unloaded while the panel is open**: `prompt`/`status` return `not-found`; the panel
  shows the error instead of silently queueing.
- **Artifact deletion**: path comes from `sessionPersistence.locate(header)`; deletion runs
  with `node:fs/promises.rm` after a short drain delay, guarded to this plugin's own session
  directory (absolute path, `basename(dir) === session id`). A failed removal is logged and the
  close still disposes and succeeds; the orphan never appears in any list.
- **Token cost**: every side chat inherits the parent history, so its first request is
  roughly as large as the parent's next request; N concurrent side chats multiply that
  first-request cost. Stated in the README.
- **Usage-dock fidelity**: the dock duplicates only a small, deliberate subset of DSH's
  token/context projections. Its cache-hit share is rounded instead of using DSH's
  distinguishing decimal precision, its context reading is the newest provider prompt size
  without the `projectedTokens` surface-delta estimate (so it can trail the main bar by up to
  one step), and a retried step replaces its sample rather than being folded with DSH's exact
  semantics. The fold ignores unknown or malformed events instead of throwing, so a DSH event
  change degrades a reading rather than the panel; fixture-based tests guard the current
  event shapes.
- **Snapshot page truncation**: a tab that reattaches to an existing side session receives at
  most the trailing 2000 entries in its snapshot, so usage events older than that page are
  missing from its dock totals. A tab that is mounted from creation sees every committed
  event and is unaffected. This is accepted for ephemeral side chats and documented rather
  than fixed with a second route.
- **Additive `contextWindow`**: the one host-payload change is optional and additive.
  An older client ignores it; a newer client against an older host (or a session with no
  route context yet) simply omits the context reading. No new route, no polling change.
- **Fixed dock content**: following DSH's `performanceUsage` detailed/compact choice would
  mean reading another package's config (an internal `ctx.configForms` service) for a
  cosmetic decision, so the dock's content is fixed and the mismatch is documented.
- **Streaming state is presentation only**: live frames come from the process-local
  `agent/assistant-stream` feed and are never treated as durable history. A revision gap, a
  host restart, or a reconnect invalidates the live attempt; the client re-baselines from the
  `hello`/`snapshot` payload and the committed `assistant/message` stays authoritative.
- **Stream/committed duplication**: the loop commits the settlement before emitting its
  `end` frame, so the host clears the live attempt on the committed
  `assistant/message`/`assistant/attempt` and emits `live: null` immediately before it
  forwards that committed event's `event` frame. Both frames travel in the same paint, and
  the client also reconciles defensively and may do one snapshot catch-up, so a dropped
  frame cannot leave a stale streaming row or hide the final message.
- **Buffering transports**: the Desktop IPC bridge and some proxies can buffer a whole
  response. The client waits ~2.5 s for the `hello` frame and otherwise aborts the stream and
  falls back to polling; a stream that drops after its baseline reconnects with backoff, and
  two failed connects without a baseline degrade the tab to polling. A tab never runs both
  paths at once.
- **Concurrent stream connections**: each tab opens one stream for its own side session; the
  host fans a side session's frames out to every connection on it and cleans each one up on
  request close, session close, or plugin unload. Live state is kept per side session even
  when no stream is connected, so the snapshot fallback sees it too, and several side chats
  stream independently.

## Rollback

Remove the bundle row (or `dsh plugin remove`), restart DSH. No schema, no persistence
migration, no main-session writes.
