# Contract — dsh-side-chat (v0.5.0)

Two halves, two surfaces: a JSON RPC surface plus one server-push event stream. The host
half is a plain ESM Cordis plugin; the client half is a browser ModuleLoader bundle. They
never share imports — only these routes.

## Plugin identity

| item | value |
|---|---|
| package name | `@flyer103/dsh-side-chat` |
| host module | `lib/index.js` (`export const name`, `export const inject`, `export function apply(ctx)`) |
| client bundle | `lib/client.js`, served by the client module loader; loader id = package name |
| bundle patch | `cordis.patch.yml` → `insert: [{ id: dsh-side-chat, name: '@flyer103/dsh-side-chat' }]` |
| CSS prefix | `sc-` |
| boundary source marker | `{ kind: 'plugin:side-chat' }` (V4 producer kind; `kind: 'plugin'` is retired) |
| side session id prefix | `side-chat-` |

## Host → JSON routes (registered on `ctx.webServer`, all `POST`, JSON in / JSON out)

| path | request | response |
|---|---|---|
| `/side-chat/api/create` | `{ sourceId, instanceKey? }` | `{ ok: true, sessionId, inheritedEventCount }` \| `{ ok: false, code, message }` |
| `/side-chat/api/prompt` | `{ sessionId, text }` | `{ ok: true }` \| `{ ok: false, code, message }` |
| `/side-chat/api/cancel` | `{ sessionId }` | `{ ok: true }` \| `{ ok: false, code }` |
| `/side-chat/api/close` | `{ sessionId }` | `{ ok: true }` \| `{ ok: false, code, message }` |
| `/side-chat/api/status` | `{ sessionId }` | `{ ok: true, status, running, queue: [{ id, text, placement }], lastError }` \| `{ ok: false, code }` |
| `/side-chat/api/snapshot` | `{ sessionId, fromSeq? }` | `{ ok: true, inheritedEventCount, running, status, lastError, entries, truncated, live }` \| `{ ok: false, code }` |
| `/side-chat/api/list` | `{}` | `{ ok: true, sessions: [{ sessionId, sourceId }] }` |

`snapshot` and the live stream below are the client's message sources. `entries` are
committed session events whose `seq >= max(inheritedEventCount, fromSeq ?? inheritedEventCount)`,
shaped `{ seq, type, time, data, surfaceOp?, sourceEventSeqs? }`; the fork history and the
boundary message live below that floor and are never re-sent. `live` is the in-flight
assistant attempt (see the stream section), included so the polling fallback can also render
in-progress tokens; it is `null` when no attempt is streaming. Both routes **only** serve
sessions this plugin created (`not-found` otherwise), so they cannot read other sessions.
A parent session may own several side sessions (one per `instanceKey`), so `list` can return
multiple entries with the same `sourceId`; each side session is still addressed by its own
`sessionId`.

Error codes: `unknown-source`, `not-found`, `empty-prompt`, `create-failed`,
`prompt-failed`, `dispose-failed`, `internal`.

`create` is idempotent per identity: the opaque `instanceKey` when a non-empty one is sent,
otherwise the legacy identity `source:<sourceId>`. A repeated call for the same identity
returns `{ ok: true, sessionId, inheritedEventCount }` for the existing side session, and
concurrent calls are deduplicated onto one create. Different instance keys under one
`sourceId` are independent side sessions; an absent or empty key keeps the old
one-side-session-per-parent behavior. Because the client keeps a stable per-tab identity,
a retried `create` — or a reload that reissues the same tab identity — reattaches to the
still-running host-side session instead of creating another. `close` removes the handle
before disposing so a racing call gets `not-found`, never a double free.

## Host → live stream (`POST /side-chat/api/events`)

Request `{ sessionId, fromSeq? }`. On success the answer is not JSON: HTTP 200 with
`Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`,
`Connection: keep-alive`, and `X-Accel-Buffering: no`. The body is SSE
(`event: <name>\ndata: <json>\n\n`):

| frame | data | meaning |
|---|---|---|
| `hello` | `{ ok: true, inheritedEventCount, status, running, lastError, entries, truncated, live }` | opening baseline; same floor and `entries` rule as `snapshot` |
| `event` | `{ entry }` | one newly committed session event above the baseline, in `seq` order |
| `live` | `{ live }` | authoritative replacement of the in-flight assistant attempt |
| `status` | `{ status, running }` | agent lifecycle change |
| `error` | `{ message }` | last contained agent failure |

`live` is `null` or `{ revision, activeAttempt }`. `activeAttempt` is `null` or
`{ attemptId, turn, step, nextIndex, blocks }`: `revision` is the dense assistant-stream
revision, `nextIndex` the number of chunks folded into the attempt, and `blocks` the ordered
renderable prefix of the current attempt —
`{ kind: 'text', text }`, `{ kind: 'reasoning', text }`, or
`{ kind: 'tool-call', callId, name, argsRaw }` (`argsRaw` is the accumulated argument text).
It is presentation data only; the durable settlement is still the committed
`assistant/message` / `assistant/attempt` event. A revision gap invalidates the attempt (the
client re-baselines on reconnect or from `snapshot`). The host clears the attempt as soon as
the matching settlement commits: it emits `live: null` and then forwards that committed
event's `event` frame, in that order; an `end` frame with an `abandoned` outcome clears it
too. A `: ping` comment is sent about every 15 s.

If the stream cannot open, the host answers a normal JSON 200 `{ ok: false, code, message }`
instead — `not-found` for a session it does not own, `internal` for an unparsable body — so
the client can fall back to polling. The client aborts the request when the tab becomes
hidden or closes and reconnects later from `fromSeq`; a reconnect `hello` carries the
in-flight `live` baseline, so text streamed while the tab was hidden is recovered.

## Client ↔ host call

JSON routes: `POST <path>` with `Content-Type: application/json`, body `JSON.stringify(args)`.
Non-2xx or `ok !== true` is an error. The live stream keeps the same POST + JSON request but
reads the response body incrementally (`fetch` + `ReadableStream` + `TextDecoder`) and parses
SSE frames; an `AbortController` stops it. Each side-chat tab owns the stream for its own
side session, so several tabs of the same parent session hold independent connections. No
auth headers: same-origin only. When the body is not readable, or no `hello` arrives within
~2.5 s (a buffering transport), the client degrades that tab to `snapshot` polling and does
not mix the two paths.

## Client integration (right Sidebar tab, no standalone button)

The side chat is a native tab type of the right Sidebar, opened from that column's guide
page — the same public path every shipped tab uses (`ctx.sidebarRightTabs.register` +
`ctx.slots.register`). There is no session-header button and no floating overlay. The tab
type is registered with `multiple: true`, so one parent session can hold several side-chat
tab instances in the same pane; each instance owns its own side session. The guide entry
and the tab's status-bar new-side-chat button each open a fresh instance.

| registration | value | purpose |
|---|---|---|
| `ctx.sidebarRightTabs.register` | `{ id: pkg, kind: 'side-chat', multiple: true, priority: 'extension', title, guide: [{ id: 'side-chat', order: 10, title, description }], keepMounted: true }` | tab type + guide entry |
| `ctx.slots.register` | `{ name: 'sidebar.right.pane.tab', key: pkg }` | tab body (message flow + composer) |
| `ctx.slots.register` | `{ name: 'sidebar.right.pane.tab.title', key: pkg }` | tab chip title (plain, or numbered for later instances) |
| `ctx.sidebarRight.registerCloseHandler` | `('side-chat', (sessionId, tab) => close)` | closing the tab destroys only that tab's side session |

- One side session per tab instance, not per parent session. The client derives an opaque
  per-tab identity `${sourceId}#${tabId}` from the parent session id and the tab instance
  id, keys its per-tab runtime record by that identity, and sends it as `instanceKey` on
  `create`; a parent session can therefore drive several side chats concurrently. Chips are
  numbered per parent session: the first instance uses the plain localized title, later
  instances the indexed key `tab.titleIndexed` (`Side chat {index}` / `侧边会话 {index}`).
- The guide card opens a new side chat on every activation rather than focusing an existing
  tab, and every tab's status bar carries a new-side-chat button (locale key `tab.new`) that
  opens another side-chat tab in the same pane.
- `keepMounted` keeps each tab's own scroll position and draft across tab switches.
- Live updates are gated by each tab's own `visible` flag from `useTabInfo()`: collapsing
  the column, switching tabs, or hiding the browser tab aborts that tab's event stream (or
  pauses polling in fallback mode) and keeps the side session; closing the tab destroys only
  that side session and leaves the other side chats and the parent session untouched.
- Body props: `sessionId` (parent session) plus the framework-injected `useTabInfo()`; the
  tab instance id from `useTabInfo()` is what makes the identity per-tab.

## Rendering contract (client)

- The panel has two update paths and never runs both at once: the live `events` stream when
  it is available, else `/side-chat/api/snapshot` polling (`running` → ~400 ms, idle →
  ~1500 ms). Both are stopped while the panel is closed or the page is hidden. `fromSeq`
  starts at the fork floor (`inheritedEventCount`) and advances to `max(seen seq) + 1`.
- Tab chip title and new side chat: the title slot renders the plain localized title for the
  first side chat of a parent session and the indexed key `tab.titleIndexed`
  (`Side chat {index}` / `侧边会话 {index}`) for later ones, numbered per parent session.
  The tab status bar carries a new-side-chat button (locale key `tab.new`) that opens
  another side-chat tab in the same pane. Neither depends on a side session existing:
  opening a tab does no host work.
- Fold `entries` into rows with pure functions: `user/message` (`data.source` / `data.content`),
  `assistant/message` (`data.message.content` blocks: `text`, `reasoning`, `tool-call`),
  `tool/call`, `tool/result` (`data.message.source.callId`, `content`, `isError`), plus small
  tags for `context` / `steering`. Unknown event types are ignored, never thrown on.
- Hide rows below the fork floor (`seq < inheritedEventCount`) and the injected boundary
  message (`source.kind === 'plugin:side-chat'`, or text starting with
  `Side conversation boundary.`).
- The in-flight attempt (`live.activeAttempt`) renders after the committed rows as a normal
  assistant row: reasoning and tool folds, tool arguments, and Markdown rendered with the
  shell renderer's `streaming` flag. It is hidden when there is no active attempt or when
  every assembled block is empty. When the attempt settles, the committed
  `assistant/message` replaces it; the client reconciles on the `live: null` frame (and
  defensively on a matching settlement `event`), issuing one snapshot catch-up so a
  settlement is never lost. The thinking indicator shows only while a turn runs with no
  visible live blocks.
- Composer: own textarea; `Enter` sends, `Shift+Enter` newline; send button becomes Stop
  while running; optimistic pending rows disappear when the same text echoes back from
  `entries`.
- Assistant bodies prefer the shell's `MarkdownText`; a lightweight built-in renderer is the
  fallback when that module is unavailable (it ignores `streaming`).

## Localization contract (client)

- The panel follows the DSH locale service (`ctx.locale`); the plugin never keeps its own
  language preference.
- Namespace: `side-chat`; two dictionaries registered with the untyped single-locale form —
  `ctx.locale.register(NS, 'zh', ZH)` and `ctx.locale.register(NS, 'en', EN)`. Built-in locale
  ids are exactly `zh` and `en`; other languages resolve through the DSH fallback chain to
  `en`, so the plugin implements no fallback of its own.
- The `zh` and `en` dictionaries must expose the identical key set with non-empty values.
- Localized surfaces: tab type title, guide entry title/description (thunks, re-read on every
  projection), tab chip title (plain, or `tab.titleIndexed` for later side chats of the same
  parent), the status-bar new-side-chat button (`tab.new`), status bar, empty state, composer
  placeholder, send/stop labels, thinking indicator, reasoning/tool fold titles,
  pending-message state, context and steering tags, and error text keyed by host error code.
- Not localized (deliberately): host error `message` detail, route paths, tool names, event
  types, package and slot ids. Host messages are rendered as a monospace technical detail on
  a second line under the localized error sentence.

## Boundary prompt (host, exact first line)

The injected user message must start with `Side conversation boundary.`; the panel also
accepts the `plugin: side-chat` source as the hiding marker. Unlike Codex `/side` and
`dsh-side-session`, the prompt **allows real mutations** in the same workspace.
