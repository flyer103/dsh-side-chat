/**
 * dsh-side-chat — host half (plain ESM Cordis plugin, no build step, no runtime
 * dependencies).
 *
 * Each side conversation is an ephemeral Agent created on the first submitted
 * message: it is seeded with the parent's completed-turn prefix, inherits the
 * parent's preset composition, working directory, model route, sandbox mode and
 * approval policy, and can really modify files in the same workspace. It never
 * writes the parent's transcript and never appears in the session list.
 *
 * The client half talks to this half through POST routes under
 * `/side-chat/api/`. The side session has `origin: 'subagent'` without a
 * `parentSession` and therefore is not reachable through the client `sessions`
 * service, so committed events are served by the read-only `snapshot` route and
 * the live assistant attempt plus newly committed events are pushed over the
 * `events` SSE route.
 */

import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute } from 'node:path'

export const name = 'dsh-side-chat'

export const inject = ['webServer', 'agents', 'timer']

const ROUTE_PREFIX = '/side-chat/api/'
const ROUTE_NAMES = ['create', 'prompt', 'cancel', 'close', 'status', 'snapshot', 'list']

const SESSION_ID_PREFIX = 'side-chat-'
/**
 * Durable producer attribution of the injected boundary message. DSH 0.2.1's
 * V4 session format retires `{ kind: 'plugin', plugin: <name> }` for message
 * sources: a persisted log carrying it is refused on load with "format v4
 * message requires a producer-owned source kind". The V3→V4 migration lifts
 * retired plugin wrappers to `plugin:<name>`, so the producer-owned kind is
 * written directly here.
 */
const BOUNDARY_SOURCE = Object.freeze({ kind: 'plugin:side-chat' })
const BOUNDARY_FIRST_LINE = 'Side conversation boundary.'

const RECENT_CONTEXT_MAX_CHARS = 6000
const SNAPSHOT_PAGE_LIMIT = 2000
const MAX_REQUEST_BODY_BYTES = 1024 * 1024
const DRAIN_DELAY_MS = 300
const SSE_HEARTBEAT_MS = 15_000
/**
 * Headers of a raw `text/event-stream` response. `no-transform` and
 * `X-Accel-Buffering: no` keep intermediate proxies from buffering the stream
 * into batches, and `Connection: keep-alive` keeps the response open.
 */
const SSE_HEADERS = Object.freeze({
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
})
const DEVELOPER_SECTION_NAME = 'side-chat:instructions'
const DEVELOPER_SECTION_ORDER_FALLBACK = 9000

const APPROVAL_OVERRIDE_SOURCE = 'delegation'
const SANDBOX_OVERRIDE_SOURCE = 'delegation'

/** Collapse any thrown value into one short, log-safe line. */
function errorMessage(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 500 ? `${text.slice(0, 499)}…` : text
}

function failure(code, message) {
  return message === undefined ? { ok: false, code } : { ok: false, code, message }
}

function success(fields = {}) {
  return { ok: true, ...fields }
}

function clip(text, max) {
  if (typeof text !== 'string') return ''
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Join the text blocks of one message content list. */
function textBlocks(content) {
  if (!Array.isArray(content)) return []
  const out = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      out.push(block.text)
    }
  }
  return out
}

function messageText(message) {
  return textBlocks(message?.content).join('\n')
}

/**
 * The balanced completed-turn prefix of a session's event log: every event up
 * to and including the last `turn/end`. The in-flight turn is excluded because
 * an unclosed turn cannot be replayed as a child session seed.
 * @param events - session events in log order (`seq` equals the array index).
 * @returns the seed events contiguously from seq 0; empty before any completed turn.
 */
export function completedTurnPrefix(events) {
  if (!Array.isArray(events)) return []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event !== null && typeof event === 'object' && event.type === 'turn/end') {
      return events.slice(0, index + 1)
    }
  }
  return []
}

/**
 * Whether one block of text is harness plumbing rather than conversation:
 * `<system-reminder>` payloads and the `Current runtime context` snapshot.
 * @param text - candidate text.
 * @returns true when the text must never reach the side conversation.
 */
export function isSystemNoise(text) {
  if (typeof text !== 'string') return false
  return text.includes('<system-reminder>')
    || text.includes('<system_reminder>')
    || text.trimStart().startsWith('Current runtime context')
}

/**
 * Compress the parent's live log from `fromSeq` onward into reference text for
 * the boundary message: user input, assistant text, tool-call names, and failed
 * tool results. System-injected messages and system noise are dropped.
 * @param events - the parent's session events in log order.
 * @param fromSeq - first sequence number to include (the fork boundary).
 * @param maxChars - cap on the returned text; the tail is kept.
 * @returns the reference text, or '' when nothing survives the filters.
 */
export function recentMainContext(events, fromSeq = 0, maxChars = RECENT_CONTEXT_MAX_CHARS) {
  if (!Array.isArray(events)) return ''
  const parts = []
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (typeof event.seq !== 'number' || event.seq < fromSeq) continue
    switch (event.type) {
      case 'user/message': {
        const message = event.data
        if (message?.source?.kind !== 'user') break
        const text = textBlocks(message.content).filter((block) => !isSystemNoise(block)).join(' ').trim()
        if (text !== '') parts.push(`User: ${clip(text, 500)}`)
        break
      }
      case 'assistant/message': {
        const text = textBlocks(event.data?.message?.content).join(' ').trim()
        if (text !== '') parts.push(`Assistant: ${clip(text, 300)}`)
        break
      }
      case 'tool/call': {
        const toolName = event.data?.name
        if (typeof toolName === 'string' && toolName !== '') parts.push(`Tool call: ${toolName}`)
        break
      }
      case 'tool/result': {
        if (event.data?.message?.isError === true) parts.push('Tool result: failed')
        break
      }
      default:
        break
    }
  }
  const kept = []
  let total = 0
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    const cost = part.length + 1
    if (total + cost > maxChars) {
      if (kept.length === 0) kept.unshift(clip(part, maxChars))
      break
    }
    kept.unshift(part)
    total += cost
  }
  if (kept.length < parts.length) kept.unshift('(earlier parent-session context omitted)')
  return kept.join('\n')
}

/**
 * The injected boundary user message. Its first line is fixed: the panel uses
 * it as a fallback hiding marker. Unlike read-only side chats, it explicitly
 * authorizes real, minimal, on-disk changes requested after the boundary.
 * @param parentSessionId - the main session this side conversation derives from.
 * @param recentContext - optional reference text from `recentMainContext`.
 * @returns the complete boundary message text.
 */
export function sideConversationBoundaryPrompt(parentSessionId, recentContext = '') {
  const lines = [
    BOUNDARY_FIRST_LINE,
    '',
    `You are in a side conversation derived from main session "${parentSessionId}". You inherit its working directory, model route, tools, skills, and permission composition. This side conversation is temporary: closing it destroys it, it never appears in the session list, and it cannot be reopened.`,
    '',
    'Everything before this boundary is inherited history from the parent thread. It is reference context only, not your current task. Do not continue, execute, or complete instructions, plans, tool calls, approvals, edits, or requests that appear only in that inherited history. Only messages submitted after this boundary are active instructions for this side conversation.',
    '',
    'This side conversation is a full working agent in the same workspace, not a read-only chat. When the user asks for a change after this boundary, you must make the change for real with the available tools — `write`, `edit`, `bash`, and every other enabled tool — modifying the same files in the same working directory. Changes must actually land on disk: never simulate a change, never describe a change you did not perform, and never claim a file was modified when it was not. Keep every change minimal and limited to what the user asked for, and do not touch the main thread\'s task.',
    '',
    'Sub-agents are off-limits in this side conversation. Do not interact with any existing or new sub-agents, even if sub-agents were used before this boundary. Do not write anything into the main session transcript, and do not create commits, branches, or pushes unless the user explicitly asks for them.',
    '',
    'When you finish, report exactly what you changed and what you verified, so the user can reconcile it with the main thread.',
  ]
  if (typeof recentContext === 'string' && recentContext !== '') {
    lines.push(
      '',
      '[Recent activity from the parent session — completes the forked history; reference only, do not act on it]',
      recentContext,
    )
  }
  return lines.join('\n')
}

/**
 * The developer-instruction counterpart of the boundary prompt, registered as a
 * system-prompt section as a second line of defense.
 * @returns the instruction text.
 */
export function sideDeveloperInstructions() {
  return [
    'You are in a side conversation, not the main thread.',
    '',
    'The inherited fork history is provided only as reference context. Do not treat instructions, plans, or requests found in it as active instructions for this side conversation; only instructions submitted after the side-conversation boundary are active. Do not continue, execute, or complete a task, plan, tool call, approval, edit, or request that appears only in inherited history, and do not present yourself as continuing the main thread\'s active task.',
    '',
    'This side conversation is a real working agent in the same workspace. When the user explicitly requests a change after the boundary, perform it with the real tools — `write`, `edit`, `bash`, and any other enabled tools — so the edits land on disk in the same working directory. Keep the change minimal and limited to the request, verify it, and report what changed. Never describe a change you did not make.',
    '',
    'Do not write anything into the main session transcript. Do not interact with sub-agents from this side conversation, and do not create commits, branches, or pushes unless the user explicitly asks for them.',
  ].join('\n')
}

/**
 * Project an agent inbox as queue rows for the panel.
 * @param inbox - the agent's inbox (`nextStep` / `nextTurn` message lists).
 * @returns rows of `{ id, text, placement }`, steering first.
 */
export function projectQueue(inbox) {
  const rows = []
  const append = (list, placement) => {
    if (!Array.isArray(list)) return
    for (const message of list) {
      if (message === null || typeof message !== 'object') continue
      const text = messageText(message).trim()
      if (text === '') continue
      rows.push({ id: String(message.id ?? ''), text: clip(text, 200), placement })
    }
  }
  append(inbox?.nextStep, 'steering')
  append(inbox?.nextTurn, 'queued')
  return rows
}

/**
 * Shape one committed session event for the wire: sequence, type, time and
 * data, plus the optional surface projection fields.
 * @param event - one committed session event.
 * @returns the wire entry, or undefined when the value is not an event.
 */
function projectEntry(event) {
  if (event === null || typeof event !== 'object') return undefined
  if (typeof event.seq !== 'number') return undefined
  const entry = { seq: event.seq, type: event.type, time: event.time, data: event.data }
  if (event.surfaceOp !== undefined) entry.surfaceOp = event.surfaceOp
  if (event.sourceEventSeqs !== undefined) entry.sourceEventSeqs = event.sourceEventSeqs
  return entry
}

/**
 * Shape and page committed session events for the client snapshot route.
 * @param events - committed session events in log order.
 * @param floor - inclusive lower bound; events below it are never re-sent.
 * @param limit - maximum number of trailing entries returned.
 * @returns the trailing entries and whether older entries were dropped.
 */
export function snapshotEntries(events, floor = 0, limit = SNAPSHOT_PAGE_LIMIT) {
  const list = []
  if (Array.isArray(events)) {
    for (const event of events) {
      if (event === null || typeof event !== 'object') continue
      if (typeof event.seq !== 'number' || event.seq < floor) continue
      const entry = projectEntry(event)
      if (entry !== undefined) list.push(entry)
    }
  }
  if (limit > 0 && list.length > limit) {
    return { entries: list.slice(list.length - limit), truncated: true }
  }
  return { entries: list, truncated: false }
}

/**
 * One SSE frame: a named event with one line of JSON data. Values must be
 * JSON-serializable (they come from plain session event and frame data).
 * @param eventName - the SSE `event:` name.
 * @param value - the JSON-serializable `data:` payload.
 * @returns the complete frame text.
 */
function sseFrame(eventName, value) {
  return `event: ${eventName}\ndata: ${JSON.stringify(value)}\n\n`
}

/** Frame types of the dense `agent/assistant-stream` sequence. */
const LIVE_FRAME_TYPES = new Set(['start', 'chunk', 'end'])

/**
 * Per-session fold of the `agent/assistant-stream` frame sequence into one
 * renderable live attempt. DSH emits a dense per-agent sequence whose
 * `revision` starts at 1; a revision gap invalidates the baseline instead of
 * being spliced in, so the client can treat every `live` payload as an
 * authoritative replacement. `chunk` values are provider-neutral LLM
 * `StreamChunk`s, folded by a minimal local assembler (dsh-llm's
 * `BlockAssembler` is deliberately not imported).
 */
export class LiveAttemptState {
  constructor() {
    /** Last accepted frame revision; 0 before the first frame. */
    this.revision = 0
    /** The in-flight attempt, or undefined when no attempt is streaming. */
    this.active = undefined
  }

  /**
   * Fold one assistant-stream frame into the live state.
   * @param frame - an `agent/assistant-stream` frame (`start`, `chunk`, `end`).
   * @returns true when the frame was accepted; malformed frames are ignored.
   */
  accept(frame) {
    if (frame === null || typeof frame !== 'object') return false
    if (!LIVE_FRAME_TYPES.has(frame.type)) return false
    if (!Number.isSafeInteger(frame.revision)) return false
    if (frame.type === 'start' && (typeof frame.attemptId !== 'string' || frame.attemptId === '')) return false
    // A new agent lifecycle restarts revisions at 1; drop the stale baseline.
    if (frame.type === 'start' && frame.revision === 1 && this.revision !== 0) {
      this.revision = 0
      this.active = undefined
    }
    if (frame.revision !== this.revision + 1) {
      // A gap means a chunk was missed: the partial attempt is no longer a
      // faithful prefix, so clear it and adopt the new revision baseline.
      this.active = undefined
      this.revision = frame.revision
      return true
    }
    this.revision = frame.revision
    if (frame.type === 'start') {
      this.active = {
        attemptId: frame.attemptId,
        turn: frame.turn,
        step: frame.step,
        nextIndex: 0,
        partials: new Map(),
        order: [],
      }
      return true
    }
    if (frame.type === 'chunk') {
      const active = this.active
      if (active === undefined || frame.attemptId !== active.attemptId || frame.index !== active.nextIndex) {
        this.active = undefined
        return true
      }
      pushStreamChunk(active.partials, active.order, frame.chunk)
      active.nextIndex += 1
      return true
    }
    this.active = undefined
    return true
  }

  /**
   * Drop the active attempt once its message committed. The loop commits the
   * complete `assistant/message` / `assistant/attempt` before emitting the
   * matching `end` frame, so the committed event is the first settlement signal.
   * @param turn - durable turn of the committed event.
   * @param step - durable step of the committed event.
   * @returns whether the active attempt was settled.
   */
  settle(turn, step) {
    const active = this.active
    if (active === undefined || active.turn !== turn || active.step !== step) return false
    this.active = undefined
    return true
  }

  /**
   * Snapshot the live state, both for `live` frames and the snapshot route.
   * @returns `{ revision, activeAttempt }`; `activeAttempt` is null when idle,
   *   otherwise `{ attemptId, turn, step, nextIndex, blocks }` with renderable
   *   blocks in stream order.
   */
  snapshot() {
    const active = this.active
    if (active === undefined) return { revision: this.revision, activeAttempt: null }
    const blocks = []
    for (const index of active.order) {
      const partial = active.partials.get(index)
      if (partial === undefined) continue
      const block = renderStreamBlock(partial)
      if (block !== undefined) blocks.push(block)
    }
    return {
      revision: this.revision,
      activeAttempt: {
        attemptId: active.attemptId,
        turn: active.turn,
        step: active.step,
        nextIndex: active.nextIndex,
        blocks,
      },
    }
  }
}

/**
 * Fold one `StreamChunk` into the per-index partial block map, mirroring the
 * minimal behavior of dsh-llm's BlockAssembler: `block-start` opens a block,
 * deltas extend it, `block-end` finalizes it, and deltas after finalize (or
 * unknown block types) never render.
 * @param partials - stream index -> partial block state.
 * @param order - stream indexes in first-seen order.
 * @param chunk - one provider-neutral LLM stream chunk.
 */
function pushStreamChunk(partials, order, chunk) {
  if (chunk === null || typeof chunk !== 'object' || typeof chunk.type !== 'string') return
  if (!Number.isSafeInteger(chunk.index) || chunk.index < 0) return
  const index = chunk.index
  const create = (blockType) => {
    const partial = {
      blockType,
      text: '',
      toolCallId: undefined,
      toolCallName: undefined,
      toolCallArgs: '',
      block: undefined,
    }
    partials.set(index, partial)
    order.push(index)
    return partial
  }
  const ensure = (blockType) => partials.get(index) ?? create(blockType)
  switch (chunk.type) {
    case 'block-start':
      if (!partials.has(index)) create(chunk.blockType)
      return
    case 'text-delta':
    case 'reasoning-delta': {
      const partial = ensure(chunk.type === 'text-delta' ? 'text' : 'reasoning')
      if (partial.block !== undefined) return
      if (typeof chunk.text === 'string') partial.text += chunk.text
      return
    }
    case 'tool-call-delta': {
      const partial = ensure('tool-call')
      if (partial.block !== undefined) return
      if (typeof chunk.id === 'string') partial.toolCallId = chunk.id
      if (typeof chunk.name === 'string' && chunk.name !== '') partial.toolCallName = chunk.name
      if (typeof chunk.argumentsDelta === 'string') partial.toolCallArgs += chunk.argumentsDelta
      return
    }
    case 'block-end': {
      const blockType = chunk.block !== null && typeof chunk.block === 'object' ? chunk.block.type : undefined
      if (typeof blockType !== 'string') return
      const partial = ensure(blockType)
      if (partial.block !== undefined) return
      partial.block = chunk.block
      return
    }
    default:
      return
  }
}

/**
 * Project one partial block into the client's live wire block shape.
 * @param partial - the assembled partial block.
 * @returns a renderable block, or undefined for empty or unsupported blocks.
 */
function renderStreamBlock(partial) {
  switch (partial.blockType) {
    case 'text':
      return partial.text === '' ? undefined : { kind: 'text', text: partial.text }
    case 'reasoning':
      return partial.text === '' ? undefined : { kind: 'reasoning', text: partial.text }
    case 'tool-call':
      return {
        kind: 'tool-call',
        callId: partial.toolCallId ?? '',
        name: partial.toolCallName ?? '',
        argsRaw: partial.toolCallArgs,
      }
    default:
      return undefined
  }
}

async function readRequestBody(req) {
  if (req === null || typeof req !== 'object' || typeof req[Symbol.asyncIterator] !== 'function') return ''
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    size += text.length
    if (size > MAX_REQUEST_BODY_BYTES) throw new Error('request body exceeds the size limit')
    chunks.push(text)
  }
  return chunks.join('')
}

function sendJson(res, value) {
  let body
  try {
    body = JSON.stringify(value)
  } catch {
    body = JSON.stringify(failure('internal', 'response is not JSON-serializable'))
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

/**
 * Wrap one service call as a POST JSON route handler. Request parsing failures
 * and thrown handler errors are folded into `{ ok: false, code, message }` on a
 * 200 JSON response; the handler never throws into the HTTP carrier.
 * @param handler - async `(args) => result`.
 * @param logger - optional logger used for contained internal failures.
 * @returns the `(req, res)` route handler.
 */
export function routeHandler(handler, logger) {
  return async function sideChatRoute(req, res) {
    let args = {}
    try {
      const body = await readRequestBody(req)
      const parsed = body.trim() === '' ? {} : JSON.parse(body)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed
    } catch (error) {
      logger?.warn?.(`[side-chat] rejected request: ${errorMessage(error)}`)
      sendJson(res, failure('internal', `invalid request body: ${errorMessage(error)}`))
      return
    }
    let result
    try {
      result = await handler(args)
    } catch (error) {
      logger?.warn?.(`[side-chat] route handler failed: ${errorMessage(error)}`)
      result = failure('internal', errorMessage(error))
    }
    sendJson(res, result)
  }
}

/**
 * Resolve the persisted session's own artifact directory from a persistence
 * location, with the guardrails that keep deletion scoped: an absolute log
 * path whose directory is exactly the session id (no parent or sibling).
 * @param header - the session header (its id names the directory).
 * @param location - a backend `locate()` result, `{ path }` when it has one.
 * @returns the absolute directory to remove, or undefined when the location
 *   cannot be attributed to this exact session.
 */
export function artifactDirectory(header, location) {
  const path = location?.path
  const id = header?.id
  if (typeof path !== 'string' || !isAbsolute(path)) return undefined
  if (typeof id !== 'string' || id === '') return undefined
  const dir = dirname(path)
  return basename(dir) === id ? dir : undefined
}

function developerSectionOrder(systemPrompt) {
  const suffixOrder = systemPrompt?.getSectionOrder?.('DEPLOYMENT_PERSONA_SUFFIX')
  return Number.isFinite(suffixOrder) ? suffixOrder - 10 : DEVELOPER_SECTION_ORDER_FALLBACK
}

function toNonNegativeInteger(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined
}

class SideChatService {
  constructor(ctx) {
    this.ctx = ctx
    /** sessionId -> { sessionId, sourceId, instanceKey, identity, handle, inheritedEventCount } */
    this.entries = new Map()
    /**
     * identity -> sessionId (idempotent create). The identity is the opaque
     * client `instanceKey` when one was sent (one side session per client tab
     * instance), otherwise `source:<sourceId>` (legacy: one side session per
     * parent).
     */
    this.byIdentity = new Map()
    /** identity -> in-flight create result (deduplicates concurrent creates) */
    this.pendingCreates = new Map()
    /** sessionId -> last contained agent failure, for the panel error banner */
    this.lastErrors = new Map()
    /** sessionId -> LiveAttemptState (fed even with no stream client connected) */
    this.liveStates = new Map()
    /** sessionId -> Set of open SSE stream records */
    this.streams = new Map()
    /** Disposers of the Cordis event listeners below, called at plugin unload */
    this.listenerDisposers = []
    /** Set at plugin unload so a creation still in flight cannot leak its agent */
    this.closing = false
    const listen = (eventName, listener) => {
      const dispose = ctx.on?.(eventName, listener)
      if (typeof dispose === 'function') this.listenerDisposers.push(dispose)
    }
    listen('agent/error', (payload) => this.onAgentError(payload))
    listen('agent/status', (payload) => this.onAgentStatus(payload))
    // The agent loop emits one dense frame sequence per attempt; a root-level
    // Cordis listener receives every agent's frames, so filter by owned id.
    listen('agent/assistant-stream', (payload) => this.onAssistantStream(payload))
    listen('session/event', (session, event) => this.onSessionEvent(session, event))
  }

  entryOf(sessionId) {
    return sessionId === '' ? undefined : this.entries.get(sessionId)
  }

  /** Record one contained side-session failure and push it to open streams. */
  onAgentError(payload) {
    const id = payload?.agent?.id
    if (typeof id !== 'string' || !this.entries.has(id)) return
    const error = payload.error
    const message = error instanceof Error ? error.message : String(error?.message ?? error)
    this.lastErrors.set(id, message)
    this.broadcast(id, 'error', { message })
  }

  /** Push one agent status transition to open streams of an owned session. */
  onAgentStatus(payload) {
    const id = payload?.agent?.id
    if (typeof id !== 'string' || !this.entries.has(id)) return
    const status = payload.status
    this.broadcast(id, 'status', { status, running: status === 'running' })
  }

  /**
   * Fold one attempt frame into the session's live state. State is kept even
   * without a stream client because the snapshot route serves it as fallback.
   */
  onAssistantStream(payload) {
    const id = payload?.agent?.id
    if (typeof id !== 'string' || !this.entries.has(id)) return
    let state = this.liveStates.get(id)
    if (state === undefined) {
      state = new LiveAttemptState()
      this.liveStates.set(id, state)
    }
    if (!state.accept(payload.frame)) return
    this.broadcastLive(id)
  }

  /** Push an authoritative replacement of one session's live state to streams. */
  broadcastLive(sessionId) {
    const streams = this.streams.get(sessionId)
    if (streams === undefined || streams.size === 0) return
    this.broadcast(sessionId, 'live', { live: this.liveOf(sessionId) })
  }

  /**
   * Observe committed session events: settle the active live attempt when its
   * message commits (before the matching `end` frame arrives) and forward every
   * new committed event to open streams in sequence order.
   */
  onSessionEvent(session, event) {
    const id = typeof session?.id === 'string' ? session.id : session?.header?.id
    if (typeof id !== 'string' || !this.entries.has(id)) return
    if (event === null || typeof event !== 'object') return
    const state = this.liveStates.get(id)
    if (state !== undefined
      && (event.type === 'assistant/message' || event.type === 'assistant/attempt')
      && state.settle(event.data?.turn, event.data?.step)) {
      this.broadcastLive(id)
    }
    this.broadcastEvent(id, event)
  }

  /** Write one SSE frame to every open stream of one side session. */
  broadcast(sessionId, eventName, value) {
    const streams = this.streams.get(sessionId)
    if (streams === undefined || streams.size === 0) return
    let frame
    try {
      frame = sseFrame(eventName, value)
    } catch (error) {
      this.ctx.logger?.warn?.(`[side-chat] ${eventName} frame not serializable: ${errorMessage(error)}`)
      return
    }
    for (const stream of [...streams]) this.writeStream(stream, frame)
  }

  /** Write one committed session event to streams that have not seen its seq. */
  broadcastEvent(sessionId, event) {
    const streams = this.streams.get(sessionId)
    if (streams === undefined || streams.size === 0) return
    let entry
    let frame
    try {
      entry = projectEntry(event)
      if (entry === undefined) return
      frame = sseFrame('event', { entry })
    } catch (error) {
      this.ctx.logger?.warn?.(`[side-chat] event frame not serializable: ${errorMessage(error)}`)
      return
    }
    for (const stream of [...streams]) {
      if (entry.seq < stream.floor || entry.seq <= stream.cursor) continue
      if (this.writeStream(stream, frame)) stream.cursor = entry.seq
    }
  }

  /** Write raw SSE text to one stream; a failed write ends the stream. */
  writeStream(stream, text) {
    if (stream.closed) return false
    try {
      stream.res.write?.(text)
      return true
    } catch (error) {
      this.ctx.logger?.warn?.(`[side-chat] event stream write failed: ${errorMessage(error)}`)
      this.endStream(stream)
      return false
    }
  }

  /** Tear down one stream: clear its heartbeat, detach listeners, end the response. */
  endStream(stream) {
    if (stream.closed) return
    stream.closed = true
    if (stream.heartbeat !== undefined) {
      clearInterval(stream.heartbeat)
      stream.heartbeat = undefined
    }
    const streams = this.streams.get(stream.sessionId)
    if (streams !== undefined) {
      streams.delete(stream)
      if (streams.size === 0) this.streams.delete(stream.sessionId)
    }
    if (typeof stream.detach === 'function') {
      try {
        stream.detach()
      } catch {
        // Detaching a listener must never keep the response open.
      }
      stream.detach = undefined
    }
    try {
      if (stream.res.writableEnded !== true) stream.res.end?.()
    } catch {
      // The client may already have gone away; closing is best effort.
    }
  }

  /** End every open stream of one side session (close / unload). */
  endStreamsFor(sessionId) {
    const streams = this.streams.get(sessionId)
    if (streams === undefined) return
    for (const stream of [...streams]) this.endStream(stream)
    this.streams.delete(sessionId)
  }

  /** Current live state of one side session for `live` frames and snapshots. */
  liveOf(sessionId) {
    const state = this.liveStates.get(sessionId)
    return state === undefined ? null : state.snapshot()
  }

  async create(args) {
    if (this.closing) return failure('internal', 'side-chat plugin is unloading')
    const sourceId = typeof args?.sourceId === 'string' ? args.sourceId : String(args?.sourceId ?? '')
    if (sourceId === '') return failure('unknown-source', 'missing sourceId')
    const parent = this.ctx.agents.get(sourceId)
    if (parent === undefined) return failure('unknown-source', `unknown source session "${sourceId}"`)
    // A non-empty instanceKey is the opaque create identity (one side session
    // per client tab instance). Without it, fall back to the legacy identity
    // that keeps one side session per parent session.
    const instanceKey = typeof args?.instanceKey === 'string' && args.instanceKey !== '' ? args.instanceKey : null
    const identity = instanceKey === null ? `source:${sourceId}` : instanceKey
    const existingId = this.byIdentity.get(identity)
    if (existingId !== undefined) {
      const existing = this.entries.get(existingId)
      if (existing !== undefined) {
        return success({ sessionId: existingId, inheritedEventCount: existing.inheritedEventCount })
      }
      this.byIdentity.delete(identity)
    }
    const inflight = this.pendingCreates.get(identity)
    if (inflight !== undefined) return await inflight
    const started = this.createSession(sourceId, parent, identity, instanceKey)
    this.pendingCreates.set(identity, started)
    try {
      return await started
    } finally {
      this.pendingCreates.delete(identity)
    }
  }

  async createSession(sourceId, parent, identity, instanceKey) {
    const ctx = this.ctx
    const parentSession = parent.session
    try {
      const events = typeof parentSession?.snapshotEvents === 'function' ? parentSession.snapshotEvents() : []
      const seed = completedTurnPrefix(events)
      const inheritedEventCount = seed.length
      const recentContext = recentMainContext(events, inheritedEventCount)
      const header = parentSession?.header ?? {}
      const parentOptions = parent.options ?? {}
      const requestConfig = typeof parentSession?.requestHeader === 'function'
        ? parentSession.requestHeader()?.config
        : undefined
      const route = requestConfig !== undefined
        && typeof requestConfig.provider === 'string' && requestConfig.provider !== ''
        && typeof requestConfig.model === 'string' && requestConfig.model !== ''
        ? requestConfig
        : parentOptions
      const agentPresets = ctx.get('agentPresets')
      const agentPreset = typeof agentPresets?.composedPreset === 'function'
        ? agentPresets.composedPreset(parent.ctx)
        : undefined
      const sandboxMode = ctx.get('sandboxPolicy')?.overrideOf?.(parent.session)
      const approvalPolicy = ctx.get('approval')?.overrideOf?.(parent.session)
      const sessionId = `${SESSION_ID_PREFIX}${randomUUID()}`
      const boundaryText = sideConversationBoundaryPrompt(String(header.id ?? sourceId), recentContext)
      const meta = {
        ...(typeof header.cwd === 'string' ? { cwd: header.cwd } : {}),
        ...(typeof agentPreset === 'string' && agentPreset !== '' ? { agentPreset } : {}),
        ...(inheritedEventCount > 0 ? { isSeeded: true } : {}),
        origin: 'subagent',
      }
      const agentOptions = {
        ...(typeof route.provider === 'string' ? { provider: route.provider } : {}),
        ...(typeof route.model === 'string' ? { model: route.model } : {}),
        ...(typeof route.reasoningEffort === 'string' ? { reasoningEffort: route.reasoningEffort } : {}),
        ...(typeof route.maxTokens === 'number' ? { maxTokens: route.maxTokens } : {}),
      }
      const handle = await ctx.agents.create({
        sessionId,
        meta,
        ...(inheritedEventCount > 0 ? { seed, inheritedEventCount } : {}),
        agentOptions,
        setup: (childCtx, agent) => {
          childCtx.get('agentPresets')?.composeFrom?.(childCtx, parent.ctx)
          if (sandboxMode !== undefined) {
            agent.session.append('sandbox/mode', { mode: sandboxMode, source: SANDBOX_OVERRIDE_SOURCE })
          }
          if (approvalPolicy !== undefined) {
            agent.session.append('approval/policy', { policy: approvalPolicy, source: APPROVAL_OVERRIDE_SOURCE })
          }
          agent.session.append('user/message', {
            id: `${SESSION_ID_PREFIX}boundary-${randomUUID()}`,
            role: 'user',
            content: [{ type: 'text', text: boundaryText }],
            source: BOUNDARY_SOURCE,
          }, { surfaceOp: 'append' })
          childCtx.systemPrompt.section({
            name: DEVELOPER_SECTION_NAME,
            order: developerSectionOrder(childCtx.systemPrompt),
            text: sideDeveloperInstructions(),
          })
        },
      })
      if (this.closing) {
        await handle.dispose().catch(() => {})
        return failure('internal', 'side-chat plugin is unloading')
      }
      this.entries.set(sessionId, { sessionId, sourceId, instanceKey, identity, handle, inheritedEventCount })
      this.byIdentity.set(identity, sessionId)
      return success({ sessionId, inheritedEventCount })
    } catch (error) {
      return failure('create-failed', errorMessage(error))
    }
  }

  async prompt(args) {
    const sessionId = String(args?.sessionId ?? '')
    const text = typeof args?.text === 'string' ? args.text : ''
    if (text.trim() === '') return failure('empty-prompt')
    const entry = this.entryOf(sessionId)
    if (entry === undefined) return failure('not-found')
    try {
      entry.handle.agent.followup({
        id: `${SESSION_ID_PREFIX}message-${randomUUID()}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })
    } catch (error) {
      return failure('prompt-failed', errorMessage(error))
    }
    return success()
  }

  async cancel(args) {
    const entry = this.entryOf(String(args?.sessionId ?? ''))
    if (entry === undefined) return failure('not-found')
    entry.handle.agent.cancel({ kind: 'user' })
    return success()
  }

  async status(args) {
    const sessionId = String(args?.sessionId ?? '')
    const entry = this.entryOf(sessionId)
    if (entry === undefined) return failure('not-found')
    const agent = entry.handle.agent
    const status = agent.status
    return success({
      status,
      running: status === 'running',
      queue: projectQueue(agent.inbox),
      lastError: this.lastErrors.get(sessionId) ?? null,
    })
  }

  async snapshot(args) {
    const sessionId = String(args?.sessionId ?? '')
    const entry = this.entryOf(sessionId)
    if (entry === undefined) return failure('not-found')
    const agent = entry.handle.agent
    const { inheritedEventCount, floor } = this.eventFloor(entry, args?.fromSeq)
    const events = typeof agent.session?.snapshotEvents === 'function' ? agent.session.snapshotEvents(floor) : []
    const { entries, truncated } = snapshotEntries(events, floor)
    const status = agent.status
    return success({
      inheritedEventCount,
      running: status === 'running',
      status,
      lastError: this.lastErrors.get(sessionId) ?? null,
      entries,
      truncated,
      live: this.liveOf(sessionId),
    })
  }

  /**
   * Resolve the event floor of one owned session: never below the inherited
   * prefix, never below an explicitly requested sequence.
   * @param entry - the owned side-session entry.
   * @param fromSeq - optional requested first sequence.
   * @returns the inherited event count and the effective floor.
   */
  eventFloor(entry, fromSeq) {
    const agent = entry.handle.agent
    const inheritedEventCount = Number.isSafeInteger(entry.inheritedEventCount)
      ? entry.inheritedEventCount
      : Number.isSafeInteger(agent.session?.inheritedEventCount) ? agent.session.inheritedEventCount : 0
    const requested = toNonNegativeInteger(fromSeq)
    return { inheritedEventCount, floor: Math.max(inheritedEventCount, requested ?? inheritedEventCount) }
  }

  /**
   * Serve one `text/event-stream` stream of the live assistant attempt and newly
   * committed events. `webServer.register` hands this a raw Node request and
   * response with direct ownership, so failure before the stream starts is a
   * normal JSON response (the client then falls back to polling) and every
   * write/cleanup is contained here.
   * @param req - the raw Node request.
   * @param res - the raw Node response.
   */
  async openEventStream(req, res) {
    let args
    try {
      const body = await readRequestBody(req)
      const parsed = body.trim() === '' ? {} : JSON.parse(body)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('request body must be a JSON object')
      }
      args = parsed
    } catch (error) {
      this.ctx.logger?.warn?.(`[side-chat] rejected event stream request: ${errorMessage(error)}`)
      try {
        sendJson(res, failure('internal', `invalid request body: ${errorMessage(error)}`))
      } catch {
        // The response may already be gone; there is nothing left to report to.
      }
      return
    }
    const sessionId = String(args.sessionId ?? '')
    const entry = this.entryOf(sessionId)
    if (entry === undefined) {
      try {
        sendJson(res, failure('not-found'))
      } catch {
        // Best effort: a broken carrier must not throw out of the route.
      }
      return
    }
    try {
      this.startEventStream(req, res, sessionId, entry, args)
    } catch (error) {
      this.ctx.logger?.warn?.(`[side-chat] event stream setup failed: ${errorMessage(error)}`)
      try {
        res.end?.()
      } catch {
        // Already torn down by the failure that got us here.
      }
    }
  }

  /**
   * Write the stream headers, the `hello` baseline, then register the stream for
   * subsequent committed events, live frames and status/error frames. Runs
   * synchronously so no session event can slip between the hello snapshot and
   * the stream's registration.
   */
  startEventStream(req, res, sessionId, entry, args) {
    const agent = entry.handle.agent
    const { inheritedEventCount, floor } = this.eventFloor(entry, args.fromSeq)
    const events = typeof agent.session?.snapshotEvents === 'function' ? agent.session.snapshotEvents(floor) : []
    const { entries, truncated } = snapshotEntries(events, floor)
    const status = agent.status
    const stream = {
      sessionId,
      res,
      floor,
      // Everything at or below this seq is already represented in the hello frame.
      cursor: entries.length === 0 ? floor - 1 : entries[entries.length - 1].seq,
      heartbeat: undefined,
      detach: undefined,
      closed: false,
    }
    res.writeHead(200, SSE_HEADERS)
    // Observe disconnects before writing: a fake or real response may close
    // synchronously while the hello frame is written.
    const detach = []
    const onClose = () => this.endStream(stream)
    if (typeof req?.on === 'function') {
      req.on('close', onClose)
      detach.push(() => req.off?.('close', onClose))
    }
    if (typeof res?.on === 'function') {
      res.on('close', onClose)
      detach.push(() => res.off?.('close', onClose))
    }
    stream.detach = () => {
      for (const remove of detach) remove()
    }
    this.writeStream(stream, sseFrame('hello', success({
      inheritedEventCount,
      status,
      running: status === 'running',
      lastError: this.lastErrors.get(sessionId) ?? null,
      entries,
      truncated,
      live: this.liveOf(sessionId),
    })))
    if (stream.closed) return
    let streams = this.streams.get(sessionId)
    if (streams === undefined) {
      streams = new Set()
      this.streams.set(sessionId, streams)
    }
    streams.add(stream)
    // Heartbeat comments keep idle connections (and intermediary proxies) alive
    // without changing the frame contract; unref so tests and shutdown never
    // wait on the interval.
    const heartbeat = setInterval(() => this.writeStream(stream, ': ping\n\n'), SSE_HEARTBEAT_MS)
    heartbeat.unref?.()
    stream.heartbeat = heartbeat
  }

  async list() {
    const sessions = []
    for (const entry of this.entries.values()) sessions.push({ sessionId: entry.sessionId, sourceId: entry.sourceId })
    return success({ sessions })
  }

  async close(args) {
    const sessionId = String(args?.sessionId ?? '')
    const entry = this.entryOf(sessionId)
    if (entry === undefined) return failure('not-found')
    this.entries.delete(sessionId)
    // Remove the identity mapping only when it still points at this session: a
    // recreated instance key may already own a newer side session.
    if (this.byIdentity.get(entry.identity) === sessionId) this.byIdentity.delete(entry.identity)
    this.lastErrors.delete(sessionId)
    this.liveStates.delete(sessionId)
    this.endStreamsFor(sessionId)
    const artifactDir = this.locateArtifact(entry.handle.agent)
    try {
      await entry.handle.dispose()
    } catch (error) {
      return failure('dispose-failed', errorMessage(error))
    }
    if (artifactDir !== undefined) await this.removeArtifact(sessionId, artifactDir)
    return success()
  }

  /** Resolve the persisted artifact directory before disposal, while the header is still live. */
  locateArtifact(agent) {
    const persistence = this.ctx.get('sessionPersistence')
    if (typeof persistence?.locate !== 'function') return undefined
    let location
    try {
      location = persistence.locate(agent.session.header)
    } catch {
      return undefined
    }
    return artifactDirectory(agent.session?.header, location)
  }

  /**
   * Delete only this plugin's own persisted session directory. Housekeeping runs
   * in the Host process (no shell, no sandbox escalation); `force` +
   * `recursive` make a missing artifact a no-op, and any failure only warns —
   * `close` already disposed the agent and still reports success.
   */
  async removeArtifact(sessionId, dir) {
    try {
      if (typeof this.ctx.timeout === 'function') await this.ctx.timeout(DRAIN_DELAY_MS)
      await rm(dir, { recursive: true, force: true })
    } catch (error) {
      this.ctx.logger?.warn?.(`[side-chat] artifact cleanup for "${sessionId}" failed: ${errorMessage(error)}`)
    }
  }

  disposeAll() {
    this.closing = true
    for (const dispose of this.listenerDisposers) {
      try {
        dispose()
      } catch {
        // Listener teardown must not block the rest of plugin unload.
      }
    }
    this.listenerDisposers.length = 0
    for (const sessionId of [...this.streams.keys()]) this.endStreamsFor(sessionId)
    this.streams.clear()
    this.liveStates.clear()
    for (const entry of this.entries.values()) entry.handle.dispose().catch(() => {})
    this.entries.clear()
    this.byIdentity.clear()
    this.pendingCreates.clear()
    this.lastErrors.clear()
  }
}

/**
 * Mount the side-chat routes and lifecycle cleanup.
 * @param ctx - the plugin context; `webServer`, `agents` and `timer` are injected.
 */
export function apply(ctx) {
  const service = new SideChatService(ctx)
  const webServer = ctx.webServer
  if (webServer !== undefined && typeof webServer.register === 'function') {
    const routeDisposers = []
    for (const routeName of ROUTE_NAMES) {
      const route = {
        kind: 'exact',
        path: `${ROUTE_PREFIX}${routeName}`,
        handler: routeHandler((args) => service[routeName](args), ctx.logger),
      }
      try {
        routeDisposers.push(webServer.register(route))
      } catch (error) {
        ctx.logger?.warn?.(`[side-chat] route ${route.path} not registered: ${errorMessage(error)}`)
      }
    }
    // The event stream owns its response directly and is not a JSON route, so it
    // bypasses `routeHandler` and keeps `ROUTE_NAMES` for the JSON surface only.
    try {
      routeDisposers.push(webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}events`,
        handler: (req, res) => service.openEventStream(req, res).catch((error) => {
          ctx.logger?.warn?.(`[side-chat] event stream failed: ${errorMessage(error)}`)
          try {
            res.end?.()
          } catch {
            // The carrier is already gone; there is nothing left to close.
          }
        }),
      }))
    } catch (error) {
      ctx.logger?.warn?.(`[side-chat] route ${ROUTE_PREFIX}events not registered: ${errorMessage(error)}`)
    }
    ctx.effect(() => () => {
      for (const dispose of routeDisposers) dispose()
    }, 'side-chat: routes')
  } else {
    ctx.logger?.warn?.('[side-chat] webServer is unavailable; the client RPC surface is not mounted')
  }
  ctx.effect(() => () => service.disposeAll(), 'side-chat: sessions')
}
