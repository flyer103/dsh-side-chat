# Contract — dsh-side-chat (v0.1.0)

Two halves, one JSON RPC surface. The host half is a plain ESM Cordis plugin; the client
half is a browser ModuleLoader bundle. They never share imports — only these routes.

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

## Host → routes (registered on `ctx.webServer`, all `POST`, JSON in / JSON out)

| path | request | response |
|---|---|---|
| `/side-chat/api/create` | `{ sourceId }` | `{ ok: true, sessionId, inheritedEventCount }` \| `{ ok: false, code, message }` |
| `/side-chat/api/prompt` | `{ sessionId, text }` | `{ ok: true }` \| `{ ok: false, code, message }` |
| `/side-chat/api/cancel` | `{ sessionId }` | `{ ok: true }` \| `{ ok: false, code }` |
| `/side-chat/api/close` | `{ sessionId }` | `{ ok: true }` \| `{ ok: false, code, message }` |
| `/side-chat/api/status` | `{ sessionId }` | `{ ok: true, status, running, queue: [{ id, text, placement }], lastError }` \| `{ ok: false, code }` |
| `/side-chat/api/snapshot` | `{ sessionId, fromSeq? }` | `{ ok: true, inheritedEventCount, running, status, lastError, entries }` \| `{ ok: false, code }` |
| `/side-chat/api/list` | `{}` | `{ ok: true, sessions: [{ sessionId, sourceId }] }` |

`snapshot` is the client's only message source. `entries` are committed session events whose
`seq >= max(inheritedEventCount, fromSeq ?? inheritedEventCount)`, shaped
`{ seq, type, time, data, surfaceOp?, sourceEventSeqs? }`; the fork history and the
boundary message live below that floor and are never re-sent. The route **only** serves
sessions this plugin created (`not-found` otherwise), so it cannot read other sessions.
Uncommitted streaming chunks are not part of the contract: the panel shows a running
indicator and renders each assistant message when it commits.

Error codes: `unknown-source`, `not-found`, `empty-prompt`, `create-failed`,
`prompt-failed`, `dispose-failed`, `internal`.

`create` is idempotent per `sourceId` (a second call returns the existing session). `close`
removes the handle before disposing so a racing call gets `not-found`, never a double free.

## Client ↔ host call

`POST <path>` with `Content-Type: application/json`, body `JSON.stringify(args)`. Non-2xx or
`ok !== true` is an error. No auth headers: same-origin only.

## Client integration (right Sidebar tab, no standalone button)

The side chat is a native tab type of the right Sidebar, opened from that column's guide
page — the same public path every shipped tab uses (`ctx.sidebarRightTabs.register` +
`ctx.slots.register`). There is no session-header button and no floating overlay.

| registration | value | purpose |
|---|---|---|
| `ctx.sidebarRightTabs.register` | `{ id: pkg, kind: 'side-chat', priority: 'extension', title, guide: [{ id: 'side-chat', order: 10, title, description }], keepMounted: true }` | tab type + guide entry |
| `ctx.slots.register` | `{ name: 'sidebar.right.pane.tab', key: pkg }` | tab body (message flow + composer) |
| `ctx.slots.register` | `{ name: 'sidebar.right.pane.tab.title', key: pkg }` | tab chip title (optional) |
| `ctx.sidebarRight.registerCloseHandler` | `('side-chat', (sessionId) => close)` | closing the tab destroys the side session |

- One tab per parent session and pane (page-tab dedupe, no `multiple`); `keepMounted` keeps
  scroll position and draft across tab switches.
- Polling is gated by the tab's `visible` flag from `useTabInfo()`: collapsing the column or
  switching tabs pauses polling and keeps the side session; closing the tab destroys it.
- Body props: `sessionId` (parent session) plus the framework-injected `useTabInfo()`.

## Rendering contract (client)

- The panel renders exclusively from `/side-chat/api/snapshot` (polled): `running` → ~400 ms,
  idle → ~1500 ms, stopped while the panel is closed or the page is hidden. `fromSeq` starts
  at the fork floor (`inheritedEventCount`) and advances to `max(seen seq) + 1`.
- Fold `entries` into rows with pure functions: `user/message` (`data.source` / `data.content`),
  `assistant/message` (`data.message.content` blocks: `text`, `reasoning`, `tool-call`),
  `tool/call`, `tool/result` (`data.message.source.callId`, `content`, `isError`), plus small
  tags for `context` / `steering`. Unknown event types are ignored, never thrown on.
- Hide rows below the fork floor (`seq < inheritedEventCount`) and the injected boundary
  message (`source.kind === 'plugin:side-chat'`, or text starting with
  `Side conversation boundary.`).
- Uncommitted streaming chunks are out of contract: while running the panel shows a thinking
  indicator, and each assistant message renders in full once committed.
- Composer: own textarea; `Enter` sends, `Shift+Enter` newline; send button becomes Stop
  while running; optimistic pending rows disappear when the same text echoes back from
  `entries`.
- Assistant bodies prefer the shell's `MarkdownText`; a lightweight built-in renderer is the
  fallback when that module is unavailable.

## Localization contract (client)

- The panel follows the DSH locale service (`ctx.locale`); the plugin never keeps its own
  language preference.
- Namespace: `side-chat`; two dictionaries registered with the untyped single-locale form —
  `ctx.locale.register(NS, 'zh', ZH)` and `ctx.locale.register(NS, 'en', EN)`. Built-in locale
  ids are exactly `zh` and `en`; other languages resolve through the DSH fallback chain to
  `en`, so the plugin implements no fallback of its own.
- The `zh` and `en` dictionaries must expose the identical key set with non-empty values.
- Localized surfaces: tab type title, guide entry title/description (thunks, re-read on every
  projection), tab chip title, status bar, empty state, composer placeholder, send/stop
  labels, thinking indicator, reasoning/tool fold titles, pending-message state, context and
  steering tags, and error text keyed by host error code.
- Not localized (deliberately): host error `message` detail, route paths, tool names, event
  types, package and slot ids. Host messages are rendered as a monospace technical detail on
  a second line under the localized error sentence.

## Boundary prompt (host, exact first line)

The injected user message must start with `Side conversation boundary.`; the panel also
accepts the `plugin: side-chat` source as the hiding marker. Unlike Codex `/side` and
`dsh-side-session`, the prompt **allows real mutations** in the same workspace.
