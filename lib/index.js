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
 * The client half talks to this half through POST JSON routes under
 * `/side-chat/api/`. The only message source for the panel is the read-only
 * `snapshot` route, because the side session has `origin: 'subagent'` without a
 * `parentSession` and therefore is not reachable through the client `sessions`
 * service.
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
      const entry = { seq: event.seq, type: event.type, time: event.time, data: event.data }
      if (event.surfaceOp !== undefined) entry.surfaceOp = event.surfaceOp
      if (event.sourceEventSeqs !== undefined) entry.sourceEventSeqs = event.sourceEventSeqs
      list.push(entry)
    }
  }
  if (limit > 0 && list.length > limit) {
    return { entries: list.slice(list.length - limit), truncated: true }
  }
  return { entries: list, truncated: false }
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
    /** sessionId -> { sessionId, sourceId, handle, inheritedEventCount } */
    this.entries = new Map()
    /** sourceId -> sessionId (idempotent create, one side session per parent) */
    this.bySource = new Map()
    /** sourceId -> in-flight create result (deduplicates concurrent creates) */
    this.pendingCreates = new Map()
    /** sessionId -> last contained agent failure, for the panel error banner */
    this.lastErrors = new Map()
    /** Set at plugin unload so a creation still in flight cannot leak its agent */
    this.closing = false
    ctx.on?.('agent/error', (payload) => {
      const id = payload?.agent?.id
      if (typeof id !== 'string' || !this.entries.has(id)) return
      const error = payload.error
      this.lastErrors.set(id, error instanceof Error ? error.message : String(error?.message ?? error))
    })
  }

  entryOf(sessionId) {
    return sessionId === '' ? undefined : this.entries.get(sessionId)
  }

  async create(args) {
    if (this.closing) return failure('internal', 'side-chat plugin is unloading')
    const sourceId = typeof args?.sourceId === 'string' ? args.sourceId : String(args?.sourceId ?? '')
    if (sourceId === '') return failure('unknown-source', 'missing sourceId')
    const parent = this.ctx.agents.get(sourceId)
    if (parent === undefined) return failure('unknown-source', `unknown source session "${sourceId}"`)
    const existingId = this.bySource.get(sourceId)
    if (existingId !== undefined) {
      const existing = this.entries.get(existingId)
      if (existing !== undefined) {
        return success({ sessionId: existingId, inheritedEventCount: existing.inheritedEventCount })
      }
      this.bySource.delete(sourceId)
    }
    const inflight = this.pendingCreates.get(sourceId)
    if (inflight !== undefined) return await inflight
    const started = this.createSession(sourceId, parent)
    this.pendingCreates.set(sourceId, started)
    try {
      return await started
    } finally {
      this.pendingCreates.delete(sourceId)
    }
  }

  async createSession(sourceId, parent) {
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
      this.entries.set(sessionId, { sessionId, sourceId, handle, inheritedEventCount })
      this.bySource.set(sourceId, sessionId)
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
    const inheritedEventCount = Number.isSafeInteger(entry.inheritedEventCount)
      ? entry.inheritedEventCount
      : Number.isSafeInteger(agent.session?.inheritedEventCount) ? agent.session.inheritedEventCount : 0
    const requested = toNonNegativeInteger(args?.fromSeq)
    const floor = Math.max(inheritedEventCount, requested ?? inheritedEventCount)
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
    })
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
    this.bySource.delete(entry.sourceId)
    this.lastErrors.delete(sessionId)
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
    for (const entry of this.entries.values()) entry.handle.dispose().catch(() => {})
    this.entries.clear()
    this.bySource.clear()
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
    ctx.effect(() => () => {
      for (const dispose of routeDisposers) dispose()
    }, 'side-chat: routes')
  } else {
    ctx.logger?.warn?.('[side-chat] webServer is unavailable; the client RPC surface is not mounted')
  }
  ctx.effect(() => () => service.disposeAll(), 'side-chat: sessions')
}
