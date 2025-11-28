import { describe, expect, it, mock } from 'bun:test'

mock.module('@proompteng/codex', () => {
  class FakeCodexClient {
    ensureReady = () => Promise.resolve()
    runTurn = async () => ({ text: 'ok', threadId: 'thread-1' })
    runTurnStream = async () => ({
      stream: (async function* () {
        yield 'delta'
      })(),
      threadId: 'thread-1',
      turnId: 'turn-1',
    })
    stop = () => {}
  }

  return { CodexAppServerClient: FakeCodexClient }
})

const loadAppServer = async () => {
  process.env.CODEX_BOOTSTRAP_REPO = '0'
  process.env.CODEX_CWD = '/tmp/repo'
  return import('./app-server')
}

const TEST_TIMEOUT_MS = 20_000

describe('app-server client wiring', () => {
  it(
    'returns a singleton app server handle',
    async () => {
      const { getAppServer } = await loadAppServer()

      const first = getAppServer('codex', '/tmp/repo')
      const second = getAppServer('codex', '/tmp/repo')

      expect(first).toBe(second)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'stopAppServer delegates to the handle stop method',
    async () => {
      const { getAppServer, stopAppServer } = await loadAppServer()

      const handle = getAppServer('codex', '/tmp/repo')
      let stopped = false
      // eslint-disable-next-line no-param-reassign
      handle.stop = () => {
        stopped = true
      }

      await stopAppServer(handle)

      expect(stopped).toBe(true)
    },
    TEST_TIMEOUT_MS,
  )
})
