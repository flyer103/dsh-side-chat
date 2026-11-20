import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  abbreviateHomePath,
  apply,
  artifactDirectory,
  completedTurnPrefix,
  imageAttachmentRef,
  isSystemNoise,
  LiveAttemptState,
  projectQueue,
  recentMainContext,
  referenceCandidates,
  requestContextWindow,
  routeHandler,
  sessionReferenceCandidates,
  sessionReferenceMention,
  sideConversationBoundaryPrompt,
  sideDeveloperInstructions,
  snapshotEntries,
} from '../lib/index.js'

const ROUTE_PREFIX = '/side-chat/api/'

function ev(seq, type, data, extra) {
  return { seq, type, time: 1000 + seq, data, ...extra }
}

function userMsg(id, text, source = { kind: 'user' }) {
  return { id, role: 'user', content: [{ type: 'text', text }], source }
}

function assistantMsg(id, text) {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' },
  }
}

function makeParent({ id = 'main-1', cwd = '/workspace', events = [], provider = 'deepseek', model = 'deepseek-flash', maxTokens = 2048, reasoningEffort, headerConfig } = {}) {
  return {
    id,
    options: {
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    },
    session: {
      header: { id, ...(cwd === undefined ? {} : { cwd }) },
      snapshotEvents: (fromSeq = 0) => events.slice(fromSeq),
      ...(headerConfig === undefined ? {} : { requestHeader: () => ({ config: headerConfig }) }),
    },
    ctx: { marker: 'parent-ctx', id },
  }
}

const DEFAULT_SERVICES = {
  agentPresets: {
    composedPreset: () => 'cordis',
    composeFrom: () => 'cordis',
  },
}

function makeRuntime({ parents = [], services = {}, createDelayMs = 0, createFailure, resumeFailure, followupFailure, disposeFailure } = {}) {
  const routes = new Map()
  const effects = []
  const listeners = new Map()
  const warnings = []
  const created = []
  const handles = []
  const disposed = []
  const resumed = []
  const locateCalls = []
  const timeouts = []
  const order = []
  const parentMap = new Map(parents.map((parent) => [parent.id, parent]))

  const resolvedServices = { ...DEFAULT_SERVICES, ...services }

  async function defaultCreate(options) {
    created.push(options)
    if (createFailure !== undefined) throw createFailure
    const seedEvents = Array.isArray(options.seed) ? structuredClone(options.seed) : []
    const session = {
      id: options.sessionId,
      header: { id: options.sessionId, ...(options.meta?.cwd === undefined ? {} : { cwd: options.meta.cwd }) },
      inheritedEventCount: options.inheritedEventCount ?? 0,
      events: seedEvents,
      appends: [],
      append(type, data, opts) {
        const event = {
          seq: this.events.length,
          type,
          time: 5000 + this.events.length,
          data,
          ...(opts?.surfaceOp === undefined ? {} : { surfaceOp: opts.surfaceOp }),
          ...(opts?.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: opts.sourceEventSeqs }),
        }
        this.events.push(event)
        this.appends.push({ type, data, opts })
        return event
      },
      snapshotEvents(fromSeq = 0) {
        return this.events.slice(fromSeq)
      },
    }
    const followups = []
    const cancels = []
    const childCtx = {
      get: (serviceName) => resolvedServices[serviceName],
      systemPrompt: {
        sections: [],
        section(section) {
          this.sections.push(section)
          return () => {}
        },
        getSectionOrder: (sectionName) => ({ DEPLOYMENT_PERSONA_SUFFIX: 10200 })[sectionName],
      },
    }
    const agent = {
      id: options.sessionId,
      status: 'idle',
      options: options.agentOptions ?? {},
      model: { current: () => options.agentOptions ?? {} },
      session,
      ctx: childCtx,
      inbox: { nextStep: [], nextTurn: [] },
      followups,
      cancels,
      followup(message) {
        if (followupFailure !== undefined) throw followupFailure
        followups.push(message)
      },
      steer() {},
      cancel(cause) {
        cancels.push(cause)
      },
    }
    await options.setup?.(childCtx, agent)
    const handle = {
      agent,
      childCtx,
      async dispose() {
        disposed.push(options.sessionId)
        order.push('dispose')
        if (disposeFailure !== undefined) throw disposeFailure
      },
    }
    handles.push(handle)
    return handle
  }

  const ctx = {
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    agents: {
      get: (id) => parentMap.get(id),
      create: async (options) => {
        if (createDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, createDelayMs))
        return defaultCreate(options)
      },
      resume: async (options) => {
        resumed.push(options)
        if (resumeFailure !== undefined) throw resumeFailure
        const sessionId = options.resumeSessionId
        const session = {
          id: sessionId,
          header: { id: sessionId },
          inheritedEventCount: 0,
          events: [],
          appends: [],
          append() {},
          snapshotEvents() { return [] },
        }
        const childCtx = {
          get: (serviceName) => resolvedServices[serviceName],
          systemPrompt: { section() { return () => {} } },
          effect() { return () => {} },
        }
        const agent = {
          id: sessionId,
          status: 'idle',
          options: {},
          session,
          ctx: childCtx,
          inbox: { nextStep: [], nextTurn: [] },
          followups: [],
          cancels: [],
          followup(message) { this.followups.push(message) },
          steer() {},
          cancel(cause) { this.cancels.push(cause) },
        }
        await options.setup?.(childCtx, agent)
        const handle = { agent, childCtx, async dispose() { disposed.push(sessionId) } }
        handles.push(handle)
        return handle
      },
    },
    get: (serviceName) => resolvedServices[serviceName],
    on(eventName, callback) {
      listeners.set(eventName, callback)
      return () => listeners.delete(eventName)
    },
    effect(execute) {
      const disposer = execute()
      if (typeof disposer === 'function') effects.push(disposer)
      return disposer
    },
    async timeout(delayMs) {
      timeouts.push(delayMs)
    },
    logger: {
      warn: (...args) => warnings.push(args.map(String).join(' ')),
    },
  }

  const runtime = {
    ctx,
    routes,
    effects,
    listeners,
    warnings,
    created,
    handles,
    disposed,
    locateCalls,
    timeouts,
    order,
    resolvedServices,
    parentMap,
    resumed,
  }
  return runtime
}

async function post(runtime, routeName, args) {
  const route = runtime.routes.get(`${ROUTE_PREFIX}${routeName}`)
  assert.ok(route !== undefined, `route ${routeName} is registered`)
  const req = {
    method: 'POST',
    [Symbol.asyncIterator]: async function* () {
      yield JSON.stringify(args ?? {})
    },
  }
  let res
  const done = new Promise((resolve) => {
    res = {
      statusCode: undefined,
      headers: undefined,
      rawBody: undefined,
      writeHead(statusCode, headers) {
        this.statusCode = statusCode
        this.headers = headers
      },
      end(body) {
        this.rawBody = body
        resolve()
      },
    }
  })
  await route.handler(req, res)
  await done
  return {
    status: res.statusCode,
    headers: res.headers,
    rawBody: res.rawBody,
    body: JSON.parse(res.rawBody),
  }
}

/** Minimal stand-in for `ctx.get('attachments')` backed by an in-memory object map. */
function makeAttachmentsService(options = {}) {
  const stored = new Map()
  const saves = []
  const limits = options.limits ?? { mediaTypes: ['image/png', 'image/jpeg'], maxImageBytes: 1024 }
  const idOf = (bytes) => `sha256:${Buffer.from(`img:${bytes.length}:${saves.length}`).toString('hex').padEnd(64, '0').slice(0, 64)}`
  const service = {
    imageLimits: limits,
    saves,
    stored,
    isAttachmentError(error) {
      return error instanceof Error && typeof error.code === 'string'
    },
    async saveImages(inputs) {
      if (options.saveFailure !== undefined) throw options.saveFailure
      const refs = []
      for (const input of inputs) {
        saves.push(input)
        const attachmentId = idOf(input.data)
        const ref = {
          attachmentId,
          mediaType: input.mediaType,
          width: 2,
          height: 2,
          bytes: input.data.length,
          ...(input.name === undefined ? {} : { name: input.name }),
        }
        stored.set(attachmentId, input.data)
        refs.push(ref)
      }
      return refs
    },
    async admitPromptContent(content) {
      if (options.admitFailure !== undefined) throw options.admitFailure
      return content.map((part) => (part.type === 'image'
        ? { type: 'image', attachment: part.attachment }
        : { type: 'text', text: part.text }))
    },
    async readImage(ref) {
      if (options.readFailure !== undefined) throw options.readFailure
      const data = stored.get(ref.attachmentId)
      if (data === undefined) {
        const error = new Error('Attachment object is missing.')
        error.code = 'ATTACHMENT_NOT_FOUND'
        throw error
      }
      if (ref.bytes !== data.length) {
        const error = new Error('Stored attachment metadata does not match its reference.')
        error.code = 'ATTACHMENT_CORRUPT'
        throw error
      }
      return { ref, data }
    },
  }
  return service
}

/** Drive the raw-binary upload route with a query object and a body. */
async function uploadImage(runtime, query, body) {
  const route = runtime.routes.get(`${ROUTE_PREFIX}attachment`)
  assert.ok(route !== undefined, 'the upload route is registered')
  const search = new URLSearchParams(query).toString()
  const req = {
    method: 'POST',
    url: `${ROUTE_PREFIX}attachment${search === '' ? '' : `?${search}`}`,
    [Symbol.asyncIterator]: async function* () {
      yield body
    },
  }
  const result = await collectResponse(route, req)
  return {
    ...result,
    body: result.rawBody === undefined || result.rawBody.length === 0 ? undefined : JSON.parse(result.rawBody),
  }
}

/** Drive the image read route (GET or HEAD). */
async function readImageRoute(runtime, query, method = 'GET') {
  const route = runtime.routes.get(`${ROUTE_PREFIX}image`)
  assert.ok(route !== undefined, 'the image route is registered')
  const search = new URLSearchParams(query).toString()
  const req = { method, url: `${ROUTE_PREFIX}image${search === '' ? '' : `?${search}`}` }
  return await collectResponse(route, req)
}

function collectResponse(route, req) {
  let res
  const done = new Promise((resolve) => {
    res = {
      statusCode: undefined,
      headers: undefined,
      rawBody: undefined,
      writeHead(statusCode, headers) {
        this.statusCode = statusCode
        this.headers = headers
      },
      end(body) {
        this.rawBody = body
        resolve()
      },
    }
  })
  return route.handler(req, res).then(async () => {
    await done
    return { status: res.statusCode, headers: res.headers, rawBody: res.rawBody }
  })
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

/** Create a side session and return its id. */
async function createSideSession(runtime) {
  const created = await post(runtime, 'create', { sourceId: 'main-1' })
  assert.equal(created.body.ok, true)
  return created.body.sessionId
}

const BASE_EVENTS = [
  ev(0, 'user/message', userMsg('u1', 'main task')),
  ev(1, 'turn/start', { turn: 1 }),
  ev(2, 'assistant/message', { turn: 1, step: 1, message: assistantMsg('a1', 'working on it') }),
  ev(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ev(4, 'turn/start', { turn: 2 }),
  ev(5, 'user/message', userMsg('u2', 'in flight request')),
  ev(6, 'assistant/message', { turn: 2, step: 1, message: assistantMsg('a2', 'still working') }),
]

function boundaryEvent(events, inheritedEventCount) {
  return events.find(
    (event) => event.type === 'user/message' && event.seq >= inheritedEventCount
      && event.data?.source?.kind === 'plugin:side-chat',
  )
}

test('boundary prompt starts with the mandated first line and allows real mutations', () => {
  const text = sideConversationBoundaryPrompt('main-1', '')
  assert.equal(text.split('\n')[0], 'Side conversation boundary.')
  assert.match(text, /reference context only/)
  assert.match(text, /write/)
  assert.match(text, /edit/)
  assert.match(text, /bash/)
  assert.match(text, /make the change for real/)
  assert.doesNotMatch(text, /Do not modify files/)
  assert.doesNotMatch(text, /never modify/)
})

test('boundary prompt renders the recent parent context after the marker', () => {
  const text = sideConversationBoundaryPrompt('main-9', 'User: hi\nTool call: bash')
  assert.equal(text.split('\n')[0], 'Side conversation boundary.')
  assert.match(text, /main-9/)
  assert.match(text, /\[Recent activity from the parent session/)
  assert.ok(text.indexOf('User: hi') > text.indexOf('[Recent activity'))
  assert.equal(sideConversationBoundaryPrompt('main-9'), sideConversationBoundaryPrompt('main-9', ''))
})

test('developer instructions keep inherited history inert and mutations real', () => {
  const text = sideDeveloperInstructions()
  assert.match(text, /side conversation/)
  assert.match(text, /reference context/)
  assert.match(text, /write/)
  assert.match(text, /bash/)
  assert.match(text, /Never describe a change you did not make/)
  assert.doesNotMatch(text, /Do not modify files/)
})

test('completedTurnPrefix stops at the last completed turn', () => {
  assert.equal(completedTurnPrefix([]).length, 0)
  assert.equal(completedTurnPrefix([ev(0, 'user/message', userMsg('u', 'x')), ev(1, 'turn/start', { turn: 1 })]).length, 0)
  const prefix = completedTurnPrefix(BASE_EVENTS)
  assert.equal(prefix.length, 4)
  assert.equal(prefix.at(-1).type, 'turn/end')
  assert.equal(prefix.at(-1).seq, 3)
})

test('isSystemNoise recognizes harness plumbing only', () => {
  assert.equal(isSystemNoise('<system-reminder>hello</system-reminder>'), true)
  assert.equal(isSystemNoise('prefix\n<system_reminder>'), true)
  assert.equal(isSystemNoise('Current runtime context. This snapshot supersedes earlier ones.'), true)
  assert.equal(isSystemNoise('  Current runtime context: none.'), true)
  assert.equal(isSystemNoise('please continue'), false)
  assert.equal(isSystemNoise(''), false)
  assert.equal(isSystemNoise(undefined), false)
})

test('recentMainContext keeps conversation, filters noise and injected messages', () => {
  const events = [
    ev(0, 'user/message', userMsg('u1', 'real user words')),
    ev(1, 'user/message', userMsg('u2', '<system-reminder>catalog</system-reminder>')),
    ev(2, 'user/message', userMsg('u3', 'Current runtime context. snapshot', { kind: 'runtime-context' })),
    ev(3, 'user/message', userMsg('u4', 'injected note', { kind: 'goal' })),
    ev(4, 'assistant/message', { message: assistantMsg('a1', 'assistant words') }),
    ev(5, 'tool/call', { name: 'read' }),
    ev(6, 'tool/result', { message: { isError: true } }),
    ev(7, 'tool/result', { message: { isError: false } }),
  ]
  const text = recentMainContext(events, 0)
  assert.match(text, /^User: real user words/)
  assert.doesNotMatch(text, /catalog/)
  assert.doesNotMatch(text, /snapshot/)
  assert.doesNotMatch(text, /injected note/)
  assert.match(text, /Assistant: assistant words/)
  assert.match(text, /Tool call: read/)
  assert.match(text, /Tool result: failed/)
  assert.equal(text.match(/Tool result/g).length, 1)
})

test('recentMainContext honors fromSeq and keeps the tail under the cap', () => {
  const events = []
  for (let index = 0; index < 40; index += 1) {
    events.push(ev(index, 'user/message', userMsg(`u${index}`, `message-${index}-${'x'.repeat(200)}`)))
  }
  const capped = recentMainContext(events, 0, 600)
  assert.ok(capped.length <= 700, `capped length ${capped.length}`)
  assert.match(capped, /message-39-/)
  assert.doesNotMatch(capped, /message-0-/)
  assert.match(capped, /\(earlier parent-session context omitted\)/)
  const tailOnly = recentMainContext(events, 38)
  assert.match(tailOnly, /message-38-/)
  assert.match(tailOnly, /message-39-/)
  assert.doesNotMatch(tailOnly, /message-37-/)
})

test('projectQueue projects both inbox lists with placement', () => {
  const inbox = {
    nextStep: [userMsg('s1', 'steer me')],
    nextTurn: [userMsg('t1', 'queue me'), { id: 'empty', role: 'user', content: [] }],
  }
  assert.deepEqual(projectQueue(inbox), [
    { id: 's1', text: 'steer me', placement: 'steering' },
    { id: 't1', text: 'queue me', placement: 'queued' },
  ])
  assert.deepEqual(projectQueue(undefined), [])
  assert.deepEqual(projectQueue({}), [])
})

test('snapshotEntries shapes events, floors by seq, and truncates to the tail', () => {
  const events = [0, 1, 2, 3, 4].map((seq) => ev(seq, 'user/message', userMsg(`u${seq}`, `t${seq}`), seq === 4 ? { surfaceOp: 'append' } : {}))
  const floored = snapshotEntries(events, 2)
  assert.equal(floored.truncated, false)
  assert.deepEqual(floored.entries.map((entry) => entry.seq), [2, 3, 4])
  assert.deepEqual(Object.keys(floored.entries[0]).sort(), ['data', 'seq', 'time', 'type'])
  assert.equal(floored.entries[2].surfaceOp, 'append')
  const truncated = snapshotEntries(events, 0, 2)
  assert.equal(truncated.truncated, true)
  assert.deepEqual(truncated.entries.map((entry) => entry.seq), [3, 4])
})

test('apply registers every contract route', () => {
  const runtime = makeRuntime()
  apply(runtime.ctx)
  assert.deepEqual([...runtime.routes.keys()].sort(), [
    `${ROUTE_PREFIX}attachment`,
    `${ROUTE_PREFIX}cancel`,
    `${ROUTE_PREFIX}close`,
    `${ROUTE_PREFIX}create`,
    `${ROUTE_PREFIX}events`,
    `${ROUTE_PREFIX}image`,
    `${ROUTE_PREFIX}list`,
    `${ROUTE_PREFIX}prompt`,
    `${ROUTE_PREFIX}references`,
    `${ROUTE_PREFIX}resume`,
    `${ROUTE_PREFIX}snapshot`,
    `${ROUTE_PREFIX}status`,
  ])
})

test('list offers persisted side chats for restore', async () => {
  const sessionQuery = {
    listSessions: async () => [
      { header: { id: 'side-chat-aaaa', createdAt: 20 } },
      { header: { id: 'side-chat-bbbb', createdAt: 10 } },
      { header: { id: 'session-main' } },
    ],
  }
  const runtime = makeRuntime({ services: { sessionQuery }, parents: [makeParent({ events: BASE_EVENTS })] })
  apply(runtime.ctx)
  const listed = await post(runtime, 'list', { sourceId: 'main-1' })
  assert.equal(listed.body.ok, true)
  assert.deepEqual(listed.body.restorable.map((item) => item.sessionId), ['side-chat-aaaa', 'side-chat-bbbb'])
  assert.deepEqual(listed.body.restorable.map((item) => item.createdAt), [20, 10])
})

test('resume reattaches a persisted side session and serves its snapshot', async () => {
  const runtime = makeRuntime({ parents: [makeParent()] })
  apply(runtime.ctx)
  const resumed = await post(runtime, 'resume', { sessionId: 'side-chat-aaaa', sourceId: 'main-1', instanceKey: 'main-1#tab-a' })
  assert.equal(resumed.body.ok, true)
  assert.equal(runtime.resumed.length, 1)
  assert.equal(runtime.resumed[0].resumeSessionId, 'side-chat-aaaa')
  const snapshot = await post(runtime, 'snapshot', { sessionId: 'side-chat-aaaa' })
  assert.equal(snapshot.body.ok, true)
  assert.equal(snapshot.body.inheritedEventCount, 0)
  const listed = await post(runtime, 'list', { sourceId: 'main-1' })
  assert.equal(listed.body.sessions.some((item) => item.sessionId === 'side-chat-aaaa'), true)
})

test('create seeds the completed-turn prefix and is idempotent per source', async () => {
  const parent = makeParent({ events: BASE_EVENTS })
  const runtime = makeRuntime({ parents: [parent] })
  apply(runtime.ctx)

  const first = await post(runtime, 'create', { sourceId: 'main-1' })
  assert.equal(first.status, 200)
  assert.equal(first.headers['Content-Type'], 'application/json; charset=utf-8')
  assert.equal(first.body.ok, true)
  assert.match(first.body.sessionId, /^side-chat-/)
  assert.equal(first.body.inheritedEventCount, 4)

  const options = runtime.created[0]
  assert.equal(options.sessionId, first.body.sessionId)
  assert.equal(options.seed.length, 4)
  assert.equal(options.seed.at(-1).type, 'turn/end')
  assert.equal(options.inheritedEventCount, 4)
  assert.deepEqual(options.meta, { cwd: '/workspace', agentPreset: 'cordis', isSeeded: true, origin: 'subagent' })
  assert.equal(Object.hasOwn(options.meta, 'parentSession'), false)
  assert.deepEqual(options.agentOptions, { provider: 'deepseek', model: 'deepseek-flash', maxTokens: 2048 })

  const second = await post(runtime, 'create', { sourceId: 'main-1' })
  assert.equal(second.body.ok, true)
  assert.equal(second.body.sessionId, first.body.sessionId)
  assert.equal(second.body.inheritedEventCount, 4)
  assert.equal(runtime.created.length, 1)
})

test('create prefers the parent\'s logged request route over its initial options', async () => {
  const parent = makeParent({
    events: BASE_EVENTS,
    provider: 'deepseek',
    model: 'deepseek-flash',
    maxTokens: 2048,
    headerConfig: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high', maxTokens: 4096 },
  })
  const runtime = makeRuntime({ parents: [parent] })
  apply(runtime.ctx)
  const response = await post(runtime, 'create', { sourceId: 'main-1' })
  assert.equal(response.body.ok, true)
  assert.deepEqual(runtime.created[0].agentOptions, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'high',
    maxTokens: 4096,
  })
})

test('create inspects the live log, injects the boundary and composes the parent preset and policies', async () => {
  const parent = makeParent({ events: BASE_EVENTS })
  const runtime = makeRuntime({
    parents: [parent],
    services: {
      sandboxPolicy: { overrideOf: () => 'danger-full-access' },
      approval: { overrideOf: () => 'never' },
    },
  })
  apply(runtime.ctx)

  const response = await post(runtime, 'create', { sourceId: 'main-1' })
  assert.equal(response.body.ok, true)
  const child = runtime.handles[0]
  const events = child.agent.session.events

  const sandbox = events.find((event) => event.type === 'sandbox/mode')
  assert.deepEqual(sandbox.data, { mode: 'danger-full-access', source: 'delegation' })
  const approval = events.find((event) => event.type === 'approval/policy')
  assert.deepEqual(approval.data, { policy: 'never', source: 'delegation' })

  const boundary = boundaryEvent(events, 4)
  assert.ok(boundary !== undefined, 'boundary user/message injected')
  assert.equal(boundary.data.content[0].text.split('\n')[0], 'Side conversation boundary.')
  assert.deepEqual(boundary.data.source, { kind: 'plugin:side-chat' })
  assert.equal(boundary.surfaceOp, 'append')
  assert.match(boundary.data.content[0].text, /User: in flight request/)
  assert.match(boundary.data.content[0].text, /Assistant: still working/)
  assert.doesNotMatch(boundary.data.content[0].text, /main task/)

  assert.equal(child.childCtx.systemPrompt.sections.length, 1)
  assert.equal(child.childCtx.systemPrompt.sections[0].name, 'side-chat:instructions')
  assert.match(child.childCtx.systemPrompt.sections[0].text, /side conversation/)
})

test('create without a completed turn starts a fresh, unseeded side session', async () => {
  const parent = makeParent({ events: [ev(0, 'turn/start', { turn: 1 }), ev(1, 'user/message', userMsg('u1', 'live words'))] })
  const runtime = makeRuntime({ parents: [parent] })
  apply(runtime.ctx)

  const response = await post(runtime, 'create', { sourceId: 'main-1' })
  assert.equal(response.body.ok, true)
  assert.equal(response.body.inheritedEventCount, 0)
  const options = runtime.created[0]
  assert.equal(Object.hasOwn(options, 'seed'), false)
  assert.equal(Object.hasOwn(options, 'inheritedEventCount'), false)
  assert.equal(options.meta.isSeeded, undefined)
  const boundary = boundaryEvent(runtime.handles[0].agent.session.events, 0)
  assert.match(boundary.data.content[0].text, /User: live words/)
})

test('create is idempotent even for concurrent duplicate calls', async () => {
  const parent = makeParent({ events: BASE_EVENTS })
  const runtime = makeRuntime({ parents: [parent], createDelayMs: 10 })
  apply(runtime.ctx)

  const [first, second] = await Promise.all([
    post(runtime, 'create', { sourceId: 'main-1' }),
    post(runtime, 'create', { sourceId: 'main-1' }),
  ])
  assert.equal(first.body.ok, true)
  assert.equal(second.body.ok, true)
  assert.equal(first.body.sessionId, second.body.sessionId)
  assert.equal(runtime.created.length, 1)
})

test('create rejects unknown sources and folds creation failures', async () => {
  const runtime = makeRuntime()
  apply(runtime.ctx)
  const unknown = await post(runtime, 'create', { sourceId: 'nope' })
  assert.deepEqual(unknown.body, { ok: false, code: 'unknown-source', message: 'unknown source session "nope"' })

  const failing = makeRuntime({ parents: [makeParent()], createFailure: new Error('agent plugin melted') })
  apply(failing.ctx)
  const failed = await post(failing, 'create', { sourceId: 'main-1' })
  assert.equal(failed.body.ok, false)
  assert.equal(failed.body.code, 'create-failed')
  assert.equal(failed.body.message, 'agent plugin melted')
  assert.equal(failing.handles.length, 0)
})

test('prompt queues an identified user message and reports prompt failures', async () => {
  const runtime = makeRuntime({ parents: [makeParent({ events: BASE_EVENTS })] })
  apply(runtime.ctx)
  const created = await post(runtime, 'create', { sourceId: 'main-1' })
  const sessionId = created.body.sessionId

  const prompted = await post(runtime, 'prompt', { sessionId, text: 'change the config' })
  assert.deepEqual(prompted.body, { ok: true })
  const message = runtime.handles[0].agent.followups[0]
  assert.equal(message.role, 'user')
  assert.equal(message.content[0].text, 'change the config')
  assert.deepEqual(message.source, { kind: 'user' })
  assert.equal(typeof message.id, 'string')
  assert.notEqual(message.id, '')

  const empty = await post(runtime, 'prompt', { sessionId, text: '   ' })
  assert.deepEqual(empty.body, { ok: false, code: 'empty-prompt' })
  assert.equal(runtime.handles[0].agent.followups.length, 1)

  const unknown = await post(runtime, 'prompt', { sessionId: 'side-chat-missing', text: 'hi' })
  assert.deepEqual(unknown.body, { ok: false, code: 'not-found' })

  const failing = makeRuntime({
    parents: [makeParent({ events: BASE_EVENTS })],
    followupFailure: new Error('inbox closed'),
  })
  apply(failing.ctx)
  const failingCreated = await post(failing, 'create', { sourceId: 'main-1' })
  const failed = await post(failing, 'prompt', { sessionId: failingCreated.body.sessionId, text: 'hi' })
  assert.equal(failed.body.ok, false)
  assert.equal(failed.body.code, 'prompt-failed')
  assert.equal(failed.body.message, 'inbox closed')
})

test('cancel stops the running turn through the agent handle', async () => {
  const runtime = makeRuntime({ parents: [makeParent({ events: BASE_EVENTS })] })
  apply(runtime.ctx)
  const sessionId = (await post(runtime, 'create', { sourceId: 'main-1' })).body.sessionId
  assert.deepEqual((await post(runtime, 'cancel', { sessionId })).body, { ok: true })
  assert.deepEqual(runtime.handles[0].agent.cancels, [{ kind: 'user' }])
  assert.deepEqual((await post(runtime, 'cancel', { sessionId: 'side-chat-missing' })).body, { ok: false, code: 'not-found' })
})

test('status reports lifecycle state, the inbox queue and the last agent error', async () => {
  const runtime = makeRuntime({ parents: [makeParent({ events: BASE_EVENTS })] })
  apply(runtime.ctx)
  const sessionId = (await post(runtime, 'create', { sourceId: 'main-1' })).body.sessionId
  const agent = runtime.handles[0].agent
  agent.status = 'running'
  agent.inbox.nextStep = [userMsg('queue-2', 'steer me')]
  agent.inbox.nextTurn = [userMsg('queue-1', 'later')]
  runtime.listeners.get('agent/error')({ agent, turn: 1, step: 1, error: new Error('model exploded') })

  const status = await post(runtime, 'status', { sessionId })
  assert.deepEqual(status.body, {
    ok: true,
    status: 'running',
    running: true,
    queue: [
      { id: 'queue-2', text: 'steer me', placement: 'steering' },
      { id: 'queue-1', text: 'later', placement: 'queued' },
    ],
    lastError: 'model exploded',
  })
  assert.deepEqual((await post(runtime, 'status', { sessionId: 'side-chat-missing' })).body, { ok: false, code: 'not-found' })
})

test('snapshot serves only owned sessions and increments from the fork floor', async () => {
  const runtime = makeRuntime({ parents: [makeParent({ events: BASE_EVENTS })] })
  apply(runtime.ctx)
  const sessionId = (await post(runtime, 'create', { sourceId: 'main-1' })).body.sessionId
  const agent = runtime.handles[0].agent
  agent.session.append('assistant/message', { turn: 3, step: 1, message: assistantMsg('a3', 'side answer') }, { surfaceOp: 'append' })
  const before = agent.session.events.length

  const full = await post(runtime, 'snapshot', { sessionId })
  assert.equal(full.body.ok, true)
  assert.equal(full.body.inheritedEventCount, 4)
  assert.equal(full.body.running, false)
  assert.equal(full.body.status, 'idle')
  assert.equal(full.body.lastError, null)
  assert.equal(full.body.truncated, false)
  assert.equal(full.body.entries[0].seq, 4)
  assert.ok(full.body.entries.every((entry) => entry.seq >= 4))
  assert.ok(full.body.entries.some((entry) => entry.type === 'user/message' && entry.data.source.kind === 'plugin:side-chat'))
  assert.ok(full.body.entries.some((entry) => entry.type === 'assistant/message'))
  assert.equal(agent.session.events.length, before)

  const incremental = await post(runtime, 'snapshot', { sessionId, fromSeq: 5 })
  assert.ok(incremental.body.entries.every((entry) => entry.seq >= 5))

  const belowFloor = await post(runtime, 'snapshot', { sessionId, fromSeq: 1 })
  assert.equal(belowFloor.body.entries[0].seq, 4)

  const missing = await post(runtime, 'snapshot', { sessionId: 'side-chat-missing' })
  assert.deepEqual(missing.body, { ok: false, code: 'not-found' })
})

test('snapshot reports running state and the last error without waking the agent', async () => {
  const runtime = makeRuntime({ parents: [makeParent({ events: BASE_EVENTS })] })
  apply(runtime.ctx)
  const sessionId = (await post(runtime, 'create', { sourceId: 'main-1' })).body.sessionId
  const agent = runtime.handles[0].agent
  agent.status = 'running'
  runtime.listeners.get('agent/error')({ agent, error: new Error('boom') })
  const snapshot = await post(runtime, 'snapshot', { sessionId })
  assert.equal(snapshot.body.status, 'running')
  assert.equal(snapshot.body.running, true)
  assert.equal(snapshot.body.lastError, 'boom')
  assert.equal(agent.followups.length, 0)
  assert.equal(agent.cancels.length, 0)
})

test('list reports live side sessions', async () => {
  const runtime = makeRuntime({ parents: [makeParent({ events: BASE_EVENTS })] })
  apply(runtime.ctx)
  assert.deepEqual((await post(runtime, 'list', {})).body, { ok: true, sessions: [], restorable: [] })
  const sessionId = (await post(runtime, 'create', { sourceId: 'main-1' })).body.sessionId
  assert.deepEqual((await post(runtime, 'list', {})).body, { ok: true, sessions: [{ sessionId, sourceId: 'main-1' }], restorable: [] })
})

test('distinct instance keys create one side session per tab instance', async () => {
  const parent = makeParent({ events: BASE_EVENTS })
  const runtime = makeRuntime({ parents: [parent] })
  apply(runtime.ctx)

  const first = await post(runtime, 'create', { sourceId: 'main-1', instanceKey: 'main-1#tab-a' })
  const second = await post(runtime, 'create', { sourceId: 'main-1', instanceKey: 'main-1#tab-b' })
  assert.equal(first.body.ok, true)
  assert.equal(second.body.ok, true)
  assert.notEqual(first.body.sessionId, second.body.sessionId)
  assert.equal(first.body.inheritedEventCount, 4)
  assert.equal(second.body.inheritedEventCount, 4)
  assert.equal(runtime.created.length, 2)
  for (const options of runtime.created) {
    assert.equal(options.seed.length, 4)
    assert.equal(options.seed.at(-1).type, 'turn/end')
    assert.equal(options.inheritedEventCount, 4)
  }
})

test('create is idempotent for the same instance key', async () => {
  const runtime = makeRuntime({ parents: [makeParent({ events: BASE_EVENTS })] })
  apply(runtime.ctx)

  const first = await post(runtime, 'create', { sourceId: 'main-1', instanceKey: 'main-1#tab-a' })
  const second = await post(runtime, 'create', { sourceId: 'main-1', instanceKey: 'main-1#tab-a' })
  assert.equal(first.body.ok, true)
  assert.equal(second.body.ok, true)
  assert.equal(second.body.sessionId, first.body.sessionId)
  assert.equal(second.body.inheritedEventCount, 4)
  assert.equal(runtime.created.length, 1)
})

test('concurrent creates with the same instance key dedupe to one side session', async () => {
  const runtime = makeRuntime({ parents: [makeParent({ events: BASE_EVENTS })], createDelayMs: 10 })
  apply(runtime.ctx)

  const [first, second] = await Promise.all([
    post(runtime, 'create', { sourceId: 'main-1', instanceKey: 'main-1#tab-a' }),
    post(runtime, 'create', { sourceId: 'main-1', instanceKey: 'main-1#tab-a' }),
  ])
  assert.equal(first.body.ok, true)
  assert.equal(second.body.ok, true)
  assert.equal(first.body.sessionId, second.body.sessionId)
  assert.equal(runtime.created.length, 1)
})

test('closing one instance leaves the other alive and allows the key a new session', async () => {
  const runtime = makeRuntime({ parents: [makeParent({ events: BASE_EVENTS })] })
  apply(runtime.ctx)

  const first = await post(runtime, 'create', { sourceId: 'main-1', instanceKey: 'main-1#tab-a' })
  const second = await post(runtime, 'create', { sourceId: 'main-1', instanceKey: 'main-1#tab-b' })
  assert.deepEqual((await post(runtime, 'close', { sessionId: first.body.sessionId })).body, { ok: true })
  assert.deepEqual((await post(runtime, 'list', {})).body, {
    ok: true,
    sessions: [{ sessionId: second.body.sessionId, sourceId: 'main-1' }],
    restorable: [],
  })
  assert.equal(runtime.disposed.includes(first.body.sessionId), true)
  assert.equal(runtime.disposed.includes(second.body.sessionId), false)

  const recreated = await post(runtime, 'create', { sourceId: 'main-1', instanceKey: 'main-1#tab-a' })
  assert.equal(recreated.body.ok, true)
  assert.notEqual(recreated.body.sessionId, first.body.sessionId)
  assert.notEqual(recreated.body.sessionId, second.body.sessionId)
  assert.equal(runtime.created.length, 3)
  const listed = (await post(runtime, 'list', {})).body.sessions
  assert.deepEqual(
    listed.map((entry) => entry.sessionId).sort(),
    [second.body.sessionId, recreated.body.sessionId].sort(),
  )
})

test('list reports both instances of a parent with their source id', async () => {
  const runtime = makeRuntime({ parents: [makeParent({ events: BASE_EVENTS })] })
  apply(runtime.ctx)

  const first = await post(runtime, 'create', { sourceId: 'main-1', instanceKey: 'main-1#tab-a' })
  const second = await post(runtime, 'create', { sourceId: 'main-1', instanceKey: 'main-1#tab-b' })
  assert.deepEqual((await post(runtime, 'list', {})).body, {
    ok: true,
    sessions: [
      { sessionId: first.body.sessionId, sourceId: 'main-1' },
      { sessionId: second.body.sessionId, sourceId: 'main-1' },
    ],
    restorable: [],
  })
})

test('artifactDirectory only accepts the session\'s own absolute directory', () => {
  assert.equal(
    artifactDirectory({ id: 'side-chat-x' }, { path: '/sessions/project/side-chat-x/session.v4.jsonl' }),
    '/sessions/project/side-chat-x',
  )
  assert.equal(artifactDirectory({ id: 'side-chat-x' }, { path: 'relative/side-chat-x/session.v4.jsonl' }), undefined)
  assert.equal(artifactDirectory({ id: 'side-chat-x' }, { path: '/sessions/project/other-id/session.v4.jsonl' }), undefined)
  assert.equal(artifactDirectory({ id: 'side-chat-x' }, { path: '/sessions/project/side-chat-x' }), undefined)
  assert.equal(artifactDirectory({ id: 'side-chat-x' }, { path: 7 }), undefined)
  assert.equal(artifactDirectory({}, { path: '/sessions/project/side-chat-x/session.v4.jsonl' }), undefined)
})

test('close removes the handle first, disposes, then deletes the persisted artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'side-chat-close-'))
  try {
    const runtime = makeRuntime({ parents: [makeParent({ events: BASE_EVENTS })] })
    runtime.resolvedServices.sessionPersistence = {
      locate(header) {
        runtime.locateCalls.push(header.id)
        runtime.order.push('locate')
        return { kind: 'jsonl', path: join(root, 'project', header.id, 'session.v4.jsonl') }
      },
    }
    apply(runtime.ctx)
    const sessionId = (await post(runtime, 'create', { sourceId: 'main-1' })).body.sessionId
    const dir = join(root, 'project', sessionId)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.v4.jsonl'), '{}\n')
    await writeFile(join(dir, 'session.lock'), '')

    const closed = await post(runtime, 'close', { sessionId })
    assert.deepEqual(closed.body, { ok: true })
    assert.deepEqual(runtime.locateCalls, [sessionId])
    assert.deepEqual(runtime.order, ['locate', 'dispose'])
    assert.deepEqual(runtime.timeouts, [300])
    assert.equal(await access(dir).then(() => true, () => false), false, 'artifact directory removed')

    assert.deepEqual((await post(runtime, 'close', { sessionId })).body, { ok: false, code: 'not-found' })
    assert.deepEqual((await post(runtime, 'list', {})).body, { ok: true, sessions: [], restorable: [] })

    const recreated = await post(runtime, 'create', { sourceId: 'main-1' })
    assert.equal(recreated.body.ok, true)
    assert.notEqual(recreated.body.sessionId, sessionId)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('close tolerates an already-missing artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'side-chat-missing-'))
  try {
    const runtime = makeRuntime({ parents: [makeParent({ events: BASE_EVENTS })] })
    runtime.resolvedServices.sessionPersistence = {
      locate(header) {
        return { kind: 'jsonl', path: join(root, 'project', header.id, 'session.v4.jsonl') }
      },
    }
    apply(runtime.ctx)
    const sessionId = (await post(runtime, 'create', { sourceId: 'main-1' })).body.sessionId
    assert.deepEqual((await post(runtime, 'close', { sessionId })).body, { ok: true })
    assert.equal(runtime.warnings.some((warning) => warning.includes('artifact cleanup')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('close refuses to delete a directory that is not the session\'s own', async () => {
  const root = await mkdtemp(join(tmpdir(), 'side-chat-guard-'))
  try {
    const otherDir = join(root, 'not-the-session')
    await mkdir(otherDir, { recursive: true })
    await writeFile(join(otherDir, 'session.v4.jsonl'), '{}\n')
    const runtime = makeRuntime({ parents: [makeParent({ events: BASE_EVENTS })] })
    runtime.resolvedServices.sessionPersistence = {
      locate() {
        return { kind: 'jsonl', path: join(otherDir, 'session.v4.jsonl') }
      },
    }
    apply(runtime.ctx)
    const sessionId = (await post(runtime, 'create', { sourceId: 'main-1' })).body.sessionId
    assert.deepEqual((await post(runtime, 'close', { sessionId })).body, { ok: true })
    assert.equal(await access(otherDir).then(() => true, () => false), true, 'guarded directory survives')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('close still succeeds when the artifact cannot be deleted, and reports dispose failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'side-chat-rmfail-'))
  try {
    const blocker = join(root, 'not-a-directory')
    await writeFile(blocker, 'x')
    const runtime = makeRuntime({ parents: [makeParent({ events: BASE_EVENTS })] })
    runtime.resolvedServices.sessionPersistence = {
      locate(header) {
        return { kind: 'jsonl', path: join(blocker, header.id, 'session.v4.jsonl') }
      },
    }
    apply(runtime.ctx)
    const sessionId = (await post(runtime, 'create', { sourceId: 'main-1' })).body.sessionId
    assert.deepEqual((await post(runtime, 'close', { sessionId })).body, { ok: true })
    assert.ok(runtime.warnings.some((warning) => warning.includes('artifact cleanup')))

    const disposeFailure = makeRuntime({ parents: [makeParent({ events: BASE_EVENTS })], disposeFailure: new Error('dispose exploded') })
    apply(disposeFailure.ctx)
    const failingId = (await post(disposeFailure, 'create', { sourceId: 'main-1' })).body.sessionId
    const failed = await post(disposeFailure, 'close', { sessionId: failingId })
    assert.equal(failed.body.ok, false)
    assert.equal(failed.body.code, 'dispose-failed')
    assert.equal(failed.body.message, 'dispose exploded')
    assert.deepEqual((await post(disposeFailure, 'list', {})).body, { ok: true, sessions: [], restorable: [] })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('close skips artifact deletion when the backend has no locate', async () => {
  const runtime = makeRuntime({ parents: [makeParent({ events: BASE_EVENTS })] })
  apply(runtime.ctx)
  const sessionId = (await post(runtime, 'create', { sourceId: 'main-1' })).body.sessionId
  assert.deepEqual((await post(runtime, 'close', { sessionId })).body, { ok: true })
  assert.deepEqual(runtime.timeouts, [])
  assert.equal(runtime.warnings.some((warning) => warning.includes('artifact cleanup')), false)
})

test('plugin unload during creation disposes the late handle and refuses new work', async () => {
  const runtime = makeRuntime({ parents: [makeParent({ events: BASE_EVENTS })], createDelayMs: 10 })
  apply(runtime.ctx)
  const inFlight = post(runtime, 'create', { sourceId: 'main-1' })
  await new Promise((resolve) => setTimeout(resolve, 1))
  runtime.effects.at(-1)()
  const response = await inFlight
  assert.equal(response.body.ok, false)
  assert.equal(response.body.code, 'internal')
  assert.match(response.body.message, /unloading/)
  assert.equal(runtime.disposed.length, 1)

  const after = await post(runtime, 'create', { sourceId: 'main-1' })
  assert.equal(after.body.ok, false)
  assert.equal(after.body.code, 'internal')
})

test('plugin unload disposes every live side session', async () => {
  const runtime = makeRuntime({ parents: [makeParent({ events: BASE_EVENTS })] })
  apply(runtime.ctx)
  await post(runtime, 'create', { sourceId: 'main-1' })
  assert.equal(runtime.disposed.length, 0)
  const cleanup = runtime.effects.at(-1)
  assert.equal(typeof cleanup, 'function')
  cleanup()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(runtime.disposed.length, 1)
})

test('routeHandler folds parser and handler failures into JSON without throwing', async () => {
  const warnings = []
  const logger = { warn: (message) => warnings.push(message) }

  const boom = routeHandler(() => {
    throw new Error('handler exploded')
  }, logger)
  const first = await invokeHandler(boom, JSON.stringify({ a: 1 }))
  assert.equal(first.status, 200)
  assert.deepEqual(JSON.parse(first.rawBody), { ok: false, code: 'internal', message: 'handler exploded' })
  assert.equal(warnings.length, 1)

  const malformed = routeHandler(() => ({ ok: true }))
  const second = await invokeHandler(malformed, '{not json')
  assert.equal(second.status, 200)
  const secondBody = JSON.parse(second.rawBody)
  assert.equal(secondBody.ok, false)
  assert.equal(secondBody.code, 'internal')
  assert.match(secondBody.message, /invalid request body/)

  const passthrough = routeHandler((args) => ({ ok: true, echo: args }))
  const third = await invokeHandler(passthrough, '{"value":7}')
  assert.deepEqual(JSON.parse(third.rawBody), { ok: true, echo: { value: 7 } })
  const fourth = await invokeHandler(passthrough, '')
  assert.deepEqual(JSON.parse(fourth.rawBody), { ok: true, echo: {} })
})

async function invokeHandler(handler, rawBody) {
  const req = {
    [Symbol.asyncIterator]: async function* () {
      if (rawBody !== '') yield rawBody
    },
  }
  let res
  const done = new Promise((resolve) => {
    res = {
      statusCode: undefined,
      headers: undefined,
      rawBody: undefined,
      writeHead(statusCode, headers) {
        this.statusCode = statusCode
        this.headers = headers
      },
      end(body) {
        this.rawBody = body
        resolve()
      },
    }
  })
  await handler(req, res)
  await done
  return { status: res.statusCode, headers: res.headers, rawBody: res.rawBody }
}

// --- live token streaming (host half) -------------------------------------

function startFrame(attemptId, revision = 1, turn = 1, step = 1) {
  return { type: 'start', attemptId, revision, turn, step }
}

function chunkFrame(attemptId, revision, index, chunk) {
  return { type: 'chunk', attemptId, revision, index, time: 1000 + index, chunk }
}

function endFrame(attemptId, revision, index, outcome = { kind: 'abandoned' }) {
  return { type: 'end', attemptId, revision, index, outcome }
}

function emitStream(runtime, agent, frame) {
  const listener = runtime.listeners.get('agent/assistant-stream')
  assert.equal(typeof listener, 'function', 'agent/assistant-stream listener is registered')
  listener({ agent, frame })
}

function emitSessionEvent(runtime, session, event) {
  const listener = runtime.listeners.get('session/event')
  assert.equal(typeof listener, 'function', 'session/event listener is registered')
  listener(session, event)
}

function makeStreamResponse() {
  const chunks = []
  const listeners = new Map()
  return {
    statusCode: undefined,
    headers: undefined,
    writableEnded: false,
    chunks,
    listeners,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode
      this.headers = headers
    },
    write(chunk) {
      chunks.push(String(chunk))
      return true
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(String(chunk))
      this.writableEnded = true
    },
    on(eventName, callback) {
      listeners.set(eventName, callback)
    },
    off(eventName, callback) {
      if (listeners.get(eventName) === callback) listeners.delete(eventName)
    },
    text() {
      return chunks.join('')
    },
    frames() {
      return parseSse(this.text())
    },
  }
}

function makeStreamRequest(rawBody) {
  const listeners = new Map()
  return {
    method: 'POST',
    listeners,
    on(eventName, callback) {
      listeners.set(eventName, callback)
    },
    off(eventName, callback) {
      if (listeners.get(eventName) === callback) listeners.delete(eventName)
    },
    [Symbol.asyncIterator]: async function* () {
      if (rawBody !== undefined) yield rawBody
    },
  }
}

function parseSse(text) {
  const frames = []
  for (const block of text.split('\n\n')) {
    if (block === '') continue
    const frame = { event: undefined, data: undefined, comment: false }
    for (const line of block.split('\n')) {
      if (line.startsWith(': ')) {
        frame.comment = true
      } else if (line.startsWith('event: ')) {
        frame.event = line.slice('event: '.length)
      } else if (line.startsWith('data: ')) {
        frame.data = JSON.parse(line.slice('data: '.length))
      }
    }
    frames.push(frame)
  }
  return frames
}

async function openStream(runtime, args) {
  const route = runtime.routes.get(`${ROUTE_PREFIX}events`)
  assert.ok(route !== undefined, 'route events is registered')
  const req = makeStreamRequest(typeof args === 'string' ? args : JSON.stringify(args ?? {}))
  const res = makeStreamResponse()
  await route.handler(req, res)
  return {
    req,
    res,
    frames: () => res.frames(),
    lastFrame: () => res.frames().at(-1),
    close: () => req.listeners.get('close')?.(),
  }
}

async function postRaw(runtime, routeName, rawBody) {
  const route = runtime.routes.get(`${ROUTE_PREFIX}${routeName}`)
  assert.ok(route !== undefined, `route ${routeName} is registered`)
  const req = makeStreamRequest(rawBody)
  const res = makeStreamResponse()
  await route.handler(req, res)
  const rawText = res.text()
  return {
    status: res.statusCode,
    headers: res.headers,
    rawBody: rawText,
    body: rawText === '' ? undefined : JSON.parse(rawText),
  }
}

async function startSideSession(runtime) {
  const created = await post(runtime, 'create', { sourceId: 'main-1' })
  assert.equal(created.body.ok, true)
  const handle = runtime.handles.at(-1)
  return { sessionId: created.body.sessionId, handle, agent: handle.agent }
}

test('LiveAttemptState folds start, deltas and block-end into ordered renderable blocks', () => {
  const state = new LiveAttemptState()
  assert.deepEqual(state.snapshot(), { revision: 0, activeAttempt: null })

  assert.equal(state.accept(startFrame('attempt-1')), true)
  state.accept(chunkFrame('attempt-1', 2, 0, { type: 'block-start', index: 0, blockType: 'reasoning' }))
  state.accept(chunkFrame('attempt-1', 3, 1, { type: 'reasoning-delta', index: 0, text: 'thinking ' }))
  state.accept(chunkFrame('attempt-1', 4, 2, { type: 'reasoning-delta', index: 0, text: 'hard' }))
  state.accept(chunkFrame('attempt-1', 5, 3, { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking hard' } }))
  state.accept(chunkFrame('attempt-1', 6, 4, { type: 'block-start', index: 1, blockType: 'text' }))
  state.accept(chunkFrame('attempt-1', 7, 5, { type: 'text-delta', index: 1, text: 'Hello' }))
  state.accept(chunkFrame('attempt-1', 8, 6, { type: 'text-delta', index: 1, text: ' world' }))
  // Tool calls may stream without a preceding block-start.
  state.accept(chunkFrame('attempt-1', 9, 7, { type: 'tool-call-delta', index: 2, id: 'call-1', name: 'bash', argumentsDelta: '{"cmd":' }))
  state.accept(chunkFrame('attempt-1', 10, 8, { type: 'tool-call-delta', index: 2, id: 'call-1', argumentsDelta: '"ls"}' }))
  // Usage and finish chunks are accepted by the assembler but never render.
  state.accept(chunkFrame('attempt-1', 11, 9, { type: 'usage', usage: {} }))
  state.accept(chunkFrame('attempt-1', 12, 10, { type: 'finish', reason: 'stop' }))

  const live = state.snapshot()
  assert.equal(live.revision, 12)
  assert.deepEqual(live.activeAttempt, {
    attemptId: 'attempt-1',
    turn: 1,
    step: 1,
    nextIndex: 11,
    blocks: [
      { kind: 'reasoning', text: 'thinking hard' },
      { kind: 'text', text: 'Hello world' },
      { kind: 'tool-call', callId: 'call-1', name: 'bash', argsRaw: '{"cmd":"ls"}' },
    ],
  })

  // block-end finalizes: re-close and post-finalize deltas are ignored
  state.accept(chunkFrame('attempt-1', 13, 11, { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello world' } }))
  state.accept(chunkFrame('attempt-1', 14, 12, { type: 'text-delta', index: 1, text: '!!!' }))
  assert.deepEqual(state.snapshot().activeAttempt.blocks[1], { kind: 'text', text: 'Hello world' })

  state.accept(endFrame('attempt-1', 15, 13))
  assert.deepEqual(state.snapshot(), { revision: 15, activeAttempt: null })

  // Unknown block types never render, empty text blocks are omitted, and a
  // tool call without id/name defaults them to empty strings.
  const other = new LiveAttemptState()
  other.accept(startFrame('attempt-2'))
  other.accept(chunkFrame('attempt-2', 2, 0, { type: 'block-start', index: 0, blockType: 'image' }))
  other.accept(chunkFrame('attempt-2', 3, 1, { type: 'block-end', index: 0, block: { type: 'image' } }))
  other.accept(chunkFrame('attempt-2', 4, 2, { type: 'block-start', index: 1, blockType: 'text' }))
  other.accept(chunkFrame('attempt-2', 5, 3, { type: 'tool-call-delta', index: 2, argumentsDelta: '{}' }))
  assert.deepEqual(other.snapshot().activeAttempt.blocks, [
    { kind: 'tool-call', callId: '', name: '', argsRaw: '{}' },
  ])
})

test('LiveAttemptState ignores malformed frames and clears the attempt on a revision gap', () => {
  const state = new LiveAttemptState()
  assert.equal(state.accept(null), false)
  assert.equal(state.accept('nope'), false)
  assert.equal(state.accept({ type: 'chunk', revision: 1.5, index: 0, attemptId: 'a' }), false)
  assert.equal(state.accept({ type: 'mystery', revision: 1 }), false)
  assert.deepEqual(state.snapshot(), { revision: 0, activeAttempt: null })

  state.accept(startFrame('attempt-1'))
  state.accept(chunkFrame('attempt-1', 2, 0, { type: 'block-start', index: 0, blockType: 'text' }))
  state.accept(chunkFrame('attempt-1', 3, 1, { type: 'text-delta', index: 0, text: 'partial' }))
  assert.equal(state.snapshot().activeAttempt.nextIndex, 2)

  // A revision gap invalidates the baseline and drops the partial attempt.
  assert.equal(state.accept(chunkFrame('attempt-1', 9, 2, { type: 'text-delta', index: 0, text: 'tail' })), true)
  assert.deepEqual(state.snapshot(), { revision: 9, activeAttempt: null })

  // Dense revisions with an out-of-order frame index are dropped too.
  state.accept(startFrame('attempt-1', 10))
  state.accept(chunkFrame('attempt-1', 11, 5, { type: 'text-delta', index: 0, text: 'x' }))
  assert.deepEqual(state.snapshot(), { revision: 11, activeAttempt: null })

  // A restarted agent lifecycle (revision back to 1) resets the baseline.
  state.accept(startFrame('attempt-2', 1, 2, 1))
  assert.deepEqual(state.snapshot(), {
    revision: 1,
    activeAttempt: { attemptId: 'attempt-2', turn: 2, step: 1, nextIndex: 0, blocks: [] },
  })
})

test('snapshot serves the live attempt and drops it when the message commits', async () => {
  const runtime = makeRuntime({ parents: [makeParent({ events: BASE_EVENTS })] })
  apply(runtime.ctx)
  const { sessionId, agent } = await startSideSession(runtime)

  emitStream(runtime, agent, startFrame('attempt-1'))
  emitStream(runtime, agent, chunkFrame('attempt-1', 2, 0, { type: 'block-start', index: 0, blockType: 'text' }))
  emitStream(runtime, agent, chunkFrame('attempt-1', 3, 1, { type: 'text-delta', index: 0, text: 'streaming ' }))

  const during = await post(runtime, 'snapshot', { sessionId })
  assert.equal(during.body.live.revision, 3)
  assert.equal(during.body.live.activeAttempt.attemptId, 'attempt-1')
  assert.equal(during.body.live.activeAttempt.nextIndex, 2)
  assert.deepEqual(during.body.live.activeAttempt.blocks, [{ kind: 'text', text: 'streaming ' }])

  // A committed message for a different turn/step must not settle the attempt.
  const unrelated = agent.session.append('assistant/message', { turn: 2, step: 1, message: assistantMsg('a8', 'other turn') }, { surfaceOp: 'append' })
  emitSessionEvent(runtime, agent.session, unrelated)
  assert.equal((await post(runtime, 'snapshot', { sessionId })).body.live.activeAttempt.attemptId, 'attempt-1')

  // The matching committed message settles it immediately, before the end frame.
  const committed = agent.session.append('assistant/message', { turn: 1, step: 1, message: assistantMsg('a9', 'streaming answer') }, { surfaceOp: 'append' })
  emitSessionEvent(runtime, agent.session, committed)
  const after = await post(runtime, 'snapshot', { sessionId })
  assert.equal(after.body.live.activeAttempt, null)
  assert.equal(after.body.live.revision, 3)

  // The matching end frame is harmless after settlement.
  emitStream(runtime, agent, endFrame('attempt-1', 4, 2, { kind: 'committed', eventType: 'assistant/message', seq: committed.seq }))
  const ended = await post(runtime, 'snapshot', { sessionId })
  assert.equal(ended.body.live.activeAttempt, null)
  assert.equal(ended.body.live.revision, 4)
})

test('events route streams hello, live, committed event, status and error frames', async () => {
  const runtime = makeRuntime({ parents: [makeParent({ events: BASE_EVENTS })] })
  apply(runtime.ctx)
  const { sessionId, agent } = await startSideSession(runtime)

  const savedSetInterval = globalThis.setInterval
  const savedClearInterval = globalThis.clearInterval
  const intervals = []
  globalThis.setInterval = (callback, delayMs) => {
    const handle = {
      callback,
      delayMs,
      unrefCalled: false,
      cleared: false,
      unref() {
        this.unrefCalled = true
        return this
      },
    }
    intervals.push(handle)
    return handle
  }
  globalThis.clearInterval = (handle) => {
    if (handle !== null && typeof handle === 'object') handle.cleared = true
  }
  try {
    const stream = await openStream(runtime, { sessionId })
    const { res } = stream
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['Content-Type'], 'text/event-stream; charset=utf-8')
    assert.equal(res.headers['Cache-Control'], 'no-cache, no-transform')
    assert.equal(res.headers.Connection, 'keep-alive')
    assert.equal(res.headers['X-Accel-Buffering'], 'no')

    const hello = stream.frames()[0]
    assert.equal(hello.event, 'hello')
    assert.equal(hello.data.ok, true)
    assert.equal(hello.data.inheritedEventCount, 4)
    assert.equal(hello.data.status, 'idle')
    assert.equal(hello.data.running, false)
    assert.equal(hello.data.lastError, null)
    assert.equal(hello.data.truncated, false)
    assert.equal(hello.data.live, null)
    assert.equal(hello.data.entries[0].seq, 4)
    assert.ok(hello.data.entries.some((entry) => entry.type === 'user/message' && entry.data.source.kind === 'plugin:side-chat'))

    emitStream(runtime, agent, startFrame('attempt-1'))
    emitStream(runtime, agent, chunkFrame('attempt-1', 2, 0, { type: 'block-start', index: 0, blockType: 'text' }))
    emitStream(runtime, agent, chunkFrame('attempt-1', 3, 1, { type: 'text-delta', index: 0, text: 'streaming' }))
    const liveFrame = stream.lastFrame()
    assert.equal(liveFrame.event, 'live')
    assert.equal(liveFrame.data.live.revision, 3)
    assert.deepEqual(liveFrame.data.live.activeAttempt.blocks, [{ kind: 'text', text: 'streaming' }])

    const committed = agent.session.append('assistant/message', { turn: 1, step: 1, message: assistantMsg('a9', 'streaming answer') }, { surfaceOp: 'append' })
    emitSessionEvent(runtime, agent.session, committed)
    const framesAfterCommit = stream.frames()
    const settled = framesAfterCommit.filter((frame) => frame.event === 'live').at(-1)
    assert.equal(settled.data.live.activeAttempt, null)
    const eventFrame = framesAfterCommit.filter((frame) => frame.event === 'event').at(-1)
    assert.equal(eventFrame.data.entry.seq, committed.seq)
    assert.equal(eventFrame.data.entry.type, 'assistant/message')
    assert.equal(eventFrame.data.entry.surfaceOp, 'append')

    agent.status = 'running'
    runtime.listeners.get('agent/status')({ agent, status: 'running' })
    assert.deepEqual(stream.lastFrame(), { event: 'status', data: { status: 'running', running: true }, comment: false })

    runtime.listeners.get('agent/error')({ agent, error: new Error('model exploded') })
    assert.deepEqual(stream.lastFrame(), { event: 'error', data: { message: 'model exploded' }, comment: false })
    assert.equal((await post(runtime, 'snapshot', { sessionId })).body.lastError, 'model exploded')

    assert.equal(intervals.length, 1)
    assert.equal(intervals[0].delayMs, 15000)
    assert.equal(intervals[0].unrefCalled, true)
    intervals[0].callback()
    assert.ok(res.text().endsWith(': ping\n\n'))

    stream.close()
    assert.equal(res.writableEnded, true)
    assert.equal(intervals[0].cleared, true)
    const writesAfterClose = res.chunks.length
    emitStream(runtime, agent, startFrame('attempt-2', 4, 2, 1))
    runtime.listeners.get('agent/status')({ agent, status: 'idle' })
    assert.equal(res.chunks.length, writesAfterClose)
  } finally {
    globalThis.setInterval = savedSetInterval
    globalThis.clearInterval = savedClearInterval
  }
})

test('events hello carries live state folded before the stream connected', async () => {
  const runtime = makeRuntime({ parents: [makeParent({ events: BASE_EVENTS })] })
  apply(runtime.ctx)
  const { sessionId, agent } = await startSideSession(runtime)

  emitStream(runtime, agent, startFrame('attempt-1'))
  emitStream(runtime, agent, chunkFrame('attempt-1', 2, 0, { type: 'block-start', index: 0, blockType: 'text' }))
  emitStream(runtime, agent, chunkFrame('attempt-1', 3, 1, { type: 'text-delta', index: 0, text: 'early' }))

  const stream = await openStream(runtime, { sessionId })
  assert.deepEqual(stream.frames()[0].data.live, {
    revision: 3,
    activeAttempt: { attemptId: 'attempt-1', turn: 1, step: 1, nextIndex: 2, blocks: [{ kind: 'text', text: 'early' }] },
  })

  emitStream(runtime, agent, chunkFrame('attempt-1', 4, 2, { type: 'text-delta', index: 0, text: ' more' }))
  assert.deepEqual(stream.lastFrame().data.live.activeAttempt.blocks, [{ kind: 'text', text: 'early more' }])
  stream.close()
})

test('events route answers JSON failures and honors a requested fromSeq', async () => {
  const runtime = makeRuntime({ parents: [makeParent({ events: BASE_EVENTS })] })
  apply(runtime.ctx)
  const { sessionId, agent } = await startSideSession(runtime)

  const unknown = await post(runtime, 'events', { sessionId: 'side-chat-missing' })
  assert.equal(unknown.status, 200)
  assert.equal(unknown.headers['Content-Type'], 'application/json; charset=utf-8')
  assert.deepEqual(unknown.body, { ok: false, code: 'not-found' })

  const malformed = await postRaw(runtime, 'events', '{not json')
  assert.equal(malformed.status, 200)
  assert.equal(malformed.headers['Content-Type'], 'application/json; charset=utf-8')
  assert.equal(malformed.body.ok, false)
  assert.equal(malformed.body.code, 'internal')
  assert.match(malformed.body.message, /invalid request body/)

  const nonObject = await postRaw(runtime, 'events', '[]')
  assert.equal(nonObject.headers['Content-Type'], 'application/json; charset=utf-8')
  assert.equal(nonObject.body.code, 'internal')

  const noBody = await postRaw(runtime, 'events', '')
  assert.equal(noBody.body.code, 'not-found')

  // A requested fromSeq raises the hello floor above the inherited prefix.
  const stream = await openStream(runtime, { sessionId, fromSeq: 5 })
  const hello = stream.frames()[0]
  assert.equal(hello.event, 'hello')
  assert.equal(hello.data.inheritedEventCount, 4)
  assert.deepEqual(hello.data.entries, [])
  const committed = agent.session.append('user/message', userMsg('u9', 'post-floor'), { surfaceOp: 'append' })
  emitSessionEvent(runtime, agent.session, committed)
  const eventFrame = stream.frames().find((frame) => frame.event === 'event')
  assert.equal(eventFrame.data.entry.seq, committed.seq)
  stream.close()
})

test('close and plugin unload end open event streams', async () => {
  const runtime = makeRuntime({ parents: [makeParent({ events: BASE_EVENTS })] })
  apply(runtime.ctx)
  const { sessionId } = await startSideSession(runtime)

  const first = await openStream(runtime, { sessionId })
  assert.equal(first.res.writableEnded, false)
  assert.deepEqual((await post(runtime, 'close', { sessionId })).body, { ok: true })
  assert.equal(first.res.writableEnded, true)
  assert.equal(first.req.listeners.has('close'), false)

  const recreated = await post(runtime, 'create', { sourceId: 'main-1' })
  assert.equal(recreated.body.ok, true)
  const second = await openStream(runtime, { sessionId: recreated.body.sessionId })
  assert.equal(second.res.writableEnded, false)
  const cleanup = runtime.effects.at(-1)
  assert.equal(typeof cleanup, 'function')
  cleanup()
  assert.equal(second.res.writableEnded, true)
  assert.equal(second.req.listeners.has('close'), false)
  // Unloading twice is harmless and the sessions were already disposed.
  cleanup()
})

// --- context-window baseline for the client status dock --------------------

test('requestContextWindow reads a positive finite window defensively', () => {
  assert.equal(requestContextWindow({ session: { requestContext: () => ({ contextWindow: 128000 }) } }), 128000)
  assert.equal(requestContextWindow({ session: { requestContext: () => ({ contextWindow: 1 }) } }), 1)
  assert.equal(requestContextWindow({ session: { requestContext: () => ({ contextWindow: '128000' }) } }), undefined)
  assert.equal(requestContextWindow({ session: { requestContext: () => ({ contextWindow: 0 }) } }), undefined)
  assert.equal(requestContextWindow({ session: { requestContext: () => ({ contextWindow: -1 }) } }), undefined)
  assert.equal(requestContextWindow({ session: { requestContext: () => ({ contextWindow: Infinity }) } }), undefined)
  assert.equal(requestContextWindow({ session: { requestContext: () => ({ contextWindow: Number.NaN }) } }), undefined)
  assert.equal(requestContextWindow({ session: { requestContext: () => null } }), undefined)
  assert.equal(requestContextWindow({ session: { requestContext: () => { throw new Error('no route context') } } }), undefined)
  assert.equal(requestContextWindow({ session: {} }), undefined)
  assert.equal(requestContextWindow({}), undefined)
  assert.equal(requestContextWindow(null), undefined)
  assert.equal(requestContextWindow(undefined), undefined)
})

test('snapshot and hello carry the side session context window only when one is available', async () => {
  const runtime = makeRuntime({ parents: [makeParent({ events: BASE_EVENTS })] })
  apply(runtime.ctx)
  const { sessionId, agent } = await startSideSession(runtime)

  const before = await post(runtime, 'snapshot', { sessionId })
  assert.equal(before.body.ok, true)
  assert.equal(Object.hasOwn(before.body, 'contextWindow'), false, 'no route context yet means no field')

  agent.session.requestContext = () => ({ contextWindow: 200000 })
  const snapshot = await post(runtime, 'snapshot', { sessionId })
  assert.equal(snapshot.body.contextWindow, 200000, 'the snapshot payload carries the window')

  const stream = await openStream(runtime, { sessionId })
  const hello = stream.frames()[0]
  assert.equal(hello.event, 'hello')
  assert.equal(hello.data.contextWindow, 200000, 'the SSE hello baseline carries the window')
  stream.close()

  agent.session.requestContext = () => ({ contextWindow: 0 })
  const invalid = await post(runtime, 'snapshot', { sessionId })
  assert.equal(Object.hasOwn(invalid.body, 'contextWindow'), false, 'a non-positive window is omitted')

  agent.session.requestContext = () => {
    throw new Error('context route unavailable')
  }
  const throwing = await post(runtime, 'snapshot', { sessionId })
  assert.equal(Object.hasOwn(throwing.body, 'contextWindow'), false, 'a throwing requestContext is contained')
})

// --- @file references (P1a host half) --------------------------------------

function referenceProvider(result, calls = []) {
  return {
    fileReferences: {
      list(agent, query, signal) {
        calls.push({ agent, query, signal })
        if (result instanceof Error) throw result
        if (typeof result === 'function') return result(agent, query, signal)
        return result
      },
    },
  }
}

async function postReferences(runtime, args) {
  const route = runtime.routes.get(`${ROUTE_PREFIX}references`)
  assert.ok(route !== undefined, 'route references is registered')
  const req = makeStreamRequest(typeof args === 'string' ? args : JSON.stringify(args ?? {}))
  const res = makeStreamResponse()
  await route.handler(req, res)
  const rawText = res.text()
  return {
    req,
    res,
    status: res.statusCode,
    headers: res.headers,
    rawBody: rawText,
    body: rawText === '' ? undefined : JSON.parse(rawText),
  }
}

async function waitFor(predicate) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.fail('condition was never met')
}

test('referenceCandidates keeps only well-formed file and directory paths', () => {
  assert.deepEqual(referenceCandidates([
    { path: 'src/a.js', kind: 'file' },
    { path: 'src/', kind: 'directory', size: 12 },
    { path: '', kind: 'file' },
    { kind: 'file' },
    { path: 7, kind: 'file' },
    { path: 'img.png', kind: 'image' },
    null,
    'nope',
  ]), [
    { path: 'src/a.js', kind: 'file' },
    { path: 'src/', kind: 'directory' },
  ])
  assert.deepEqual(referenceCandidates(undefined), [])
  assert.deepEqual(referenceCandidates('nope'), [])
})

test('references lists parent-workspace candidates by sourceId before a side session exists', async () => {
  const parent = makeParent()
  const calls = []
  const runtime = makeRuntime({
    parents: [parent],
    services: referenceProvider([
      { path: 'src/a.js', kind: 'file' },
      { path: 'src/', kind: 'directory', extra: true },
      { path: 'img.png', kind: 'image' },
      { kind: 'file' },
    ], calls),
  })
  apply(runtime.ctx)

  const response = await postReferences(runtime, { sourceId: 'main-1', query: 'src' })
  assert.equal(response.status, 200)
  assert.equal(response.headers['Content-Type'], 'application/json; charset=utf-8')
  assert.deepEqual(response.body, {
    ok: true,
    candidates: [
      { path: 'src/a.js', kind: 'file' },
      { path: 'src/', kind: 'directory' },
    ],
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].agent, parent)
  assert.equal(calls[0].query, 'src')
  assert.ok(calls[0].signal instanceof AbortSignal)
  assert.equal(calls[0].signal.aborted, false)
  assert.equal(runtime.created.length, 0, 'the route never creates a side session')
  assert.equal(response.req.listeners.has('close'), false, 'the request close listener is detached')
  assert.equal(response.res.listeners.has('close'), false, 'the response close listener is detached')
})

test('references prefers the side session agent and passes the query through unchanged', async () => {
  const calls = []
  const runtime = makeRuntime({
    parents: [makeParent({ events: BASE_EVENTS })],
    services: referenceProvider([{ path: 'dir with space/file.md', kind: 'file' }], calls),
  })
  apply(runtime.ctx)
  const { sessionId, agent } = await startSideSession(runtime)

  const response = await postReferences(runtime, { sessionId, sourceId: 'main-1', query: '  dir with space/' })
  assert.deepEqual(response.body, { ok: true, candidates: [{ path: 'dir with space/file.md', kind: 'file' }] })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].agent, agent)
  assert.equal(calls[0].query, '  dir with space/')
})

test('references rejects unknown sources and sessions this plugin does not own', async () => {
  const calls = []
  const runtime = makeRuntime({ parents: [makeParent()], services: referenceProvider([], calls) })
  apply(runtime.ctx)

  const unknown = await postReferences(runtime, { sourceId: 'nope', query: 'x' })
  assert.deepEqual(unknown.body, { ok: false, code: 'unknown-source', message: 'unknown source session "nope"' })

  const missing = await postReferences(runtime, { query: 'x' })
  assert.deepEqual(missing.body, { ok: false, code: 'bad-request', message: 'missing sessionId or sourceId' })

  const foreign = await postReferences(runtime, { sessionId: 'side-chat-other', sourceId: 'main-1', query: 'x' })
  assert.deepEqual(foreign.body, { ok: false, code: 'not-found' })

  assert.equal(calls.length, 0, 'no provider lookup runs without a resolved agent')

  const fallback = await postReferences(runtime, { sessionId: '', sourceId: 'main-1', query: '' })
  assert.deepEqual(fallback.body, { ok: true, candidates: [] })
  assert.equal(calls.length, 1, 'an empty sessionId falls back to the parent sourceId')
})

test('references validates the query string and its 512-character cap', async () => {
  const calls = []
  const runtime = makeRuntime({ parents: [makeParent()], services: referenceProvider([], calls) })
  apply(runtime.ctx)

  for (const query of [undefined, null, 7, ['src'], { text: 'src' }]) {
    const response = await postReferences(runtime, { sourceId: 'main-1', query })
    assert.equal(response.body.ok, false)
    assert.equal(response.body.code, 'bad-request')
    assert.match(response.body.message, /query must be a string/)
  }

  const overLong = await postReferences(runtime, { sourceId: 'main-1', query: 'x'.repeat(513) })
  assert.equal(overLong.body.ok, false)
  assert.equal(overLong.body.code, 'bad-request')

  const atCap = await postReferences(runtime, { sourceId: 'main-1', query: 'x'.repeat(512) })
  assert.deepEqual(atCap.body, { ok: true, candidates: [] })
  const empty = await postReferences(runtime, { sourceId: 'main-1', query: '' })
  assert.deepEqual(empty.body, { ok: true, candidates: [] })
  assert.deepEqual(calls.map((call) => call.query), ['x'.repeat(512), ''])
  assert.equal(calls.length, 2, 'no provider lookup runs for an invalid query')
})

test('references answers unavailable only when no reference provider can answer', async () => {
  const absent = makeRuntime({ parents: [makeParent()] })
  apply(absent.ctx)
  assert.deepEqual((await postReferences(absent, { sourceId: 'main-1', query: 'x' })).body, {
    ok: false,
    code: 'unavailable',
    message: 'reference providers are unavailable',
  })

  const degraded = makeRuntime({ parents: [makeParent()], services: { fileReferences: {} } })
  apply(degraded.ctx)
  assert.equal((await postReferences(degraded, { sourceId: 'main-1', query: 'x' })).body.code, 'unavailable')

  const throwing = makeRuntime({ parents: [makeParent()], services: referenceProvider(new Error('scan failed')) })
  apply(throwing.ctx)
  const failed = await postReferences(throwing, { sourceId: 'main-1', query: 'x' })
  assert.deepEqual(failed.body, { ok: false, code: 'unavailable', message: 'scan failed' })
  assert.ok(throwing.warnings.some((warning) => warning.includes('file reference lookup failed')))
})

test('references folds malformed bodies into internal and treats an empty body as no identity', async () => {
  const runtime = makeRuntime({ parents: [makeParent()] })
  apply(runtime.ctx)

  const malformed = await postReferences(runtime, '{not json')
  assert.equal(malformed.status, 200)
  assert.equal(malformed.headers['Content-Type'], 'application/json; charset=utf-8')
  assert.equal(malformed.body.ok, false)
  assert.equal(malformed.body.code, 'internal')
  assert.match(malformed.body.message, /invalid request body/)

  const nonObject = await postReferences(runtime, '[]')
  assert.equal(nonObject.body.code, 'internal')

  const empty = await postReferences(runtime, '')
  assert.deepEqual(empty.body, { ok: false, code: 'bad-request', message: 'missing sessionId or sourceId' })
})

test('references aborts the provider lookup and writes no response when the client disconnects', async () => {
  const calls = []
  let resolveList
  const pending = new Promise((resolve) => {
    resolveList = resolve
  })
  const runtime = makeRuntime({
    parents: [makeParent()],
    services: {
      fileReferences: {
        list(agent, query, signal) {
          calls.push({ agent, query, signal })
          return pending
        },
      },
    },
  })
  apply(runtime.ctx)

  const route = runtime.routes.get(`${ROUTE_PREFIX}references`)
  assert.ok(route !== undefined, 'route references is registered')
  const req = makeStreamRequest(JSON.stringify({ sourceId: 'main-1', query: 'src' }))
  const res = makeStreamResponse()
  const handler = route.handler(req, res)

  await waitFor(() => calls.length === 1)
  const close = req.listeners.get('close')
  assert.equal(typeof close, 'function', 'the route observes request close')
  close()
  assert.equal(calls[0].signal.aborted, true, 'the provider signal is aborted on disconnect')

  resolveList([{ path: 'src/a.js', kind: 'file' }])
  await handler
  assert.equal(res.statusCode, undefined, 'no response status is written')
  assert.equal(res.chunks.length, 0, 'no response body is written')
  assert.equal(req.listeners.has('close'), false, 'the close listener is detached')
})

test('references suppresses the response and the warning when the aborted lookup rejects', async () => {
  const runtime = makeRuntime({
    parents: [makeParent()],
    services: {
      fileReferences: {
        list(agent, query, signal) {
          return new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('lookup aborted')))
          })
        },
      },
    },
  })
  apply(runtime.ctx)

  const route = runtime.routes.get(`${ROUTE_PREFIX}references`)
  assert.ok(route !== undefined, 'route references is registered')
  const req = makeStreamRequest(JSON.stringify({ sourceId: 'main-1', query: 'src' }))
  const res = makeStreamResponse()
  const handler = route.handler(req, res)

  await waitFor(() => req.listeners.has('close'))
  req.listeners.get('close')()
  await handler
  assert.equal(res.statusCode, undefined, 'no response status is written')
  assert.equal(res.chunks.length, 0, 'no response body is written')
  assert.equal(runtime.warnings.length, 0, 'a cancelled lookup is not a failure')
})

function sessionPayload(sessionId) {
  return Buffer.from(JSON.stringify(sessionId), 'utf8').toString('base64url')
}

function combinedReferenceProvider({ files = [], sessions = [], omitFiles = false, omitSessions = false, fileError, sessionError, fileCalls = [], sessionCalls = [] } = {}) {
  const services = {}
  if (omitFiles) {
    // No `fileReferences` service at all.
  } else if (fileError !== undefined) {
    services.fileReferences = {
      list() {
        throw fileError
      },
    }
  } else {
    services.fileReferences = {
      list(agent, query, signal) {
        fileCalls.push({ agent, query, signal })
        return files
      },
    }
  }
  if (omitSessions) {
    // No `sessionReferenceResolver` service at all.
  } else if (sessionError !== undefined) {
    services.sessionReferenceResolver = {
      listCandidates() {
        throw sessionError
      },
    }
  } else {
    services.sessionReferenceResolver = {
      listCandidates(agent, query, limit, signal) {
        sessionCalls.push({ agent, query, limit, signal })
        return sessions
      },
    }
  }
  return services
}

test('sessionReferenceMention renders the canonical DSH spelling and escapes the label', () => {
  assert.equal(
    sessionReferenceMention('session-1', 'Fix login'),
    `@[Fix login](dsh-session:${sessionPayload('session-1')})`,
  )
  assert.equal(
    sessionReferenceMention('session-1', 'a]b\\c'),
    `@[a\\]b\\\\c](dsh-session:${sessionPayload('session-1')})`,
  )
  assert.equal(
    sessionReferenceMention('session-1'),
    `@[session-1](dsh-session:${sessionPayload('session-1')})`,
  )
  assert.equal(sessionReferenceMention('', 'title'), undefined)
  assert.equal(
    sessionReferenceMention('session-1', 'a\nb'),
    `@[a b](dsh-session:${sessionPayload('session-1')})`,
  )
})

test('abbreviateHomePath shortens only a home-rooted path', () => {
  assert.equal(abbreviateHomePath('/Users/me/work', '/Users/me'), '~/work')
  assert.equal(abbreviateHomePath('/Users/me', '/Users/me'), '~')
  assert.equal(abbreviateHomePath('/Users/me2/work', '/Users/me'), '/Users/me2/work')
  assert.equal(abbreviateHomePath('/other', '/Users/me'), '/other')
  assert.equal(abbreviateHomePath('relative', '/Users/me'), 'relative')
  assert.equal(abbreviateHomePath('/Users/me/work', ''), '/Users/me/work')
})

test('sessionReferenceCandidates projects display titles, locations and mentions', () => {
  const agent = makeParent({ cwd: '/workspace' })
  const listed = [
    { sessionId: 's-1', label: 'Old title', displayTitle: 'Fix login', sameWorkspace: true, createdAt: 10 },
    { sessionId: 's-2', label: 'Other', cwd: '/Users/me/other', sameWorkspace: false, createdAt: 20 },
    { sessionId: 's-3', label: 'No cwd', sameWorkspace: false, createdAt: 30 },
    { sessionId: 's-5', label: 'a\nb', sameWorkspace: true, createdAt: 40 },
    { sessionId: 's-4', label: '', sameWorkspace: false },
    { sessionId: '', label: 'x' },
    null,
    'nope',
  ]
  assert.deepEqual(sessionReferenceCandidates(listed, agent, '/Users/me'), [
    {
      kind: 'session',
      sessionId: 's-1',
      label: 'Fix login',
      mention: `@[Fix login](dsh-session:${sessionPayload('s-1')})`,
      createdAt: 10,
    },
    {
      kind: 'session',
      sessionId: 's-2',
      label: 'Other',
      mention: `@[Other](dsh-session:${sessionPayload('s-2')})`,
      createdAt: 20,
      location: '~/other',
    },
    {
      kind: 'session',
      sessionId: 's-3',
      label: 'No cwd',
      mention: `@[No cwd](dsh-session:${sessionPayload('s-3')})`,
      createdAt: 30,
      location: null,
    },
    {
      kind: 'session',
      sessionId: 's-5',
      label: 'a b',
      mention: `@[a b](dsh-session:${sessionPayload('s-5')})`,
      createdAt: 40,
    },
  ])
  assert.deepEqual(sessionReferenceCandidates(undefined, agent, '/Users/me'), [])
  assert.deepEqual(sessionReferenceCandidates('nope', agent, '/Users/me'), [])
})

test('references merges file and session rows, files first, and skips sessions for quoted queries', async () => {
  const fileCalls = []
  const sessionCalls = []
  const runtime = makeRuntime({
    parents: [makeParent()],
    services: combinedReferenceProvider({
      files: [{ path: 'src/a.js', kind: 'file' }],
      sessions: [
        { sessionId: 's-1', label: 'Older', sameWorkspace: true, createdAt: 10 },
        { sessionId: 's-2', label: 'Other', cwd: '/tmp/x', sameWorkspace: false, createdAt: 20 },
      ],
      fileCalls,
      sessionCalls,
    }),
  })
  apply(runtime.ctx)

  const unquoted = await postReferences(runtime, { sourceId: 'main-1', query: 'x' })
  assert.deepEqual(unquoted.body, {
    ok: true,
    candidates: [
      { path: 'src/a.js', kind: 'file' },
      {
        kind: 'session',
        sessionId: 's-1',
        label: 'Older',
        mention: `@[Older](dsh-session:${sessionPayload('s-1')})`,
        createdAt: 10,
      },
      {
        kind: 'session',
        sessionId: 's-2',
        label: 'Other',
        mention: `@[Other](dsh-session:${sessionPayload('s-2')})`,
        createdAt: 20,
        location: '/tmp/x',
      },
    ],
  })
  assert.equal(fileCalls.length, 1)
  assert.equal(sessionCalls.length, 1)
  assert.equal(sessionCalls[0].query, 'x')
  assert.equal(sessionCalls[0].limit, undefined)
  assert.ok(sessionCalls[0].signal instanceof AbortSignal)

  const quoted = await postReferences(runtime, { sourceId: 'main-1', query: 'x', quoted: true })
  assert.deepEqual(quoted.body, { ok: true, candidates: [{ path: 'src/a.js', kind: 'file' }] })
  assert.equal(sessionCalls.length, 1, 'a quoted query never asks for sessions')
})

test('references keeps the working domain when the other one fails', async () => {
  const fileFailure = makeRuntime({
    parents: [makeParent()],
    services: combinedReferenceProvider({
      sessions: [{ sessionId: 's-1', label: 'Fix login', sameWorkspace: true, createdAt: 10 }],
      fileError: new Error('scan failed'),
    }),
  })
  apply(fileFailure.ctx)
  const sessionsOnly = await postReferences(fileFailure, { sourceId: 'main-1', query: 'f' })
  assert.equal(sessionsOnly.body.ok, true)
  assert.deepEqual(sessionsOnly.body.candidates, [{
    kind: 'session',
    sessionId: 's-1',
    label: 'Fix login',
    mention: `@[Fix login](dsh-session:${sessionPayload('s-1')})`,
    createdAt: 10,
  }])
  assert.ok(fileFailure.warnings.some((warning) => warning.includes('file reference lookup failed')))

  const sessionFailure = makeRuntime({
    parents: [makeParent()],
    services: combinedReferenceProvider({
      files: [{ path: 'src/a.js', kind: 'file' }],
      sessionError: new Error('candidates failed'),
    }),
  })
  apply(sessionFailure.ctx)
  const filesOnly = await postReferences(sessionFailure, { sourceId: 'main-1', query: 'a' })
  assert.deepEqual(filesOnly.body, { ok: true, candidates: [{ path: 'src/a.js', kind: 'file' }] })
  assert.ok(sessionFailure.warnings.some((warning) => warning.includes('session reference lookup failed')))

  const bothFail = makeRuntime({
    parents: [makeParent()],
    services: combinedReferenceProvider({
      fileError: new Error('file failed'),
      sessionError: new Error('session failed'),
    }),
  })
  apply(bothFail.ctx)
  const failed = await postReferences(bothFail, { sourceId: 'main-1', query: 'a' })
  assert.deepEqual(failed.body, { ok: false, code: 'unavailable', message: 'file failed' })
})

test('references lists sessions even when the file-reference provider is absent', async () => {
  const runtime = makeRuntime({
    parents: [makeParent()],
    services: combinedReferenceProvider({
      omitFiles: true,
      sessions: [{ sessionId: 's-1', label: 'Fix login', sameWorkspace: true, createdAt: 10 }],
    }),
  })
  apply(runtime.ctx)
  const response = await postReferences(runtime, { sourceId: 'main-1', query: '' })
  assert.equal(response.body.ok, true)
  assert.deepEqual(response.body.candidates, [{
    kind: 'session',
    sessionId: 's-1',
    label: 'Fix login',
    mention: `@[Fix login](dsh-session:${sessionPayload('s-1')})`,
    createdAt: 10,
  }])

  const quoted = await postReferences(runtime, { sourceId: 'main-1', query: '', quoted: true })
  assert.deepEqual(quoted.body, { ok: true, candidates: [] })
})

test('references aborts both lookups when the client disconnects', async () => {
  const fileCalls = []
  const sessionCalls = []
  let resolveFiles
  let resolveSessions
  const filesPending = new Promise((resolve) => {
    resolveFiles = resolve
  })
  const sessionsPending = new Promise((resolve) => {
    resolveSessions = resolve
  })
  const runtime = makeRuntime({
    parents: [makeParent()],
    services: {
      fileReferences: {
        list(agent, query, signal) {
          fileCalls.push(signal)
          return filesPending
        },
      },
      sessionReferenceResolver: {
        listCandidates(agent, query, limit, signal) {
          sessionCalls.push(signal)
          return sessionsPending
        },
      },
    },
  })
  apply(runtime.ctx)

  const route = runtime.routes.get(`${ROUTE_PREFIX}references`)
  const req = makeStreamRequest(JSON.stringify({ sourceId: 'main-1', query: 'src' }))
  const res = makeStreamResponse()
  const handler = route.handler(req, res)
  await waitFor(() => fileCalls.length === 1 && sessionCalls.length === 1)
  req.listeners.get('close')()
  assert.equal(fileCalls[0].aborted, true)
  assert.equal(sessionCalls[0].aborted, true)
  resolveFiles([{ path: 'src/a.js', kind: 'file' }])
  resolveSessions([])
  await handler
  assert.equal(res.statusCode, undefined)
  assert.equal(res.chunks.length, 0)
})

test('the combined reference route frames correctly over a real HTTP server', async () => {
  const runtime = makeRuntime({
    parents: [makeParent()],
    services: combinedReferenceProvider({
      files: [{ path: 'src/a.js', kind: 'file' }],
      sessions: [{ sessionId: 's-1', label: 'Fix login', sameWorkspace: true, createdAt: 10 }],
    }),
  })
  apply(runtime.ctx)

  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const route = runtime.routes.get(pathname)
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    route.handler(req, res).catch(() => {
      try {
        res.destroy()
      } catch {
        // The carrier is already gone.
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}`
  try {
    const response = await fetch(`${base}/side-chat/api/references`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: 'main-1', query: 'f' }),
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.deepEqual(body.candidates, [
      { path: 'src/a.js', kind: 'file' },
      {
        kind: 'session',
        sessionId: 's-1',
        label: 'Fix login',
        mention: `@[Fix login](dsh-session:${sessionPayload('s-1')})`,
        createdAt: 10,
      },
    ])
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('imageAttachmentRef normalizes a well-formed reference and refuses malformed ones', () => {
  const id = `sha256:${'a'.repeat(64)}`
  assert.deepEqual(imageAttachmentRef({ attachmentId: id, mediaType: 'image/png', width: 2, height: 3, bytes: 4 }), {
    attachmentId: id,
    mediaType: 'image/png',
    width: 2,
    height: 3,
    bytes: 4,
  })
  assert.deepEqual(imageAttachmentRef({ attachmentId: id, mediaType: 'image/png', width: 2, height: 3, bytes: 4, name: ' shot.png ' }), {
    attachmentId: id,
    mediaType: 'image/png',
    width: 2,
    height: 3,
    bytes: 4,
    name: 'shot.png',
  })
  assert.deepEqual(imageAttachmentRef({ attachmentId: id, mediaType: 'image/png', width: 2, height: 3, bytes: 4, originalDimensions: { width: 8, height: 9 } }), {
    attachmentId: id,
    mediaType: 'image/png',
    width: 2,
    height: 3,
    bytes: 4,
    originalDimensions: { width: 8, height: 9 },
  })
  assert.equal(imageAttachmentRef(null), undefined)
  assert.equal(imageAttachmentRef({ attachmentId: 'sha256:abc', mediaType: 'image/png', width: 2, height: 2, bytes: 1 }), undefined, 'the id must be a full sha256 reference')
  assert.equal(imageAttachmentRef({ attachmentId: id, mediaType: '', width: 2, height: 2, bytes: 1 }), undefined)
  assert.equal(imageAttachmentRef({ attachmentId: id, mediaType: 'image/png', width: 0, height: 2, bytes: 1 }), undefined)
  assert.equal(imageAttachmentRef({ attachmentId: id, mediaType: 'image/png', width: 2, height: 'x', bytes: 1 }), undefined)
})

test('projectQueue keeps image-only prompts and counts their images', () => {
  const id = `sha256:${'b'.repeat(64)}`
  const rows = projectQueue({
    nextStep: [{ id: 's1', content: [{ type: 'image', attachment: { attachmentId: id, mediaType: 'image/png', width: 2, height: 2, bytes: 3 } }] }],
    nextTurn: [
      { id: 'q1', content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: { attachmentId: id, mediaType: 'image/png', width: 2, height: 2, bytes: 3 } }] },
      { id: 'q2', content: [{ type: 'text', text: '' }] },
    ],
  })
  assert.deepEqual(rows.map((row) => row.id), ['s1', 'q1'])
  assert.deepEqual(rows.map((row) => row.images), [1, 1])
  assert.equal(rows[0].text, '')
  assert.equal(rows[0].placement, 'steering')
  assert.equal(rows[1].text, 'look')
})

test('the upload route stores an image for the addressed parent before any side session exists', async () => {
  const attachments = makeAttachmentsService()
  const runtime = makeRuntime({ parents: [makeParent()], services: { attachments } })
  apply(runtime.ctx)

  const result = await uploadImage(runtime, { sourceId: 'main-1', mime: 'image/png', name: 'shot.png' }, PNG_BYTES)
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  const ref = result.body.attachment
  assert.match(ref.attachmentId, /^sha256:[a-f0-9]{64}$/)
  assert.equal(ref.mediaType, 'image/png')
  assert.equal(ref.bytes, PNG_BYTES.length)
  assert.equal(ref.name, 'shot.png')
  assert.equal(attachments.saves.length, 1)
  assert.deepEqual(attachments.saves[0].data, new Uint8Array(PNG_BYTES))
  assert.equal(attachments.saves[0].mediaType, 'image/png')

  const forSession = await uploadImage(runtime, { sessionId: 'side-chat-nope', mime: 'image/png' }, PNG_BYTES)
  assert.deepEqual({ ok: forSession.body.ok, code: forSession.body.code }, { ok: false, code: 'not-found' })
  const unknownParent = await uploadImage(runtime, { sourceId: 'main-x', mime: 'image/png' }, PNG_BYTES)
  assert.equal(unknownParent.body.code, 'unknown-source')
  const noIdentity = await uploadImage(runtime, { mime: 'image/png' }, PNG_BYTES)
  assert.equal(noIdentity.body.code, 'bad-request')
  const wrongMethod = await collectResponse(runtime.routes.get(`${ROUTE_PREFIX}attachment`), { method: 'GET', url: `${ROUTE_PREFIX}attachment` })
  assert.equal(JSON.parse(wrongMethod.rawBody).code, 'bad-request')
})

test('the upload route maps provider refusals to attachment-rejected with a reason', async () => {
  const runtime = makeRuntime({ parents: [makeParent()], services: { attachments: makeAttachmentsService({ limits: { mediaTypes: ['image/png'], maxImageBytes: 4 } }) } })
  apply(runtime.ctx)

  const unsupported = await uploadImage(runtime, { sourceId: 'main-1', mime: 'image/gif' }, PNG_BYTES)
  assert.equal(unsupported.body.ok, false)
  assert.equal(unsupported.body.code, 'attachment-rejected')
  assert.equal(unsupported.body.reason, 'UNSUPPORTED_IMAGE_TYPE')

  const tooLarge = await uploadImage(runtime, { sourceId: 'main-1', mime: 'image/png' }, Buffer.from([1, 2, 3, 4, 5]))
  assert.equal(tooLarge.body.code, 'attachment-rejected')
  assert.equal(tooLarge.body.reason, 'IMAGE_TOO_LARGE')

  const empty = await uploadImage(runtime, { sourceId: 'main-1', mime: 'image/png' }, Buffer.alloc(0))
  assert.equal(empty.body.code, 'attachment-rejected')
  assert.equal(empty.body.reason, 'INVALID_IMAGE')

  const failing = new Error('normalization failed')
  failing.code = 'IMAGE_TYPE_MISMATCH'
  const failingRuntime = makeRuntime({
    parents: [makeParent()],
    services: { attachments: makeAttachmentsService({ saveFailure: failing }) },
  })
  apply(failingRuntime.ctx)
  const rejected = await uploadImage(failingRuntime, { sourceId: 'main-1', mime: 'image/png' }, PNG_BYTES)
  assert.equal(rejected.body.ok, false)
  assert.equal(rejected.body.code, 'attachment-rejected')
  assert.equal(rejected.body.reason, 'IMAGE_TYPE_MISMATCH')
})

test('prompt maps an admission refusal to attachment-rejected instead of sending', async () => {
  const attachments = makeAttachmentsService()
  attachments.admitPromptContent = async () => {
    const error = new Error('Image batch exceeds the configured image-count limit.')
    error.code = 'TOO_MANY_IMAGES'
    throw error
  }
  const runtime = makeRuntime({ parents: [makeParent()], services: { attachments } })
  apply(runtime.ctx)
  const sessionId = await createSideSession(runtime)
  const uploaded = await uploadImage(runtime, { sessionId, mime: 'image/png' }, PNG_BYTES)
  const refused = await post(runtime, 'prompt', {
    sessionId,
    text: 'many',
    attachments: [uploaded.body.attachment.attachmentId],
  })
  assert.equal(refused.body.ok, false)
  assert.equal(refused.body.code, 'attachment-rejected')
  assert.equal(refused.body.reason, 'TOO_MANY_IMAGES')
  assert.equal(runtime.handles[0].agent.followups.length, 0)
})

test('the upload route answers unavailable without an attachment service', async () => {
  const runtime = makeRuntime({ parents: [makeParent()] })
  apply(runtime.ctx)
  const result = await uploadImage(runtime, { sourceId: 'main-1', mime: 'image/png' }, PNG_BYTES)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.code, 'unavailable')
})

test('prompt admits staged images and appends one user message with them', async () => {
  const attachments = makeAttachmentsService()
  const runtime = makeRuntime({ parents: [makeParent()], services: { attachments } })
  apply(runtime.ctx)
  const sessionId = await createSideSession(runtime)
  const uploaded = await uploadImage(runtime, { sessionId, mime: 'image/png' }, PNG_BYTES)
  const attachmentId = uploaded.body.attachment.attachmentId

  const imageOnly = await post(runtime, 'prompt', { sessionId, text: '', attachments: [attachmentId] })
  assert.equal(imageOnly.body.ok, true)
  const agent = runtime.handles[0].agent
  const message = agent.followups[0]
  assert.deepEqual(message.content, [{ type: 'image', attachment: uploaded.body.attachment }])
  assert.deepEqual(message.source, { kind: 'user' })

  const withText = await post(runtime, 'prompt', { sessionId, text: 'look at this', attachments: [attachmentId] })
  assert.equal(withText.body.ok, true)
  assert.deepEqual(agent.followups[1].content, [
    { type: 'text', text: 'look at this' },
    { type: 'image', attachment: uploaded.body.attachment },
  ])
})

test('prompt refuses unknown or malformed attachment ids without appending', async () => {
  const attachments = makeAttachmentsService()
  const runtime = makeRuntime({ parents: [makeParent()], services: { attachments } })
  apply(runtime.ctx)
  const sessionId = await createSideSession(runtime)
  const agent = runtime.handles[0].agent

  const unknown = await post(runtime, 'prompt', { sessionId, text: '', attachments: [`sha256:${'c'.repeat(64)}`] })
  assert.equal(unknown.body.ok, false)
  assert.equal(unknown.body.code, 'attachment-rejected')
  assert.equal(unknown.body.reason, 'ATTACHMENT_NOT_FOUND')

  const malformed = await post(runtime, 'prompt', { sessionId, text: 'x', attachments: ['not-an-id'] })
  assert.equal(malformed.body.code, 'bad-request')

  const notAnArray = await post(runtime, 'prompt', { sessionId, text: 'x', attachments: 'nope' })
  assert.equal(notAnArray.body.code, 'bad-request')

  const empty = await post(runtime, 'prompt', { sessionId, text: '   ' })
  assert.equal(empty.body.code, 'empty-prompt')
  assert.equal(agent.followups.length, 0)
})

test('prompt refuses images on a text-only route before appending', async () => {
  const attachments = makeAttachmentsService()
  const runtime = makeRuntime({
    parents: [makeParent()],
    services: {
      attachments,
      llm: { resolveModelInfo: async () => ({ inputModalities: ['text'] }) },
    },
  })
  apply(runtime.ctx)
  const sessionId = await createSideSession(runtime)
  const uploaded = await uploadImage(runtime, { sessionId, mime: 'image/png' }, PNG_BYTES)

  const refused = await post(runtime, 'prompt', {
    sessionId,
    text: '',
    attachments: [uploaded.body.attachment.attachmentId],
  })
  assert.equal(refused.body.ok, false)
  assert.equal(refused.body.code, 'attachment-rejected')
  assert.equal(refused.body.reason, 'MODEL_DOES_NOT_SUPPORT_IMAGES')
  assert.equal(runtime.handles[0].agent.followups.length, 0)
})

test('the image route serves a referenced image and hides everything else', async () => {
  const attachments = makeAttachmentsService()
  const runtime = makeRuntime({ parents: [makeParent()], services: { attachments } })
  apply(runtime.ctx)
  const sessionId = await createSideSession(runtime)
  const uploaded = await uploadImage(runtime, { sessionId, mime: 'image/png' }, PNG_BYTES)
  const ref = uploaded.body.attachment
  const query = {
    sessionId,
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    width: String(ref.width),
    height: String(ref.height),
    bytes: String(ref.bytes),
  }

  const beforeSend = await readImageRoute(runtime, query)
  assert.equal(beforeSend.status, 404, 'an uploaded but unsent image is not served')
  assert.equal(beforeSend.rawBody, undefined)

  await post(runtime, 'prompt', { sessionId, text: '', attachments: [ref.attachmentId] })
  const served = await readImageRoute(runtime, query)
  assert.equal(served.status, 200)
  assert.equal(served.headers['Content-Type'], 'image/png')
  assert.equal(served.headers['Cache-Control'], 'private, max-age=31536000, immutable')
  assert.deepEqual(Buffer.from(served.rawBody), PNG_BYTES)

  const unknownSession = await readImageRoute(runtime, { ...query, sessionId: 'side-chat-nope' })
  assert.equal(unknownSession.status, 404)
  const forgedBytes = await readImageRoute(runtime, { ...query, bytes: '999' })
  assert.equal(forgedBytes.status, 404)
  const forgedId = await readImageRoute(runtime, { ...query, attachmentId: `sha256:${'d'.repeat(64)}` })
  assert.equal(forgedId.status, 404)
  const missing = await readImageRoute(runtime, { sessionId })
  assert.equal(missing.status, 404)
  const wrongMethod = await readImageRoute(runtime, query, 'POST')
  assert.equal(wrongMethod.status, 405)
})

test('the raw image routes frame correctly over a real HTTP server', async () => {
  const attachments = makeAttachmentsService()
  const runtime = makeRuntime({ parents: [makeParent()], services: { attachments } })
  apply(runtime.ctx)

  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const route = runtime.routes.get(pathname)
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    route.handler(req, res).catch(() => {
      try {
        res.destroy()
      } catch {
        // The carrier is already gone.
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}`
  try {
    const created = await fetch(`${base}/side-chat/api/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: 'main-1' }),
    }).then((response) => response.json())
    assert.equal(created.ok, true)

    const uploadedResponse = await fetch(`${base}/side-chat/api/attachment?sessionId=${encodeURIComponent(created.sessionId)}&mime=image%2Fpng`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: PNG_BYTES,
    })
    assert.equal(uploadedResponse.status, 200)
    const uploaded = await uploadedResponse.json()
    assert.equal(uploaded.ok, true)
    const ref = uploaded.attachment

    const promptResponse = await fetch(`${base}/side-chat/api/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: created.sessionId, text: '', attachments: [ref.attachmentId] }),
    }).then((response) => response.json())
    assert.equal(promptResponse.ok, true)

    const query = new URLSearchParams({
      sessionId: created.sessionId,
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      width: String(ref.width),
      height: String(ref.height),
      bytes: String(ref.bytes),
    })
    const imageResponse = await fetch(`${base}/side-chat/api/image?${query.toString()}`)
    assert.equal(imageResponse.status, 200)
    assert.equal(imageResponse.headers.get('content-type'), 'image/png')
    const bytes = Buffer.from(await imageResponse.arrayBuffer())
    assert.deepEqual(bytes, PNG_BYTES)

    const missing = await fetch(`${base}/side-chat/api/image?${query.toString().replace('sessionId', 'sessionId=nope&x')}`)
    assert.equal(missing.status, 404)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
