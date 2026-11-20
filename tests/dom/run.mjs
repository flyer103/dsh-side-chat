/**
 * Per-branch real-DOM smoke for the side-chat fork.
 *
 * Loads this branch's lib/client.js, mounts the tab body and the selection
 * action with React 18 + jsdom, and asserts only the capabilities this branch
 * ships (feature detection by rendered elements).
 *
 * Run: npm install && npm test  (or BUNDLE_PATH=/path/to/client.js npm test)
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

const BUNDLE_PATH = process.env.BUNDLE_PATH ?? new URL('../../lib/client.js', import.meta.url)
const EXPECT_PENDING_FIXED = process.env.EXPECT_PENDING_FIXED === '1'
const failures = []
const check = (name, condition, detail = '') => {
  if (condition) console.log('PASS', name)
  else { console.log('FAIL', name, detail); failures.push(name) }
}
const skip = (name) => console.log('SKIP', name)

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true })
globalThis.window = dom.window
globalThis.document = dom.window.document
try { Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true }) } catch {}
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Node = dom.window.Node
globalThis.MouseEvent = dom.window.MouseEvent
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const source = fs.readFileSync(typeof BUNDLE_PATH === 'string' ? BUNDLE_PATH : fileURLToPath(BUNDLE_PATH), 'utf8')
const registrations = []
const loaderWindow = dom.window
loaderWindow.__ModuleLoader__ = { load: (r) => registrations.push(r) }
new Function('window', source)(loaderWindow)
const primitives = {
  MarkdownText: React.memo(function MarkdownText({ text }) { return React.createElement('div', { className: 'md-text' }, text) }),
  IconCloseOutlineRegular: () => null, IconSendOutlineRegular: () => null, IconStopFillRegular: () => null,
  IconThinkOutlineRegular: () => null, IconCodeOutlineRegular: () => null,
}
const exportsObject = registrations[0].factory((id) => {
  if (id === 'react') return React
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error('unexpected require: ' + id)
})

const SNAPSHOT = Object.freeze({ active: 'en', locales: [], revision: 0 })
const dictionaries = new Map()
const locale = {
  register(ns, localeOrDicts, dict) {
    const pairs = typeof localeOrDicts === 'string' ? [[localeOrDicts, dict]] : Object.entries(localeOrDicts)
    let byLocale = dictionaries.get(ns)
    if (byLocale === undefined) { byLocale = new Map(); dictionaries.set(ns, byLocale) }
    for (const [l, entries] of pairs) byLocale.set(l, entries)
    return () => {}
  },
  bind(ns) {
    return (key) => {
      const en = (dictionaries.get(ns)?.get('en')) ?? {}
      return en[key] ?? key
    }
  },
  getSnapshot: () => SNAPSHOT,
  subscribe: () => () => {},
}
const slots = []
const interactions = []
const remoteHandlers = []
const openedTabs = []
const ctx = {
  locale,
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
  slots: { inject(name, cb) { return cb() }, register(options, component) { slots.push({ options, component }); return () => {} } },
  sidebarRightTabs: { register: () => () => {} },
  sidebarRight: { registerCloseHandler: () => () => {}, openTab(kind) { openedTabs.push(kind) } },
  uiConversation: { interactions: { register(def) { interactions.push(def); return () => {} } } },
  remote: { $on(event, listener) { remoteHandlers.push({ event, listener }); return () => {} } },
  sessions: { scopeOf: () => 'main-1' },
}
exportsObject.apply(ctx)

const bodySlot = slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab')
const surfaceSlot = slots.find((entry) => entry.options.name === 'conversation.chat.text-interaction')

function panelState(overrides = {}) {
  return {
    mainId: 'main-1', sessionId: null, inheritedEventCount: null, nextSeq: null, entries: [], seqs: new Set(),
    nodes: [], visible: true, running: false, status: 'idle', lastError: null, error: null, pollError: null,
    sending: false, draft: '', lookup: true, images: [], reference: undefined, sessionRefs: [], composerCaret: 0,
    pending: [], live: null, metrics: null, contextWindow: null, streamMode: 'poll', streaming: false,
    timer: null, onVisibility: null, ...overrides,
  }
}
function makeRuntime(state, capture, question = null) {
  return {
    subscribe: () => () => {}, getVersion: () => 0, open() {}, setVisible() {},
    getState: () => state,
    setDraft: (id, text) => capture.push(['setDraft', text]),
    getQuestion: () => question,
    clearQuestion: (sid) => capture.push(['clearQuestion', sid]),
    toggleLookup: (id) => capture.push(['toggleLookup', id]),
  }
}
async function mount(element) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(element) })
  return { container, unmount: () => act(async () => { root.unmount() }) }
}
function bodyProps(state, capture, runtime) {
  return {
    runtime, sessionId: 'main-1', t: locale.bind('side-chat'), locale,
    useTabInfo: () => ({ tab: { visible: true } }),
    inputActions: { insertQuote: (text) => { capture.push(['insertQuote', text]); return true } },
  }
}

// ---- quote-into-main action (feature branch #7) ----
{
  const state = panelState({ sessionId: 'side-1', nodes: [{ kind: 'assistant', seq: 2, blocks: [{ kind: 'text', text: 'reply text' }] }] })
  const capture = []
  const runtime = makeRuntime(state, capture)
  const { container, unmount } = await mount(React.createElement(bodySlot.component, bodyProps(state, capture, runtime)))
  const button = container.querySelector('.sc-return-btn')
  if (button === null) skip('quote action is not part of this branch')
  else {
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    check('quote action inserts the reply text', capture.some((c) => c[0] === 'insertQuote' && c[1] === 'reply text'), JSON.stringify(capture))
  }
  await unmount()
}

// ---- pending question card (feature branch #8) ----
{
  const question = { questions: [{ id: 'q1', question: 'Deploy?', options: [{ label: 'Yes' }] }] }
  const state = panelState({ sessionId: 'side-1' })
  const capture = []
  const runtime = makeRuntime(state, capture, question)
  const { container, unmount } = await mount(React.createElement(bodySlot.component, bodyProps(state, capture, runtime)))
  const discuss = container.querySelector('.sc-question-discuss')
  if (discuss === null) skip('question card is not part of this branch')
  else {
    await act(async () => { discuss.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    check('question card discuss writes the draft', capture.some((c) => c[0] === 'setDraft' && c[1].includes('Deploy?')), JSON.stringify(capture))
  }
  await unmount()
}

// ---- parent lookup toggle (feature branch #9) ----
{
  const state = panelState({ sessionId: null })
  const capture = []
  const runtime = makeRuntime(state, capture)
  const { container, unmount } = await mount(React.createElement(bodySlot.component, bodyProps(state, capture, runtime)))
  const toggle = container.querySelector('.sc-lookup')
  if (toggle === null) skip('parent lookup toggle is not part of this branch')
  else {
    await act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    check('lookup toggle forwards the switch', capture.some((c) => c[0] === 'toggleLookup'), JSON.stringify(capture))
  }
  await unmount()
}

// ---- turn process folds both ways (feature branch #11) ----
{
  const state = panelState({
    sessionId: 'side-1',
    nodes: [{ kind: 'process', seq: 2, turn: 1, start: 1000, end: 5000, reason: 'completed', blocks: [{ kind: 'reasoning', text: 'why' }] }],
  })
  const capture = []
  const runtime = makeRuntime(state, capture)
  const { container, unmount } = await mount(React.createElement(bodySlot.component, bodyProps(state, capture, runtime)))
  const button = container.querySelector('.sc-process')
  const folded = () => container.querySelector('.sc-process-body')
  if (button === null) skip('turn process row is not part of this branch')
  else {
    check('process row starts collapsed', folded() === null)
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    check('process row opens on click', folded() !== null)
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    check('process row closes on the second click', folded() === null)
  }
  await unmount()
}

// ---- selection action (feature branch #6) ----
if (interactions.length === 0 || surfaceSlot === undefined) skip('selection action is not part of this branch')
else {
  let opened = 0
  interactions[0].onInteraction({ trigger: 'selection', hasSelection: true, readText: () => 'selected', open: () => { opened += 1 } })
  check('selection admission opens the surface', opened === 1)
  const calls = []
  const { container, unmount } = await mount(React.createElement(surfaceSlot.component, {
    t: locale.bind('side-chat'),
    dismiss: () => calls.push(['dismiss']),
    readText: () => 'selected',
    open: (text) => calls.push(['open', text]),
  }))
  const button = container.querySelector('.sc-ask-action')
  check('selection surface renders the action', button !== null && button.textContent.length > 0)
  if (button !== null) {
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    check('selection action opens with the text', JSON.stringify(calls) === JSON.stringify([['open', 'selected'], ['dismiss']]), JSON.stringify(calls))
  }
  await unmount()
}

// ---- pending timestamp (fix branch #10) ----
{
  const time = 1700000000000
  const state = panelState({ pending: [{ id: 'p1', text: 'pending text', time }] })
  const capture = []
  const runtime = makeRuntime(state, capture)
  const { container, unmount } = await mount(React.createElement(bodySlot.component, bodyProps(state, capture, runtime)))
  const meta = container.querySelector('.sc-meta')
  if (meta === null) skip('pending row is not rendered')
  else if (EXPECT_PENDING_FIXED) {
    check('pending row uses the formatted clock time', !meta.textContent.includes(String(time)) && /^\d{2}:\d{2} · /.test(meta.textContent), meta.textContent)
  } else console.log('INFO pending meta (fix pending PR #10):', JSON.stringify(meta.textContent))
  await unmount()
}

// ---- selection companion (feature branch #6): one pill with the shipped action ----
if (surfaceSlot === undefined) skip('selection companion is not part of this branch')
else {
  const surface = document.createElement('div')
  surface.setAttribute('data-text-interaction-surface', '')
  surface.setAttribute('aria-hidden', 'false')
  surface.getBoundingClientRect = () => ({ left: 100, right: 220, top: 300, bottom: 326, width: 120, height: 26 })
  const quoteButton = document.createElement('button')
  quoteButton.className = 'quote-action'
  surface.append(quoteButton)
  document.body.append(surface)
  const previousSelection = window.getSelection
  window.getSelection = () => ({ toString: () => 'picked words', removeAllRanges() {} })
  const companion = slots.find((entry) => entry.options.id === 'side-chat.ask-companion')
  if (companion === undefined) skip('companion overlay is not part of this branch')
  else {
    const bodyRuntime = bodySlot.options.inject('main-1').runtime
    const { unmount } = await mount(React.createElement(companion.component, {}))
    const segment = surface.querySelector('.sc-ask-segment')
    check('companion appends its segment to the shipped surface', segment !== null && segment.textContent.includes('Ask in side chat'), surface.textContent)
    check('companion styles the pair as one pill', surface.classList.contains('sc-ask-surface'), surface.className)
    if (segment !== null) {
      await act(async () => { segment.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      check('companion opens a side chat', openedTabs.includes('side-chat'), JSON.stringify(openedTabs))
      const bodyProps = {
        ...bodySlot.options.inject('main-1'),
        t: locale.bind('side-chat'),
        useTabInfo: () => ({ tab: { visible: true, id: 'tab-companion' } }),
      }
      const { container: bodyContainer, unmount: unmountBody } = await mount(React.createElement(bodySlot.component, bodyProps))
      const tabState = bodyRuntime.getState('main-1#tab-companion')
      check('companion quotes the selection into the draft', tabState !== null && tabState.draft === '> picked words\n', JSON.stringify(tabState && tabState.draft))
      const textarea = bodyContainer.querySelector('.sc-textarea')
      check('composer focuses at the line after the quote', textarea !== null && document.activeElement === textarea
        && textarea.value === '> picked words\n' && textarea.selectionStart === '> picked words\n'.length,
        `${textarea === null ? 'no textarea' : `${textarea.selectionStart}/${textarea.value.length}`} active=${document.activeElement === textarea}`)
      await unmountBody()
    }
    await unmount()
    check('unmount removes the segment and the pill class', surface.querySelector('.sc-ask-segment') === null && !surface.classList.contains('sc-ask-surface'))
  }
  window.getSelection = previousSelection
  surface.remove()
}

console.log(failures.length === 0 ? '\nALL APPLICABLE CHECKS PASSED' : `\nFAILURES: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
