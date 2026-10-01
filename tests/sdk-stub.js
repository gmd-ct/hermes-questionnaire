/**
 * Offline stand-in for `@hermes/plugin-sdk`, used ONLY by tests/run.mjs.
 *
 * The real SDK is injected by the Electron renderer. This shim reproduces the
 * parts `plugin.js` actually touches — nanostore atoms, `useValue`, the host
 * verbs, and the UI kit (as plain DOM elements so a test can click them) — so
 * the plugin's logic can be exercised without the app. It is never shipped to
 * the desktop app: the app loads plugin.js from its own copy of the folder and
 * ignores this file.
 */

import { createElement, useSyncExternalStore } from 'react'

export const calls = {
  navigate: [],
  notify: [],
  submitted: [],
  clipboard: [],
  submitResult: true
}

export function __reset() {
  calls.navigate.length = 0
  calls.notify.length = 0
  calls.submitted.length = 0
  calls.clipboard.length = 0
  calls.submitResult = true
}

export function atom(initial) {
  let value = initial
  const listeners = new Set()

  return {
    get: () => value,
    listen: listener => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },
    set: next => {
      value = typeof next === 'function' ? next(value) : next
      listeners.forEach(listener => listener(value))
    },
    subscribe: listener => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    }
  }
}

export function computed(atoms, derive) {
  const store = atom(derive(...atoms.map(entry => entry.get())))
  const sync = () => store.set(derive(...atoms.map(entry => entry.get())))

  atoms.forEach(entry => entry.subscribe(sync))

  return store
}

export const useValue = store => useSyncExternalStore(store.subscribe, store.get, store.get)

export const host = {
  state: {
    activeSessionId: atom('runtime-session-1'),
    focusedSessionId: atom('runtime-session-1'),
    busy: atom(false),
    gateway: atom('open'),
    profile: atom('default')
  },
  composer: {
    submit: (sessionId, text) => {
      calls.submitted.push({ sessionId, text })

      return calls.submitResult
    }
  },
  navigate: path => calls.navigate.push(path),
  notify: input => calls.notify.push(input),
  notifyError: (error, fallback) => calls.notify.push({ error, message: fallback })
}

export const haptic = () => {}

export const TRANSCRIPT_DIRECTIVE_AREA = 'transcript.directives'
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar.nav'
export const PALETTE_AREA = 'commandPalette'
export const STATUSBAR_AREAS = { left: 'statusBar.left', right: 'statusBar.right' }
export const PANES_AREA = 'panes'

export const Button = ({ children, ...props }) => createElement('button', props, children)
export const Badge = ({ children, ...props }) => createElement('span', { 'data-slot': 'badge', ...props }, children)
export const Codicon = ({ name, ...props }) => createElement('span', { 'data-codicon': name, ...props })
export const Input = props => createElement('input', props)
export const Textarea = props => createElement('textarea', props)
export const Separator = () => createElement('hr')
export const ScrollArea = ({ children, ...props }) => createElement('div', props, children)

export const Checkbox = ({ checked, onCheckedChange, ...props }) =>
  createElement('input', {
    checked: Boolean(checked),
    onChange: () => onCheckedChange?.(!checked),
    type: 'checkbox',
    ...props
  })

export const CopyButton = ({ text }) =>
  createElement('button', {
    'data-copy': typeof text === 'function' ? 'lazy' : String(text ?? ''),
    type: 'button'
  })

export const EmptyState = ({ title, description }) =>
  createElement('div', { 'data-slot': 'empty' }, createElement('div', null, title), description ?? null)

export const Dialog = ({ children, open }) => (open ? createElement('div', { 'data-slot': 'dialog' }, children) : null)
export const DialogContent = ({ children }) => createElement('div', { 'data-slot': 'dialog-content' }, children)
export const DialogHeader = ({ children }) => createElement('div', null, children)
export const DialogTitle = ({ children }) => createElement('h2', null, children)
export const DialogDescription = ({ children }) => createElement('p', null, children)
