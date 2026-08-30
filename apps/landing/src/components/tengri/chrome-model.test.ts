import { describe, expect, test } from 'bun:test'
import {
  activeChromeTab,
  chromeReducer,
  chromeTabLoadInstanceKey,
  currentChromePage,
  initialChromeState,
  MAX_CHROME_TABS,
  parseChromeAddress,
  parsePreviewBridgeMessage,
  PREVIEW_BRIDGE_CHANNEL,
  safePreviewLaunchUrl,
} from './chrome-model'

describe('Tengri Chrome tabs', () => {
  test('opens, activates, closes, and replaces tabs without losing a valid active tab', () => {
    let state = initialChromeState()
    state = chromeReducer(state, { type: 'new-tab' })
    expect(state.activeId).toBe('tab-2')
    state = chromeReducer(state, { type: 'activate', id: 'tab-1' })
    state = chromeReducer(state, { type: 'close', id: 'tab-1' })
    expect(state.activeId).toBe('tab-2')
    state = chromeReducer(state, { type: 'close', id: 'tab-2' })
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]?.id).toBe(state.activeId)
    expect(currentChromePage(state.tabs[0]!).kind).toBe('agent')
  })

  test('caps tabs and per-tab history while dropping forward history after navigation', () => {
    let state = initialChromeState()
    for (let index = 1; index < MAX_CHROME_TABS + 2; index++) state = chromeReducer(state, { type: 'new-tab' })
    expect(state.tabs).toHaveLength(MAX_CHROME_TABS)

    for (let port = 3000; port < 3032; port++) {
      state = chromeReducer(state, {
        type: 'navigate',
        page: { kind: 'preview', title: `localhost:${port}`, displayUrl: `http://localhost:${port}/`, port, path: '/' },
      })
    }
    expect(activeChromeTab(state).history).toHaveLength(30)
    state = chromeReducer(state, { type: 'history', offset: -1 })
    state = chromeReducer(state, {
      type: 'navigate',
      page: { kind: 'preview', title: 'replacement', displayUrl: 'http://localhost:4000/', port: 4000, path: '/' },
    })
    const active = activeChromeTab(state)
    expect(currentChromePage(active).title).toBe('replacement')
    expect(active.historyIndex).toBe(active.history.length - 1)
    expect(active.load.page).toMatchObject({ kind: 'preview', port: 4000 })
    expect(active.load.revision).toBeGreaterThan(30)
  })

  test('reloads only the active tab and clamps history navigation', () => {
    let state = initialChromeState()
    const initialInstance = chromeTabLoadInstanceKey(activeChromeTab(state))
    state = chromeReducer(state, { type: 'reload' })
    expect(activeChromeTab(state).load.revision).toBe(1)
    expect(chromeTabLoadInstanceKey(activeChromeTab(state))).not.toBe(initialInstance)
    const unchanged = chromeReducer(state, { type: 'history', offset: -1 })
    expect(unchanged).toBe(state)
  })

  test('synchronizes iframe navigation without reloading the live preview session', () => {
    let state = initialChromeState()
    state = chromeReducer(state, {
      type: 'navigate',
      page: { kind: 'preview', title: 'localhost:3000', displayUrl: 'http://localhost:3000/', port: 3000, path: '/' },
    })
    const liveLoad = activeChromeTab(state).load
    state = chromeReducer(state, {
      type: 'frame-navigate',
      id: state.activeId,
      mode: 'push',
      page: {
        kind: 'preview',
        title: 'localhost:3000',
        displayUrl: 'http://localhost:3000/dashboard',
        port: 3000,
        path: '/dashboard',
      },
    })
    expect(currentChromePage(activeChromeTab(state)).displayUrl).toBe('http://localhost:3000/dashboard')
    expect(activeChromeTab(state).load).toBe(liveLoad)

    state = chromeReducer(state, {
      type: 'frame-navigate',
      id: state.activeId,
      mode: 'load',
      page: { kind: 'preview', title: 'localhost:3000', displayUrl: 'http://localhost:3000/', port: 3000, path: '/' },
    })
    expect(activeChromeTab(state).historyIndex).toBe(1)
    expect(activeChromeTab(state).load).toBe(liveLoad)
  })
})

describe('Tengri Chrome addresses', () => {
  test('routes the agent home and safe loopback HTTP addresses internally', () => {
    expect(parseChromeAddress('')).toMatchObject({ kind: 'agent' })
    expect(parseChromeAddress('TENGRI://AGENT')).toMatchObject({ kind: 'agent' })
    expect(parseChromeAddress('localhost:3000/app?q=1')).toEqual({
      kind: 'preview',
      page: {
        kind: 'preview',
        title: 'localhost:3000',
        displayUrl: 'http://localhost:3000/app?q=1',
        port: 3000,
        path: '/app?q=1',
      },
    })
    expect(parseChromeAddress('http://[::1]:4321/')).toMatchObject({ kind: 'preview', page: { port: 4321 } })
  })

  test('routes ordinary HTTP sites to the real browser', () => {
    expect(parseChromeAddress('example.com/docs')).toEqual({ kind: 'external', url: 'https://example.com/docs' })
    expect(parseChromeAddress('http://example.com:3000/')).toEqual({
      kind: 'external',
      url: 'http://example.com:3000/',
    })
  })

  test('rejects reserved, privileged, credentialed, fragmented, and active-content addresses', () => {
    for (const address of [
      'localhost:80',
      'localhost:8080',
      'https://localhost:3000',
      'http://user:secret@localhost:3000',
      'http://localhost:3000/#secret',
      'javascript:alert(1)',
      'data:text/html,hello',
      'ftp://example.com/file',
      'ssh://host/path',
      'custom:payload',
      `https://example.com/${'x'.repeat(4096)}`,
      `http://localhost:3000/${'😀'.repeat(500)}`,
    ]) {
      expect(parseChromeAddress(address).kind).toBe('invalid')
    }
  })

  test('accepts only authenticated preview bridge messages from the expected session origin', () => {
    const sessionId = 'abc123abc123abc123abc123'
    const origin = `https://tengri-${sessionId}.proompteng.ai`
    expect(
      parsePreviewBridgeMessage(
        {
          channel: PREVIEW_BRIDGE_CHANNEL,
          sessionId,
          type: 'navigation',
          mode: 'push',
          url: `${origin}/workspace?q=1#editor`,
        },
        origin,
        origin,
        sessionId,
        3000,
      ),
    ).toEqual({
      kind: 'navigation',
      mode: 'push',
      page: {
        kind: 'preview',
        title: 'localhost:3000',
        displayUrl: 'http://localhost:3000/workspace?q=1#editor',
        port: 3000,
        path: '/workspace?q=1',
      },
    })
    expect(
      parsePreviewBridgeMessage(
        { channel: PREVIEW_BRIDGE_CHANNEL, sessionId, type: 'shortcut', key: 'w' },
        origin,
        origin,
        sessionId,
        3000,
      ),
    ).toEqual({ kind: 'shortcut', key: 'w' })
    expect(
      parsePreviewBridgeMessage(
        {
          channel: PREVIEW_BRIDGE_CHANNEL,
          sessionId,
          type: 'navigation',
          mode: 'load',
          url: 'https://attacker.example/',
        },
        'https://attacker.example',
        origin,
        sessionId,
        3000,
      ),
    ).toBeNull()
    expect(
      parsePreviewBridgeMessage(
        {
          channel: PREVIEW_BRIDGE_CHANNEL,
          sessionId,
          type: 'navigation',
          mode: 'load',
          url: `https://tengri-${sessionId}.attacker.example/`,
        },
        `https://tengri-${sessionId}.attacker.example`,
        origin,
        sessionId,
        3000,
      ),
    ).toBeNull()
  })

  test('never mistakes a loopback-looking external host for a microVM preview', () => {
    expect(parseChromeAddress('https://localhost.example.com:3000/')).toMatchObject({ kind: 'external' })
    expect(parseChromeAddress('https://127.0.0.1.example.com:3000/')).toMatchObject({ kind: 'external' })
  })

  test('accepts only fragment-ticketed HTTPS preview launch URLs', () => {
    const ticket = `${'a'.repeat(48)}.${'b'.repeat(43)}`
    const productionOrigin = 'https://tengri.example'
    expect(safePreviewLaunchUrl(`${productionOrigin}/v1/preview/open#${ticket}`, productionOrigin)).toBe(
      `${productionOrigin}/v1/preview/open#${ticket}`,
    )
    expect(safePreviewLaunchUrl(`http://localhost/v1/preview/open#${ticket}`, 'http://localhost')).toBe(
      `http://localhost/v1/preview/open#${ticket}`,
    )
    for (const value of [
      'javascript:alert(1)',
      `http://tengri.example/v1/preview/open#${ticket}`,
      'https://tengri.example/v1/preview/open',
      `https://user:secret@tengri.example/v1/preview/open#${ticket}`,
      `https://tengri.example/not-preview#${ticket}`,
      `https://tengri.example/v1/preview/open?redirect=1#${ticket}`,
      'https://tengri.example/v1/preview/open#too.short',
      `https://attacker.example/v1/preview/open#${ticket}`,
    ]) {
      expect(safePreviewLaunchUrl(value, productionOrigin)).toBe('')
    }
  })
})
