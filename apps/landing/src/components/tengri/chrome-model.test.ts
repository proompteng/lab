import { describe, expect, test } from 'bun:test'
import {
  activeChromeTab,
  chromeReducer,
  currentChromePage,
  initialChromeState,
  MAX_CHROME_TABS,
  parseChromeAddress,
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
  })

  test('reloads only the active tab and clamps history navigation', () => {
    let state = initialChromeState()
    state = chromeReducer(state, { type: 'reload' })
    expect(activeChromeTab(state).reload).toBe(1)
    const unchanged = chromeReducer(state, { type: 'history', offset: -1 })
    expect(unchanged).toBe(state)
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
      `https://example.com/${'x'.repeat(4096)}`,
    ]) {
      expect(parseChromeAddress(address).kind).toBe('invalid')
    }
  })

  test('never mistakes a loopback-looking external host for a microVM preview', () => {
    expect(parseChromeAddress('https://localhost.example.com:3000/')).toMatchObject({ kind: 'external' })
    expect(parseChromeAddress('https://127.0.0.1.example.com:3000/')).toMatchObject({ kind: 'external' })
  })

  test('accepts only fragment-ticketed HTTPS preview launch URLs', () => {
    const ticket = `${'a'.repeat(48)}.${'b'.repeat(43)}`
    const productionOrigin = 'https://tengri.proompteng.ai'
    expect(safePreviewLaunchUrl(`${productionOrigin}/v1/preview/open#${ticket}`, productionOrigin)).toBe(
      `https://tengri.proompteng.ai/v1/preview/open#${ticket}`,
    )
    expect(safePreviewLaunchUrl(`http://localhost/v1/preview/open#${ticket}`, 'http://localhost')).toBe(
      `http://localhost/v1/preview/open#${ticket}`,
    )
    expect(
      safePreviewLaunchUrl(
        `https://isolated-tengri.example/v1/preview/open#${ticket}`,
        'https://isolated-tengri.example',
      ),
    ).toBe(`https://isolated-tengri.example/v1/preview/open#${ticket}`)
    for (const value of [
      'javascript:alert(1)',
      `https://attacker.example/v1/preview/open#${ticket}`,
      `http://tengri.proompteng.ai/v1/preview/open#${ticket}`,
      'https://tengri.proompteng.ai/v1/preview/open',
      `https://user:secret@tengri.proompteng.ai/v1/preview/open#${ticket}`,
      `https://tengri.proompteng.ai/not-preview#${ticket}`,
      `https://tengri.proompteng.ai/v1/preview/open?redirect=1#${ticket}`,
      'https://tengri.proompteng.ai/v1/preview/open#too.short',
    ]) {
      expect(safePreviewLaunchUrl(value, productionOrigin)).toBe('')
    }
    expect(
      safePreviewLaunchUrl(
        `http://isolated-tengri.example/v1/preview/open#${ticket}`,
        'http://isolated-tengri.example',
      ),
    ).toBe('')
  })
})
