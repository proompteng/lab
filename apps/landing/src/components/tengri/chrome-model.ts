export const MAX_CHROME_TABS = 8
const MAX_CHROME_HISTORY = 30
const MAX_PREVIEW_PATH_BYTES = 4096
export const PREVIEW_BRIDGE_CHANNEL = 'tengri-preview-v1'

export type ChromePreviewShortcut = 'l' | 'r' | 't' | 'w'
export type ChromePreviewNavigationMode = 'load' | 'push' | 'replace'

export type ChromePage =
  | { kind: 'agent'; title: string; displayUrl: 'tengri://agent' }
  | { kind: 'preview'; title: string; displayUrl: string; port: number; path: string }

export type ChromeLoadRequest = { page: ChromePage; revision: number }

export type ChromeTab = {
  id: string
  history: ChromePage[]
  historyIndex: number
  load: ChromeLoadRequest
}

export type ChromeState = {
  activeId: string
  nextTabNumber: number
  tabs: ChromeTab[]
}

export type ParsedChromeAddress =
  | { kind: 'agent'; page: ChromePage }
  | { kind: 'external'; url: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'preview'; page: ChromePage }

export type ChromeAction =
  | { type: 'activate'; id: string }
  | { type: 'close'; id: string }
  | { type: 'frame-navigate'; id: string; mode: ChromePreviewNavigationMode; page: ChromePage }
  | { type: 'history'; offset: -1 | 1 }
  | { type: 'navigate'; page: ChromePage }
  | { type: 'new-tab' }
  | { type: 'reload' }

export const CHROME_AGENT_PAGE: ChromePage = {
  kind: 'agent',
  title: 'Tengri Agent',
  displayUrl: 'tengri://agent',
}

export function initialChromeState(): ChromeState {
  return {
    activeId: 'tab-1',
    nextTabNumber: 2,
    tabs: [newTab('tab-1')],
  }
}

export function chromeReducer(state: ChromeState, action: ChromeAction): ChromeState {
  if (action.type === 'activate') {
    return state.tabs.some((tab) => tab.id === action.id) ? { ...state, activeId: action.id } : state
  }
  if (action.type === 'new-tab') {
    if (state.tabs.length >= MAX_CHROME_TABS) return state
    const id = `tab-${state.nextTabNumber}`
    return {
      activeId: id,
      nextTabNumber: state.nextTabNumber + 1,
      tabs: [...state.tabs, newTab(id)],
    }
  }
  if (action.type === 'close') return closeTab(state, action.id)
  if (action.type === 'frame-navigate') {
    let changed = false
    const tabs = state.tabs.map((tab) => {
      if (tab.id !== action.id) return tab
      const next = synchronizeFrameNavigation(tab, action.page, action.mode)
      changed ||= next !== tab
      return next
    })
    return changed ? { ...state, tabs } : state
  }

  let changed = false
  const tabs = state.tabs.map((tab) => {
    if (tab.id !== state.activeId) return tab
    if (action.type === 'navigate') {
      const history = [...tab.history.slice(0, tab.historyIndex + 1), action.page].slice(-MAX_CHROME_HISTORY)
      changed = true
      return {
        ...tab,
        history,
        historyIndex: history.length - 1,
        load: nextLoad(tab, action.page),
      }
    }
    if (action.type === 'history') {
      const historyIndex = clamp(tab.historyIndex + action.offset, 0, tab.history.length - 1)
      if (historyIndex === tab.historyIndex) return tab
      changed = true
      return { ...tab, historyIndex, load: nextLoad(tab, tab.history[historyIndex] || CHROME_AGENT_PAGE) }
    }
    if (action.type === 'reload') {
      changed = true
      return { ...tab, load: nextLoad(tab, currentChromePage(tab)) }
    }
    return tab
  })
  return changed ? { ...state, tabs } : state
}

export function activeChromeTab(state: ChromeState) {
  return state.tabs.find((tab) => tab.id === state.activeId) || state.tabs[0]!
}

export function currentChromePage(tab: ChromeTab) {
  return tab.history[tab.historyIndex] || CHROME_AGENT_PAGE
}

export function parseChromeAddress(raw: string): ParsedChromeAddress {
  const value = raw.trim()
  if (!value || value.toLowerCase() === 'tengri://agent') return { kind: 'agent', page: CHROME_AGENT_PAGE }
  if (value.length > 4096 || hasControlCharacters(value)) {
    return { kind: 'invalid', message: 'The address is invalid.' }
  }
  if (/^(?:about|blob|data|file|javascript|mailto|tel):/i.test(value)) {
    return { kind: 'invalid', message: 'Only HTTP and HTTPS addresses can be opened.' }
  }
  const localShorthand = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?]|$)/i.test(value)
  if (!localShorthand && /^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) {
    return { kind: 'invalid', message: 'Only HTTP and HTTPS addresses can be opened.' }
  }

  const candidate = /^https?:\/\//i.test(value) ? value : `${localShorthand ? 'http' : 'https'}://${value}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return { kind: 'invalid', message: 'The address is invalid.' }
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    return { kind: 'invalid', message: 'Only credential-free HTTP and HTTPS addresses can be opened.' }
  }

  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())
  if (!loopback) return { kind: 'external', url: url.toString() }
  if (url.protocol !== 'http:') {
    return { kind: 'invalid', message: 'MicroVM previews currently use HTTP localhost addresses.' }
  }
  if (url.hash) {
    return { kind: 'invalid', message: 'Remove the URL fragment before opening a microVM preview.' }
  }
  const port = Number(url.port || 80)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return { kind: 'invalid', message: 'MicroVM preview ports must be between 1024 and 65535.' }
  }
  if (port === 8080) {
    return { kind: 'invalid', message: 'Port 8080 is reserved for Nanoagent.' }
  }
  const path = `${url.pathname}${url.search}`
  if (utf8ByteLength(path) > MAX_PREVIEW_PATH_BYTES) {
    return { kind: 'invalid', message: 'MicroVM preview paths must not exceed 4096 bytes.' }
  }
  return {
    kind: 'preview',
    page: {
      kind: 'preview',
      title: `localhost:${port}`,
      displayUrl: url.toString(),
      port,
      path,
    },
  }
}

export function parsePreviewBridgeMessage(
  value: unknown,
  eventOrigin: string,
  expectedOrigin: string,
  sessionId: string,
  port: number,
):
  | { kind: 'navigation'; mode: ChromePreviewNavigationMode; page: Extract<ChromePage, { kind: 'preview' }> }
  | { kind: 'shortcut'; key: ChromePreviewShortcut }
  | null {
  if (!value || typeof value !== 'object') return null
  if (eventOrigin !== expectedOrigin) return null
  const message = value as Record<string, unknown>
  if (message.channel !== PREVIEW_BRIDGE_CHANNEL || message.sessionId !== sessionId) return null
  if (message.type === 'shortcut') {
    return ['l', 'r', 't', 'w'].includes(String(message.key))
      ? { kind: 'shortcut', key: message.key as ChromePreviewShortcut }
      : null
  }
  if (message.type !== 'navigation' || !['load', 'push', 'replace'].includes(String(message.mode))) return null
  if (typeof message.url !== 'string') return null
  try {
    const url = new URL(message.url)
    const expectedLabel = `tengri-${sessionId}.`
    const localHttp = url.protocol === 'http:' && url.hostname.endsWith('.localhost')
    if (
      url.origin !== expectedOrigin ||
      (!localHttp && url.protocol !== 'https:') ||
      !url.hostname.startsWith(expectedLabel) ||
      url.username ||
      url.password
    ) {
      return null
    }
    const path = `${url.pathname}${url.search}`
    if (utf8ByteLength(path) > MAX_PREVIEW_PATH_BYTES || hasControlCharacters(path)) return null
    const displayUrl = `http://localhost:${port}${path}${url.hash}`
    return {
      kind: 'navigation',
      mode: message.mode as ChromePreviewNavigationMode,
      page: { kind: 'preview', title: `localhost:${port}`, displayUrl, port, path },
    }
  } catch {
    return null
  }
}

export function safePreviewLaunchUrl(value: string) {
  try {
    const url = new URL(value)
    const localHttp =
      url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())
    if (
      (url.protocol !== 'https:' && !localHttp) ||
      url.username ||
      url.password ||
      url.pathname !== '/v1/preview/open' ||
      !url.hash.slice(1)
    ) {
      return ''
    }
    return url.toString()
  } catch {
    return ''
  }
}

function closeTab(state: ChromeState, id: string): ChromeState {
  const index = state.tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return state
  const tabs = state.tabs.filter((tab) => tab.id !== id)
  if (tabs.length === 0) {
    const replacementId = `tab-${state.nextTabNumber}`
    return {
      activeId: replacementId,
      nextTabNumber: state.nextTabNumber + 1,
      tabs: [newTab(replacementId)],
    }
  }
  if (id !== state.activeId) return { ...state, tabs }
  return {
    ...state,
    activeId: tabs[Math.min(index, tabs.length - 1)]!.id,
    tabs,
  }
}

function newTab(id: string): ChromeTab {
  return {
    id,
    history: [CHROME_AGENT_PAGE],
    historyIndex: 0,
    load: { page: CHROME_AGENT_PAGE, revision: 0 },
  }
}

function nextLoad(tab: ChromeTab, page: ChromePage) {
  return { page, revision: tab.load.revision + 1 }
}

function synchronizeFrameNavigation(tab: ChromeTab, page: ChromePage, mode: ChromePreviewNavigationMode): ChromeTab {
  const current = currentChromePage(tab)
  if (mode === 'replace' || current.displayUrl === page.displayUrl) {
    if (current.displayUrl === page.displayUrl && current.title === page.title) return tab
    const history = tab.history.map((entry, index) => (index === tab.historyIndex ? page : entry))
    return { ...tab, history }
  }
  if (mode === 'load') {
    if (tab.history[tab.historyIndex - 1]?.displayUrl === page.displayUrl) {
      return { ...tab, historyIndex: tab.historyIndex - 1 }
    }
    if (tab.history[tab.historyIndex + 1]?.displayUrl === page.displayUrl) {
      return { ...tab, historyIndex: tab.historyIndex + 1 }
    }
  }
  const history = [...tab.history.slice(0, tab.historyIndex + 1), page].slice(-MAX_CHROME_HISTORY)
  return { ...tab, history, historyIndex: history.length - 1 }
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value))
}

function hasControlCharacters(value: string) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 31 || codePoint === 127
  })
}

function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength
}
