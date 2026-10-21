import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  artifactDirectory,
  completedTurnPrefix,
  isSystemNoise,
  LiveAttemptState,
  projectQueue,
  recentMainContext,
  requestContextWindow,
  routeHandler,
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

function makeRuntime({ parents = [], services = {}, createDelayMs = 0, createFailure, followupFailure, disposeFailure } = {}) {
  const routes = new Map()
  const effects = []
  const listeners = new Map()
  const warnings = []
  const created = []
  const handles = []
  const disposed = []
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
    `${ROUTE_PREFIX}cancel`,
    `${ROUTE_PREFIX}close`,
    `${ROUTE_PREFIX}create`,
    `${ROUTE_PREFIX}events`,
    `${ROUTE_PREFIX}list`,
    `${ROUTE_PREFIX}prompt`,
    `${ROUTE_PREFIX}snapshot`,
    `${ROUTE_PREFIX}status`,
  ])
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
  assert.deepEqual((await post(runtime, 'list', {})).body, { ok: true, sessions: [] })
  const sessionId = (await post(runtime, 'create', { sourceId: 'main-1' })).body.sessionId
  assert.deepEqual((await post(runtime, 'list', {})).body, { ok: true, sessions: [{ sessionId, sourceId: 'main-1' }] })
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
    assert.deepEqual((await post(runtime, 'list', {})).body, { ok: true, sessions: [] })

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
    assert.deepEqual((await post(disposeFailure, 'list', {})).body, { ok: true, sessions: [] })
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
