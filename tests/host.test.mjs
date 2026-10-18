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
  projectQueue,
  recentMainContext,
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
