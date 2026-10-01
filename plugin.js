/**
 * hermes-questionnaire — native questionnaire cards for the Hermes desktop app.
 *
 * WHAT IT DOES
 *   The assistant answers a question round by emitting ONE paragraph of the form
 *
 *     ::questionnaire{id="cnf-1" part="1/3" data="<base64url JSON>"}
 *
 *   and this plugin renders it as a real, native form inside the assistant's
 *   message: choice rows, multi-select checkboxes, note fields, free text,
 *   progress, and a "Send to Hermes" button that submits the answers back into
 *   the chat as a normal user message. No HTML page, no browser, no paste-back.
 *
 *   Long questionnaires are CHUNKED: several `::questionnaire` paragraphs with
 *   the same `id` and increasing `part` ("1/3", "2/3", …) are reassembled into
 *   one card. Part "1/n" is the anchor that renders; the other parts render
 *   nothing. Each part must be its own paragraph (blank line between parts) —
 *   a directive only parses as a whole single-line paragraph.
 *
 *   Part of the app's transcript-directive area, so an UNCLAIMED directive
 *   (plugin off) simply stays the text it was — nothing breaks.
 *
 * ALSO CONTRIBUTES
 *   - a full page + sidebar row ("Questionnaires") listing every round found in
 *     this window, with a paste-a-directive loader for rounds copied from
 *     elsewhere;
 *   - a "pop out" dialog on every card (a native modal, draggable-free, no
 *     window juggling);
 *   - a ⌘K command and a status-bar chip showing how many rounds are unanswered.
 *
 * ANSWERS
 *   Submitted through `host.composer.submit` — the same door the app's own
 *   panels use, so the answers arrive as a normal user turn in the focused
 *   chat. If no live composer owns that session (background tile, dead
 *   socket), the plugin copies the answer block to the clipboard instead and
 *   says so, rather than pretending the write landed.
 *
 * STYLE NOTE
 *   A disk plugin is not scanned by Tailwind, so structural styles are injected
 *   as CSS with theme variables (`--ui-*`) only — the card reskins with every
 *   theme. Layout uses the SDK's own components so chrome matches core.
 */

import {
  Badge,
  Button,
  Checkbox,
  Codicon,
  CopyButton,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  PALETTE_AREA,
  ROUTES_AREA,
  ScrollArea,
  Separator,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  Textarea,
  TRANSCRIPT_DIRECTIVE_AREA,
  atom,
  host,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useMemo, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const PLUGIN_ID = 'hermes-questionnaire'
const DIRECTIVE_NAME = 'questionnaire'
const PAGE_PATH = '/questionnaires'
const FALLBACK_TITLE = 'Questionnaire'

const CSS = `
.hq-card{display:flex;flex-direction:column;gap:10px;width:100%;max-width:min(620px,100%);
  margin:12px 0;padding:12px;border:1px solid var(--ui-stroke-secondary);border-radius:6px;
  background:var(--ui-chat-bubble-background,transparent);box-sizing:border-box}
.hq-head{display:flex;align-items:flex-start;gap:8px;justify-content:space-between}
.hq-title{font-size:13px;font-weight:600;line-height:18px;color:var(--ui-text-primary);min-width:0}
.hq-context{margin-top:4px;font-size:11.5px;line-height:16px;color:var(--ui-text-tertiary)}
.hq-questions{display:flex;flex-direction:column;gap:2px;max-height:min(52vh,440px);overflow:auto;
  overscroll-behavior:contain}
.hq-q{display:flex;flex-direction:column;gap:6px;padding:10px 0;border-top:1px solid var(--ui-stroke-secondary)}
.hq-q:first-child{border-top:0;padding-top:2px}
.hq-prompt{display:flex;gap:6px;align-items:baseline;font-size:12.5px;font-weight:500;line-height:17px;
  color:var(--ui-text-primary)}
.hq-num{flex-shrink:0;font-size:11px;font-variant-numeric:tabular-nums;color:var(--ui-text-quaternary)}
.hq-detail{font-size:11.5px;line-height:16px;color:var(--ui-text-tertiary);margin-top:-2px}
.hq-opts{display:flex;flex-direction:column;gap:4px}
.hq-choice{display:flex;align-items:flex-start;gap:6px;width:100%;text-align:left;cursor:pointer;
  padding:6px 8px;border:1px solid var(--ui-stroke-secondary);border-radius:4px;background:transparent;
  color:var(--ui-text-primary);font-size:12px;line-height:17px;transition:background 100ms,border-color 100ms}
.hq-choice:hover{background:var(--chrome-action-hover)}
.hq-choice[data-picked=true]{border-color:var(--ui-accent);
  box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--ui-accent) 60%,transparent)}
.hq-choice-text{flex:1;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}
.hq-choice-flag{flex-shrink:0}
.hq-checkrow{display:flex;align-items:flex-start;gap:8px;padding:5px 8px;border-radius:4px;cursor:pointer;
  font-size:12px;line-height:17px;color:var(--ui-text-primary)}
.hq-checkrow:hover{background:var(--chrome-action-hover)}
.hq-note{margin-top:2px}
.hq-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.hq-foot-gap{flex:1;min-width:8px}
.hq-meta{font-size:11px;line-height:15px;color:var(--ui-text-tertiary)}
.hq-assembling{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--ui-text-tertiary)}
.hq-list{display:flex;flex-direction:column;gap:6px;width:100%}
.hq-row{display:flex;align-items:center;gap:8px;width:100%;text-align:left;cursor:pointer;
  padding:8px 10px;border:1px solid transparent;border-radius:4px;background:transparent;
  color:var(--ui-text-primary);font-size:12px}
.hq-row:hover{background:var(--chrome-action-hover)}
.hq-row[data-active=true]{border-color:var(--ui-stroke-secondary);background:var(--ui-bg-quaternary,transparent)}
.hq-row-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hq-page{display:flex;flex-direction:column;gap:12px;height:100%;min-height:0;padding:16px;
  box-sizing:border-box;overflow:auto}
.hq-page-head{display:flex;flex-direction:column;gap:4px}
.hq-page-title{font-size:14px;font-weight:600;color:var(--ui-text-primary)}
.hq-page-sub{font-size:11.5px;line-height:16px;color:var(--ui-text-tertiary);max-width:70ch}
.hq-page-grid{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
.hq-page-col{display:flex;flex-direction:column;gap:8px;min-width:260px;flex:1 1 280px;max-width:340px}
.hq-page-main{flex:2 1 380px;min-width:280px}
.hq-paste{display:flex;flex-direction:column;gap:6px}
.hq-panel{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--ui-stroke-secondary);
  border-radius:6px}
.hq-popup-body{display:flex;flex-direction:column;gap:8px;max-height:min(70vh,620px);overflow:auto}
`

function injectStyles() {
  if (typeof document === 'undefined') {
    return () => {}
  }

  const styleId = `${PLUGIN_ID}-styles`

  if (document.getElementById(styleId)) {
    return () => {}
  }

  const el = document.createElement('style')
  el.id = styleId
  el.textContent = CSS
  document.head.appendChild(el)

  return () => el.remove()
}

// ---------------------------------------------------------------------------
// payload decoding
// ---------------------------------------------------------------------------

/** base64url (no padding) → UTF-8 text. Written by scripts/questionnaire.py. */
function b64ToText(encoded) {
  const normalized = String(encoded).replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }

  return new TextDecoder().decode(bytes)
}

/** Stable id when the author omitted one — FNV-1a over the chunk bodies. */
function hashId(text) {
  let hash = 0x811c9dc5

  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return `q${hash.toString(36)}`
}

function parsePart(raw) {
  const text = String(raw ?? '').trim()
  const match = /^(\d+)\s*(?:\/\s*(\d+))?$/.exec(text)

  if (!match) {
    return { index: 1, total: 1 }
  }

  const index = Math.max(1, Number.parseInt(match[1], 10) || 1)
  const total = Math.max(index, Number.parseInt(match[2] ?? String(index), 10) || index)

  return { index, total }
}

const clean = (value, limit = 400) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit)

/**
 * Validate an untrusted payload (model output, or text a user pasted) into the
 * shape the card renders. Anything unusable is dropped rather than guessed at.
 */
function normalizeSpec(raw) {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const questions = Array.isArray(raw.questions) ? raw.questions : []
  const normalized = []

  for (const entry of questions.slice(0, 100)) {
    if (!entry || typeof entry !== 'object') {
      continue
    }

    const id = clean(entry.id, 64)
    const prompt = clean(entry.q ?? entry.question, 600)

    if (!id || !prompt) {
      continue
    }

    const options = Array.isArray(entry.options)
      ? entry.options.map(option => clean(option, 220)).filter(Boolean).slice(0, 12)
      : []
    const recommended = Number.isInteger(entry.recommended) && entry.recommended >= 0 && entry.recommended < options.length
      ? entry.recommended
      : -1

    normalized.push({
      id,
      prompt,
      detail: clean(entry.detail, 400),
      options,
      recommended,
      multi: Boolean(entry.multi) && options.length > 0,
      freeText: Boolean(entry.freeText) || options.length === 0,
      long: Boolean(entry.long),
      note: entry.note !== false,
      required: Boolean(entry.required)
    })
  }

  if (normalized.length === 0) {
    return null
  }

  return {
    title: clean(raw.title, 200) || FALLBACK_TITLE,
    context: clean(raw.context, 600),
    questions: normalized
  }
}

// ---------------------------------------------------------------------------
// plugin state
// ---------------------------------------------------------------------------

/** id → { id, total, chunks: { index: body } } — raw, possibly incomplete. */
const $forms = atom({})
/** id → { qid: { choice, choices, text, note } } */
const $answers = atom({})
/** id → { at, text } */
const $sent = atom({})

let pluginCtx = null
let loaded = false

function loadPersisted() {
  if (loaded || !pluginCtx) {
    return
  }

  loaded = true

  try {
    const saved = pluginCtx.storage.get('answers', null)

    if (saved && typeof saved === 'object') {
      $answers.set(saved.answers && typeof saved.answers === 'object' ? saved.answers : {})
      $sent.set(saved.sent && typeof saved.sent === 'object' ? saved.sent : {})
    }
  } catch {
    // A storage read is a convenience, never a requirement.
  }
}

function persist() {
  try {
    pluginCtx?.storage.set('answers', { answers: $answers.get(), sent: $sent.get() })
  } catch {
    // Ignore quota/format failures — the card still works in-session.
  }
}

/** Idempotent: identical chunks write nothing, so calling it during render is safe. */
function registerPayload(attrs) {
  const body = String(attrs?.data ?? '').trim()

  if (!body) {
    return null
  }

  const part = parsePart(attrs?.part)
  const id = clean(attrs?.id, 64) || hashId(String(attrs?.part ?? '') + body)
  const current = $forms.get()
  const previous = current[id]

  if (previous && previous.chunks[part.index] === body && previous.total === part.total) {
    return id
  }

  $forms.set({
    ...current,
    [id]: {
      id,
      total: part.total,
      chunks: { ...previous?.chunks, [part.index]: body }
    }
  })

  return id
}

/** Assemble + decode a form. Returns null until every part has arrived. */
function decodeForm(form) {
  if (!form) {
    return null
  }

  const total = Math.max(1, form.total || 1)

  for (let index = 1; index <= total; index += 1) {
    if (!form.chunks[index]) {
      return null
    }
  }

  const joined = Array.from({ length: total }, (_, index) => form.chunks[index + 1]).join('')

  try {
    return normalizeSpec(JSON.parse(b64ToText(joined)))
  } catch {
    return null
  }
}

const EMPTY_ANSWER = { choice: null, choices: [], text: '', note: '' }

function readAnswer(formId, questionId) {
  const forForm = $answers.get()[formId]

  return (forForm && forForm[questionId]) || EMPTY_ANSWER
}

function setAnswer(formId, questionId, patch) {
  const all = $answers.get()
  const forForm = all[formId] || {}
  const next = { ...EMPTY_ANSWER, ...(forForm[questionId] || EMPTY_ANSWER), ...patch }

  $answers.set({ ...all, [formId]: { ...forForm, [questionId]: next } })
  persist()
}

function answerValue(question, answer) {
  if (question.multi) {
    return answer.choices.length > 0 ? answer.choices : null
  }

  if (answer.choice) {
    return answer.choice
  }

  return clean(answer.text, 1000) || null
}

function isAnswered(question, answer) {
  return answerValue(question, answer) !== null
}

function progressOf(formId, spec, answersForRender) {
  if (!spec) {
    return { answered: 0, total: 0, unanswered: [] }
  }

  const source = answersForRender || $answers.get()
  const forForm = source[formId] || {}
  const unanswered = []

  for (const question of spec.questions) {
    if (!isAnswered(question, forForm[question.id] || EMPTY_ANSWER)) {
      unanswered.push(question.id)
    }
  }

  return { answered: spec.questions.length - unanswered.length, total: spec.questions.length, unanswered }
}

/** The exact text submitted back into the chat — also the copy payload. */
function buildAnswerText(formId, spec) {
  const answers = {}
  const notes = {}
  const unanswered = []

  for (const question of spec.questions) {
    const answer = readAnswer(formId, question.id)

    if (!isAnswered(question, answer)) {
      unanswered.push(question.id)
    } else {
      answers[question.id] = answerValue(question, answer)
    }

    const note = clean(answer.note, 600)

    if (note) {
      notes[question.id] = note
    }
  }

  const payload = { answers }

  if (Object.keys(notes).length > 0) {
    payload.notes = notes
  }

  if (unanswered.length > 0) {
    payload.unanswered = unanswered
  }

  return `[questionnaire answers] id=${formId} title=${spec.title}\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``
}

function markSent(formId, text) {
  $sent.set({ ...$sent.get(), [formId]: { at: Date.now(), text } })
  persist()
}

function clearSent(formId) {
  const next = { ...$sent.get() }
  delete next[formId]
  $sent.set(next)
  persist()
}

/**
 * Send the answer block as a user turn in the focused chat. Fail-closed: if no
 * live composer owns that session the text goes to the clipboard and we say so.
 */
function submitAnswers(formId, spec) {
  const text = buildAnswerText(formId, spec)
  const sessionId = host.state.focusedSessionId.get() ?? host.state.activeSessionId.get() ?? null
  let sent = false

  try {
    sent = Boolean(host.composer.submit(sessionId, text))
  } catch {
    sent = false
  }

  if (sent) {
    markSent(formId, text)
    host.notify({ kind: 'success', message: `Answers sent to Hermes (${spec.title}).` })

    return true
  }

  void pluginCtx?.os.writeClipboard(text)
  host.notify({
    action: { label: 'Open Questionnaires', onClick: () => host.navigate(PAGE_PATH) },
    kind: 'warning',
    message: 'No live chat received the answers — they are on your clipboard instead.'
  })

  return false
}

// ---------------------------------------------------------------------------
// question UI
// ---------------------------------------------------------------------------

function ChoiceRow({ multi, picked, recommended, text, onPick }) {
  if (multi) {
    return jsxs('label', {
      className: 'hq-checkrow',
      children: [
        jsx(Checkbox, { checked: picked, onCheckedChange: () => onPick() }),
        jsx('span', { className: 'hq-choice-text', children: text }),
        recommended &&
          jsx(Badge, { className: 'hq-choice-flag', size: 'xs', variant: 'muted', children: 'rec' })
      ]
    })
  }

  return jsxs('button', {
    className: 'hq-choice',
    'data-picked': picked ? 'true' : 'false',
    onClick: onPick,
    type: 'button',
    children: [
      jsx('span', { className: 'hq-choice-text', children: text }),
      recommended &&
        jsx(Badge, { className: 'hq-choice-flag', size: 'xs', variant: 'muted', children: 'rec' })
    ]
  })
}

function QuestionBlock({ formId, question, index }) {
  const answers = useValue($answers)
  const answer = (answers[formId] && answers[formId][question.id]) || EMPTY_ANSWER
  const picked = answerValue(question, answer) !== null

  const pick = value => setAnswer(formId, question.id, { choice: value })

  const toggle = value => {
    const current = readAnswer(formId, question.id).choices
    const next = current.includes(value) ? current.filter(item => item !== value) : [...current, value]

    setAnswer(formId, question.id, { choices: next })
  }

  const showNote = question.note && !question.long

  return jsxs('div', {
    className: 'hq-q',
    children: [
      jsxs('div', {
        className: 'hq-prompt',
        children: [
          jsx('span', { className: 'hq-num', children: `${index + 1}.` }),
          jsx('span', { children: question.prompt }),
          picked && jsx(Codicon, { className: 'hq-choice-flag', name: 'check', size: '0.75rem' })
        ]
      }),
      question.detail && jsx('div', { className: 'hq-detail', children: question.detail }),
      question.options.length > 0 &&
        jsx('div', {
          className: 'hq-opts',
          children: question.options.map((option, optionIndex) =>
            jsx(
              ChoiceRow,
              {
                multi: question.multi,
                onPick: () => (question.multi ? toggle(option) : pick(option)),
                picked: question.multi ? answer.choices.includes(option) : answer.choice === option,
                recommended: question.recommended === optionIndex,
                text: option
              },
              `${question.id}-${optionIndex}`
            )
          )
        }),
      question.freeText &&
        (question.long
          ? jsx(Textarea, {
              onChange: event => setAnswer(formId, question.id, { text: event.target.value }),
              placeholder: 'Your answer',
              rows: 3,
              value: answer.text
            })
          : jsx(Input, {
              onChange: event => setAnswer(formId, question.id, { text: event.target.value }),
              onKeyDown: event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                }
              },
              placeholder: 'Your answer',
              value: answer.text
            })),
      showNote &&
        jsx('div', {
          className: 'hq-note',
          children: jsx(Textarea, {
            onChange: event => setAnswer(formId, question.id, { note: event.target.value }),
            placeholder: 'Note (optional)',
            rows: 2,
            size: 'sm',
            value: answer.note
          })
        })
    ]
  })
}

function QuestionnaireBody({ formId, spec, allowPopup }) {
  const sent = useValue($sent)
  // Subscribe to the answer store here: progress, the send button's disabled
  // state and the footer copy all derive from it, and the question blocks'
  // own subscriptions do not re-render their parent.
  const answers = useValue($answers)
  const [popupOpen, setPopupOpen] = useState(false)
  const progress = progressOf(formId, spec, answers)
  const sentEntry = sent[formId]

  const body = jsxs('div', {
    className: 'hq-card',
    children: [
      jsxs('div', {
        className: 'hq-head',
        children: [
          jsxs('div', {
            className: 'hq-title',
            children: [
              spec.title,
              spec.context && jsx('div', { className: 'hq-context', children: spec.context })
            ]
          }),
          jsxs('div', {
            className: 'hq-foot',
            children: [
              jsx(Badge, {
                size: 'xs',
                variant: progress.unanswered.length === 0 ? 'success' : 'muted',
                children: `${progress.answered} / ${progress.total}`
              }),
              allowPopup &&
                jsx(Button, {
                  'aria-label': 'Open as a pop-up',
                  onClick: () => setPopupOpen(true),
                  size: 'icon-xs',
                  variant: 'ghost',
                  children: jsx(Codicon, { name: 'link-external', size: '0.75rem' })
                })
            ]
          })
        ]
      }),
      jsx('div', {
        className: 'hq-questions',
        children: spec.questions.map(question =>
          jsx(QuestionBlock, { formId, index: spec.questions.indexOf(question), question }, question.id)
        )
      }),
      jsx(Separator, {}),
      sentEntry
        ? jsxs('div', {
            className: 'hq-foot',
            children: [
              jsx(Badge, { size: 'xs', variant: 'success', children: 'sent' }),
              jsx('span', {
                className: 'hq-meta',
                children: 'Answers submitted to this chat. Edit anything above and send again to revise.'
              }),
              jsx('span', { className: 'hq-foot-gap' }),
              jsx(CopyButton, {
                buttonSize: 'sm',
                buttonVariant: 'outline',
                label: 'Copy',
                showLabel: true,
                text: sentEntry.text
              }),
              jsx(Button, {
                onClick: () => submitAnswers(formId, spec),
                size: 'sm',
                variant: 'secondary',
                children: 'Send again'
              }),
              jsx(Button, {
                onClick: () => clearSent(formId),
                size: 'sm',
                variant: 'ghost',
                children: 'Reopen'
              })
            ]
          })
        : jsxs('div', {
            className: 'hq-foot',
            children: [
              jsx(Button, {
                disabled: progress.answered === 0,
                onClick: () => submitAnswers(formId, spec),
                size: 'sm',
                children: 'Send to Hermes'
              }),
              jsx(CopyButton, {
                buttonSize: 'sm',
                buttonVariant: 'outline',
                label: 'Copy answers',
                showLabel: true,
                text: () => buildAnswerText(formId, spec)
              }),
              jsx('span', { className: 'hq-foot-gap' }),
              jsx('span', {
                className: 'hq-meta',
                children:
                  progress.unanswered.length === 0
                    ? 'All questions answered.'
                    : `${progress.unanswered.length} left — you can send a partial round.`
              })
            ]
          })
    ]
  })

  if (!allowPopup) {
    return body
  }

  return jsxs('div', {
    children: [
      body,
      jsx(Dialog, {
        onOpenChange: setPopupOpen,
        open: popupOpen,
        children: jsx(DialogContent, {
          bodyClassName: 'hq-popup-body',
          children: jsxs('div', {
            className: 'hq-popup-body',
            children: [
              jsx(DialogHeader, {
                children: [
                  jsx(DialogTitle, { children: spec.title }, 'title'),
                  jsx(
                    DialogDescription,
                    { children: 'Answer here, then send — the same answers as the card in the chat.' },
                    'description'
                  )
                ]
              }),
              jsx(QuestionnaireBody, { allowPopup: false, formId, spec })
            ]
          })
        })
      })
    ]
  })
}

/** Inline transcript leaf: part 1 renders the card, every other part renders nothing. */
function QuestionnaireDirective({ attrs, streaming }) {
  const part = useMemo(() => parsePart(attrs?.part), [attrs?.part])
  const [formId, setFormId] = useState(null)

  // Register AFTER commit, never during render: the store write notifies this
  // component's own subscription, and a set-during-render would loop.
  useEffect(() => {
    setFormId(registerPayload(attrs))
  }, [attrs?.data, attrs?.id, attrs?.part])

  if (part.index !== 1) {
    return null
  }

  return jsx(AnchorCard, { expectedTotal: part.total, formId, streaming })
}

function AnchorCard({ expectedTotal, formId, streaming }) {
  const forms = useValue($forms)
  const decoded = formId ? decodeForm(forms[formId]) : null

  if (!decoded) {
    const form = formId ? forms[formId] : null
    const arrived = form ? Object.keys(form.chunks).length : 0
    const total = form?.total ?? expectedTotal
    const stalled = !streaming && form && arrived >= total

    return jsxs('div', {
      className: 'hq-card',
      children: [
        jsxs('div', {
          className: 'hq-assembling',
          children: [
            jsx(Codicon, { name: 'loading~spin', size: '0.75rem' }),
            jsx('span', {
              children:
                total > 1 && arrived < total
                  ? `Assembling questionnaire ${arrived}/${total}…`
                  : streaming
                    ? 'Assembling questionnaire…'
                    : 'This questionnaire payload could not be read.'
            })
          ]
        }),
        stalled &&
          jsx('span', {
            className: 'hq-meta',
            children: 'Re-send the directive, or paste it into the Questionnaires page.'
          })
      ]
    })
  }

  return jsx(QuestionnaireBody, { allowPopup: true, formId, spec: decoded })
}

// ---------------------------------------------------------------------------
// status bar chip
// ---------------------------------------------------------------------------

function OpenCountChip() {
  const forms = useValue($forms)
  const answers = useValue($answers)
  const sent = useValue($sent)

  const open = Object.keys(forms).filter(formId => {
    const spec = decodeForm(forms[formId])

    if (!spec || sent[formId]) {
      return false
    }

    return spec.questions.some(question => !isAnswered(question, (answers[formId] && answers[formId][question.id]) || EMPTY_ANSWER))
  }).length

  if (open === 0) {
    return null
  }

  return jsxs(Button, {
    onClick: () => host.navigate(PAGE_PATH),
    size: 'micro',
    variant: 'ghost',
    children: [
      jsx(Codicon, { name: 'checklist', size: '0.75rem' }),
      jsx('span', { children: `${open} open` })
    ]
  })
}

// ---------------------------------------------------------------------------
// page
// ---------------------------------------------------------------------------

function QuestionnairePage() {
  const forms = useValue($forms)
  const sent = useValue($sent)
  const answers = useValue($answers)
  const [selected, setSelected] = useState(null)
  const [pasted, setPasted] = useState('')

  const ids = Object.keys(forms)
  const activeId = selected && forms[selected] ? selected : (ids[0] ?? null)
  const activeSpec = activeId ? decodeForm(forms[activeId]) : null

  const loadPasted = () => {
    const text = pasted.trim()
    const match = /::questionnaire\{([^}]*)\}/.exec(text)

    if (!match) {
      host.notify({ kind: 'warning', message: 'No ::questionnaire{…} directive found in that text.' })

      return
    }

    const attrs = {}

    for (const pair of match[1].matchAll(/([a-z][\w-]{0,63})=(?:"([^"]*)"|'([^']*)')/gi)) {
      attrs[pair[1].toLowerCase()] = pair[2] ?? pair[3] ?? ''
    }

    const formId = registerPayload(attrs)

    if (formId) {
      setSelected(formId)
      setPasted('')
      host.notify({ kind: 'success', message: 'Questionnaire loaded.' })
    } else {
      host.notify({ kind: 'warning', message: 'That directive carried no data attribute.' })
    }
  }

  return jsxs('div', {
    className: 'hq-page',
    children: [
      jsxs('div', {
        className: 'hq-page-head',
        children: [
          jsx('div', { className: 'hq-page-title', children: 'Questionnaires' }),
          jsx('div', {
            className: 'hq-page-sub',
            children:
              'Every question round found in this window. Rounds arrive as ::questionnaire directives in a chat reply; answers are submitted back into the chat as a normal message.'
          })
        ]
      }),
      ids.length === 0
        ? jsx(EmptyState, {
            description: 'Ask in any chat and the reply’s ::questionnaire directive renders here too.',
            title: 'No questionnaires yet'
          })
        : jsxs('div', {
            className: 'hq-page-grid',
            children: [
              jsx('div', {
                className: 'hq-page-col',
                children: jsx(ScrollArea, {
                  children: jsx('div', {
                    className: 'hq-list',
                    children: ids.map(formId => {
                      const spec = decodeForm(forms[formId])
                      const progress = progressOf(formId, spec, answers)

                      return jsxs(
                        'button',
                        {
                          className: 'hq-row',
                          'data-active': formId === activeId ? 'true' : 'false',
                          onClick: () => setSelected(formId),
                          type: 'button',
                          children: [
                            jsx('span', {
                              className: 'hq-row-text',
                              children: spec ? spec.title : `(${forms[formId].total} parts)`
                            }),
                            sent[formId]
                              ? jsx(Badge, { size: 'xs', variant: 'success', children: 'sent' })
                              : jsx(Badge, {
                                  size: 'xs',
                                  variant: progress.unanswered.length === 0 ? 'success' : 'muted',
                                  children: `${progress.answered}/${progress.total}`
                                })
                          ]
                        },
                        formId
                      )
                    })
                  })
                })
              }),
              jsx('div', {
                className: 'hq-page-main',
                children: jsx('div', {
                  className: 'hq-panel',
                  children: activeSpec
                    ? jsx(QuestionnaireBody, { allowPopup: false, formId: activeId, spec: activeSpec })
                    : jsx(EmptyState, {
                        description: activeId
                          ? 'The directive is incomplete — some parts never arrived.'
                          : undefined,
                        title: activeId ? 'Questionnaire unavailable' : 'Nothing selected'
                      })
                })
              })
            ]
          }),
      jsxs('div', {
        className: 'hq-panel hq-paste',
        children: [
          jsx('div', { className: 'hq-page-title', children: 'Load a directive' }),
          jsx('div', {
            className: 'hq-page-sub',
            children:
              'Paste a ::questionnaire{…} line (for example one sent from another session or generated by scripts/questionnaire.py) to load it here.'
          }),
          jsx(Textarea, {
            onChange: event => setPasted(event.target.value),
            placeholder: '::questionnaire{id="demo-1" data="…"}',
            rows: 3,
            value: pasted
          }),
          jsx('div', {
            className: 'hq-foot',
            children: jsx(Button, {
              disabled: pasted.trim().length === 0,
              onClick: loadPasted,
              size: 'sm',
              variant: 'secondary',
              children: 'Load'
            })
          })
        ]
      })
    ]
  })
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

export default {
  id: PLUGIN_ID,
  name: 'Questionnaire',
  description: 'Native ::questionnaire{…} question cards, page and pop-out in the desktop app.',
  register(ctx) {
    pluginCtx = ctx
    loadPersisted()

    const removeStyles = injectStyles()
    ctx.onDispose(removeStyles)

    ctx.registerMany([
      {
        id: 'directive',
        area: TRANSCRIPT_DIRECTIVE_AREA,
        data: {
          name: DIRECTIVE_NAME,
          render: ({ attrs, streaming }) => jsx(QuestionnaireDirective, { attrs, streaming })
        }
      },
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: PAGE_PATH },
        render: () => jsx(QuestionnairePage, {})
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        data: { codicon: 'checklist', label: 'Questionnaires', path: PAGE_PATH }
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'questionnaire.open',
          keywords: ['questionnaire', 'form', 'questions', 'decisions'],
          label: 'Questionnaires: open the board',
          run: () => host.navigate(PAGE_PATH)
        }
      },
      {
        id: 'chip',
        area: STATUSBAR_AREAS.right,
        order: 125,
        render: () => jsx(OpenCountChip, {})
      }
    ])
  }
}
