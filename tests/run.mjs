/**
 * Offline verification for the hermes-questionnaire desktop plugin.
 *
 *   node tests/run.mjs        (or: npm run verify)
 *
 * There is no Electron here, so this harness stands the app up in miniature:
 * a jsdom DOM, real React, and tests/sdk-stub.js in place of the app's SDK.
 * That exercises everything the plugin itself does — directive parsing, chunk
 * assembly, the form's answer state, the submitted answer block, persistence
 * and the clipboard fallback — and renders real markup for every surface.
 * It proves nothing about the app's own components or the Electron shell;
 * only the app can prove those.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { JSDOM } from 'jsdom'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const pluginPath = path.join(root, 'plugin.js')

// ---------------------------------------------------------------------------
// 0. make the stub importable (npm install prunes unrecognised folders)
// ---------------------------------------------------------------------------

const stubDir = path.join(root, 'node_modules', '@hermes', 'plugin-sdk')
fs.mkdirSync(stubDir, { recursive: true })
fs.copyFileSync(path.join(here, 'sdk-stub.js'), path.join(stubDir, 'index.js'))
fs.writeFileSync(
  path.join(stubDir, 'package.json'),
  `${JSON.stringify({ name: '@hermes/plugin-sdk', version: '0.0.0-stub', type: 'module', main: './index.js', exports: { '.': './index.js' } }, null, 2)}\n`
)

// ---------------------------------------------------------------------------
// 1. DOM + React
// ---------------------------------------------------------------------------

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://localhost/' })

globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
globalThis.atob = value => Buffer.from(value, 'base64').toString('binary')
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const sdk = await import('@hermes/plugin-sdk')

const results = []
const check = (name, fn) => {
  try {
    fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error: error?.stack ?? String(error) })
  }
}
const checkAsync = async (name, fn) => {
  try {
    await fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error: error?.stack ?? String(error) })
  }
}

async function mount(element) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  await act(async () => {
    root.render(element)
  })

  return {
    container,
    html: () => container.innerHTML,
    text: () => container.textContent ?? '',
    unmount: async () => act(async () => root.unmount())
  }
}

const click = async element => {
  assert.ok(element, 'expected an element to click')
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
}

const type = async (element, value) => {
  const proto =
    element.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype

  Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value)
  await act(async () => {
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}

const buttonByText = (container, text) =>
  [...container.querySelectorAll('button')].find(button => (button.textContent ?? '').includes(text))

// ---------------------------------------------------------------------------
// 2. build fixture directives with the shipped encoder
// ---------------------------------------------------------------------------

const python = process.env.PYTHON ?? 'python3'
const encode = spec => {
  const output = execFileSync(python, [path.join(root, 'scripts', 'questionnaire.py'), '-q', '-'], {
    input: JSON.stringify(spec),
    encoding: 'utf8'
  })

  return output.trim().split('\n\n')
}

const parseDirective = line => {
  const match = /^::([a-z][a-z0-9-]{0,63})\{([^{}]*)\}$/.exec(line.trim())
  assert.ok(match, `not a directive: ${line.slice(0, 80)}`)

  const attrs = {}

  for (const pair of match[2].matchAll(/([a-z][\w-]{0,63})=(?:"([^"]*)"|'([^']*)')/gi)) {
    attrs[pair[1].toLowerCase()] = pair[2] ?? pair[3] ?? ''
  }

  return { name: match[1], attrs, line: line.trim() }
}

const attrsFor = id => parseDirective(encode({ ...SPEC, id })[0]).attrs

const SPEC = {
  id: 'test-round-1',
  title: 'Round one',
  context: 'Why this round exists.',
  questions: [
    { id: 'q1', q: 'Pick one.', options: ['Alpha', 'Beta', 'Gamma'], recommended: 0 },
    { id: 'q2', q: 'Pick any.', options: ['Red', 'Green', 'Blue'], multi: true },
    { id: 'q3', q: 'Anything else?', long: true },
    { id: 'q4', q: 'Ship it?', options: ['Yes', 'No'] }
  ]
}

const BIG_SPEC = {
  id: 'test-round-big',
  title: 'Big round',
  questions: Array.from({ length: 24 }, (_, index) => ({
    id: `q${index + 1}`,
    q: `Question number ${index + 1} with a reasonably long prompt to push the payload size up?`,
    options: ['First option text', 'Second option text', 'Third option text', 'Fourth option text'],
    detail: 'A consequence line that also costs bytes in the encoded payload.'
  }))
}

// ---------------------------------------------------------------------------
// 3. plugin module + registration
// ---------------------------------------------------------------------------

const plugin = (await import(pathToFileURL(pluginPath).href)).default

const registered = []
const disposers = []
const storageWrites = []
let storageBacking = {}

const makeCtx = () => ({
  onDispose: fn => {
    disposers.push(fn)

    return () => {}
  },
  os: {
    writeClipboard: text => {
      sdk.calls.clipboard.push(text)

      return Promise.resolve(true)
    }
  },
  register: contribution => {
    registered.push(contribution)

    return () => {}
  },
  registerMany: contributions => {
    registered.push(...contributions)

    return () => {}
  },
  rest: async () => ({}),
  socket: () => () => {},
  source: `plugin:${plugin.id}`,
  storage: {
    get: (key, fallback) => (key in storageBacking ? storageBacking[key] : fallback),
    remove: key => {
      delete storageBacking[key]
    },
    set: (key, value) => {
      storageWrites.push({ key, value })
      storageBacking[key] = value
    }
  }
})

plugin.register(makeCtx())

const contribution = localId => registered.find(entry => entry.id === localId)
const directiveContribution = registered.find(entry => entry.area === 'transcript.directives')

check('plugin id matches the install folder name the app requires', () => {
  assert.equal(plugin.id, path.basename(root))
  assert.equal(plugin.id, 'hermes-questionnaire')
  assert.equal(typeof plugin.register, 'function')
  assert.ok(plugin.name && plugin.description)
  assert.equal(plugin.defaultEnabled, undefined, 'ships enabled by default (disk plugins load unless toggled off)')
})

check('registers directive, page, nav, palette command and status chip', () => {
  assert.equal(registered.length, 5)
  assert.equal(directiveContribution.data.name, 'questionnaire')
  assert.equal(contribution('page').area, 'routes')
  assert.equal(contribution('page').data.path, '/questionnaires')
  assert.equal(contribution('nav').area, 'sidebar.nav')
  assert.equal(contribution('nav').data.path, '/questionnaires')
  assert.equal(contribution('nav').data.label, 'Questionnaires')
  assert.equal(contribution('open').area === 'commandPalette' || contribution('open').area === 'palette', true)
  assert.equal(contribution('chip').area, 'statusBar.right')
})

check('injects its stylesheet through the plugin-owned element', () => {
  const style = document.getElementById('hermes-questionnaire-styles')
  assert.ok(style, 'style element injected')
  assert.ok(style.textContent.includes('.hq-card'))
  assert.ok(!/#[0-9a-f]{3,6}\b/i.test(style.textContent.replace(/--[a-z-]+/g, '')), 'no hardcoded hex colors')
})

// ---------------------------------------------------------------------------
// 4. directive rendering
// ---------------------------------------------------------------------------

const renderDirective = async attrs => {
  const element = directiveContribution.data.render({ attrs, source: '', streaming: false })

  if (element === null) {
    return { container: null, text: () => '', html: () => '', unmount: async () => {} }
  }

  return mount(element)
}

const renderParts = async lines => {
  const views = []

  for (const line of lines) {
    views.push(await renderDirective(parseDirective(line).attrs))
  }

  return views
}

const [single] = encode(SPEC)
const parsed = parseDirective(single)

check('encoder emits one whole-line directive for a small spec', () => {
  assert.equal(parsed.name, 'questionnaire')
  assert.equal(parsed.attrs.id, 'test-round-1')
  assert.equal(parsed.attrs.part, undefined)
  assert.ok(parsed.line.length <= 1200, 'directive under the parser length cap')
  assert.ok(parsed.attrs.data.length <= 1024)
})

const big = encode(BIG_SPEC)

// Cross-check the encoder against the app's OWN directive parser, when the
// Hermes source tree is available: the regexes, the 1200-char ceiling and the
// no-newline rule are read straight out of transcript-directives.ts.
check('every emitted directive satisfies the app parser, verbatim rules', () => {
  const parserPath =
    process.env.HQ_TRANSCRIPT_PARSER ??
    '/home/gct/.hermes/hermes-agent/apps/desktop/src/lib/transcript-directives.ts'

  if (!fs.existsSync(parserPath)) {
    console.log(`      (skipped: ${parserPath} not present)`)

    return
  }

  const source = fs.readFileSync(parserPath, 'utf8')
  const directiveSource = /const DIRECTIVE_RE = (\/[^\n]+?\/[a-z]*)\n/.exec(source)?.[1]
  const attrSource = /const ATTR_RE = (\/[^\n]+?\/[a-z]*)\n/.exec(source)?.[1]

  assert.ok(directiveSource && attrSource, 'parser regexes found in the app source')

  const directiveRe = new RegExp(directiveSource.slice(1, directiveSource.lastIndexOf('/')))
  const attrRe = new RegExp(attrSource.slice(1, attrSource.lastIndexOf('/')), 'gi')
  const emitted = [...encode(SPEC), ...encode(BIG_SPEC)]

  for (const line of emitted) {
    const trimmed = line.trim()
    assert.ok(trimmed.startsWith('::') && !trimmed.includes('\n'), 'one line per directive')
    assert.ok(trimmed.length <= 1200, `under the app's 1200-char ceiling (${trimmed.length})`)

    const match = directiveRe.exec(trimmed)
    assert.ok(match, `app DIRECTIVE_RE matches: ${trimmed.slice(0, 60)}…`)

    const attrs = [...match[2].matchAll(attrRe)].reduce((acc, pair) => ({ ...acc, [pair[1]]: pair[2] }), {})
    assert.ok(attrs.id && attrs.data, 'id + data survive the app attribute scanner')
    assert.ok(match[2].length <= 1024, 'attr body inside the parser cap')
  }
})

check('encoder chunks a 24-question spec into reassemblable parts', () => {
  assert.ok(big.length > 1, `expected multiple parts, got ${big.length}`)
  const parts = big.map(parseDirective)
  parts.forEach((part, index) => {
    assert.equal(part.attrs.id, 'test-round-big')
    assert.equal(part.attrs.part, `${index + 1}/${parts.length}`)
    assert.ok(part.line.length <= 1200)
    assert.ok(part.attrs.data.length <= 1024)
  })
})

await checkAsync('renders a native card with every question, option and control', async () => {
  const view = await renderDirective(parsed.attrs)
  const text = view.text()

  assert.ok(text.includes('Round one'), 'title')
  assert.ok(text.includes('Why this round exists.'), 'context')
  assert.ok(text.includes('Pick one.') && text.includes('Anything else?'))
  for (const option of ['Alpha', 'Beta', 'Gamma', 'Red', 'Green', 'Blue', 'Yes', 'No']) {
    assert.ok(text.includes(option), `option ${option}`)
  }
  assert.ok(text.includes('0 / 4'), 'progress starts at zero')
  assert.equal(buttonByText(view.container, 'Send to Hermes').disabled, true, 'send disabled with no answers')
  assert.equal(view.container.querySelectorAll('input[type="checkbox"]').length, 3, 'three multi-select boxes')
  assert.ok(view.container.querySelector('textarea'), 'long free-text field')
  await view.unmount()
})

await checkAsync('reassembles chunked parts into one card, and non-anchor parts render nothing', async () => {
  const parts = big.map(parseDirective)
  const later = await renderDirective(parts[1].attrs)
  assert.equal(later.text(), '', 'a non-anchor part renders nothing')
  await later.unmount()

  const anchor = await renderDirective(parts[0].attrs)
  assert.ok(anchor.text().includes('Question number 24') === false, 'card waits for the remaining parts')
  assert.ok(anchor.text().includes('Assembling questionnaire'), anchor.text())

  const rest = await renderParts(big.slice(1))
  assert.ok(anchor.text().includes('Question number 24'), 'all 24 questions assembled once every part is present')
  assert.ok(anchor.text().includes('0 / 24'))

  for (const view of rest) {
    assert.equal(view.text(), '', 'sibling parts stay blank')
    await view.unmount()
  }

  await anchor.unmount()
})

const fieldByPlaceholder = (container, placeholder) =>
  [...container.querySelectorAll('textarea, input')].find(
    field => (field.getAttribute('placeholder') ?? '') === placeholder
  )

await checkAsync('answering works: single choice, multi-select and free text', async () => {
  const view = await renderDirective(attrsFor('round-answering'))

  await click(buttonByText(view.container, 'Beta'))
  assert.ok(view.text().includes('1 / 4'), `progress counts the choice, saw: ${view.text().slice(0, 80)}`)
  assert.equal(buttonByText(view.container, 'Send to Hermes').disabled, false)

  const boxes = [...view.container.querySelectorAll('input[type="checkbox"]')]
  await click(boxes[0])
  await click(boxes[2])

  const freeText = fieldByPlaceholder(view.container, 'Your answer')
  assert.ok(freeText, 'the long free-text question renders its own field')
  await type(freeText, 'Prefers the second option for cost reasons.')
  assert.ok(view.text().includes('3 / 4'), 'multi-select question counts once')

  await view.unmount()
})

await checkAsync('submits a parseable answer block into the focused chat', async () => {
  sdk.__reset()
  const view = await renderDirective(attrsFor('round-submit'))

  await click(buttonByText(view.container, 'Beta'))
  const boxes = [...view.container.querySelectorAll('input[type="checkbox"]')]
  await click(boxes[0])
  await click(boxes[2])
  await type(fieldByPlaceholder(view.container, 'Your answer'), 'All good otherwise.')
  await click(buttonByText(view.container, 'Send to Hermes'))

  assert.equal(sdk.calls.submitted.length, 1, 'one submission')
  const { sessionId, text } = sdk.calls.submitted[0]
  assert.equal(sessionId, 'runtime-session-1', 'targets the focused session')

  assert.ok(text.startsWith('[questionnaire answers] id=round-submit'), text.slice(0, 60))

  const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
  assert.deepEqual(json.answers.q1, 'Beta')
  assert.deepEqual(json.answers.q2, ['Red', 'Blue'])
  assert.equal(json.answers.q3, 'All good otherwise.')
  assert.deepEqual(json.unanswered, ['q4'])
  assert.equal(json.answers.q4, undefined, 'unanswered questions are never invented')

  assert.ok(view.text().includes('sent'), 'card switches to the sent state')
  assert.ok(buttonByText(view.container, 'Send again'))
  assert.equal(sdk.calls.notify.at(-1).kind, 'success')
  await view.unmount()
})

await checkAsync('falls back to the clipboard instead of claiming a write that did not land', async () => {
  sdk.__reset()
  sdk.calls.submitResult = false
  const view = await renderDirective(attrsFor('round-fallback'))

  await click(buttonByText(view.container, 'Alpha'))
  await click(buttonByText(view.container, 'Send to Hermes'))

  assert.equal(sdk.calls.clipboard.length, 1, 'answer block copied')
  assert.ok(sdk.calls.clipboard[0].includes('"q1": "Alpha"'))
  const warning = sdk.calls.notify.at(-1)
  assert.equal(warning.kind, 'warning')
  assert.ok(warning.action?.label, 'offers a way to the board')
  assert.ok(!view.text().includes('sent'), 'never shows the sent state after a failed submit')

  sdk.calls.submitResult = true
  await view.unmount()
})

await checkAsync('answers persist and survive a plugin reload', async () => {
  sdk.__reset()
  const persistAttrs = attrsFor('round-persist')
  const first = await renderDirective(persistAttrs)
  await click(buttonByText(first.container, 'Gamma'))
  await first.unmount()

  assert.ok(storageWrites.length > 0, 'answers written through ctx.storage')
  const persisted = storageWrites.at(-1).value
  assert.equal(persisted.answers['round-persist'].q1.choice, 'Gamma')

  // A reload is a fresh module instance reading the same storage.
  const reloaded = (await import(`${pathToFileURL(pluginPath).href}?reload=1`)).default
  reloaded.register(makeCtx())

  const reloadedDirective = registered.filter(entry => entry.area === 'transcript.directives').at(-1)
  assert.ok(reloadedDirective, 'reload re-registered the directive')

  const element = reloadedDirective.data.render({ attrs: persistAttrs, source: '', streaming: false })
  const view = await mount(element)
  assert.ok(view.text().includes('1 / 4'), `restored answer count, saw: ${view.text().slice(0, 120)}`)
  await view.unmount()
})

await checkAsync('a corrupt or absent payload degrades to a card, never a crash', async () => {
  const broken = await renderDirective({ id: 'broken-1', data: 'not-base64!!' })
  assert.ok(broken.text().includes('could not be read'))
  await broken.unmount()

  const empty = directiveContribution.data.render({ attrs: {}, source: '', streaming: false })
  assert.ok(empty, 'always returns an element')
  const emptyView = await mount(empty)
  assert.ok(emptyView.text().includes('could not be read'), 'a data-less directive reports itself')
  await emptyView.unmount()

  const streaming = await renderDirective({ id: 'half-1', part: '1/2', data: parsed.attrs.data })
  assert.ok(streaming.text().includes('Assembling questionnaire 1/2'))
  await streaming.unmount()
})

await checkAsync('pop-out dialog mounts the same form natively', async () => {
  const view = await renderDirective(parsed.attrs)
  assert.equal(view.container.querySelector('[data-slot="dialog"]'), null, 'closed by default')

  const popout = [...view.container.querySelectorAll('button')].find(
    button => button.getAttribute('aria-label') === 'Open as a pop-up'
  )
  await click(popout)

  const dialog = view.container.querySelector('[data-slot="dialog"]')
  assert.ok(dialog, 'dialog opened')
  assert.ok(dialog.textContent.includes('Round one'))
  assert.equal(view.container.querySelectorAll('[data-slot="dialog"]').length, 1)
  await view.unmount()
})

// ---------------------------------------------------------------------------
// 5. page, chip, commands
// ---------------------------------------------------------------------------

await checkAsync('the board lists rounds and loads a pasted directive', async () => {
  // Feed every part of the chunked round, the way a transcript would.
  const rest = await renderParts(big.slice(1))

  const view = await mount(contribution('page').render())

  assert.ok(view.text().includes('Questionnaires'))
  assert.ok(view.text().includes('Round one'), 'fixture round listed')
  assert.ok(view.text().includes('Big round'), 'chunked round listed once complete')
  assert.ok(view.text().includes('Load a directive'))

  const pasted = encode({ id: 'test-round-pasted', title: 'Pasted round', questions: [{ id: 'p1', q: 'Loaded?' }] })

  const pasteField = [...view.container.querySelectorAll('textarea')].find(field =>
    (field.getAttribute('placeholder') ?? '').startsWith('::questionnaire')
  )
  assert.ok(pasteField, 'the paste loader field is present')
  await type(pasteField, pasted[0])
  await click(buttonByText(view.container, 'Load'))
  assert.equal(sdk.calls.notify.at(-1).kind, 'success', 'pasted directive loads')
  assert.ok(view.text().includes('Pasted round'), 'and appears in the list')

  await view.unmount()

  for (const part of rest) {
    await part.unmount()
  }
})

await checkAsync('the status-bar chip counts unanswered rounds and drops one when answered', async () => {
  const chipCount = async () => {
    const view = await mount(contribution('chip').render())
    const match = /(\d+) open/.exec(view.text())
    const count = match ? Number(match[1]) : 0
    await view.unmount()

    return count
  }

  const before = await chipCount()

  const chipLine = encode({
    id: 'chip-round-1',
    title: 'Chip round',
    questions: [{ id: 'c1', q: 'First?' }, { id: 'c2', q: 'Second?' }]
  })[0]
  const card = await renderDirective(parseDirective(chipLine).attrs)

  assert.equal(await chipCount(), before + 1, 'an unanswered round bumps the chip')

  await type(fieldByPlaceholder(card.container, 'Your answer'), 'first answer')
  const fields = [...card.container.querySelectorAll('input')]
  await type(fields.at(-1), 'second answer')

  assert.equal(await chipCount(), before, 'answering it drops the chip back')

  await card.unmount()
})

check('the ⌘K command opens the board', () => {
  sdk.__reset()
  contribution('open').data.run()
  assert.deepEqual(sdk.calls.navigate, ['/questionnaires'])
})

// ---------------------------------------------------------------------------
// 6. report
// ---------------------------------------------------------------------------

const failures = results.filter(entry => !entry.ok)

for (const entry of results) {
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}`)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} of ${results.length} checks failed:\n`)
  failures.forEach(entry => console.error(`--- ${entry.name}\n${entry.error}\n`))
  process.exitCode = 1
} else {
  console.log(`\nall ${results.length} checks passed`)
}
