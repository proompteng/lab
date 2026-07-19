import { describe, expect, test } from 'bun:test'
import { ConfigProvider, Effect, Exit } from 'effect'

import { loadConfig } from './config'

const loadFrom = (entries: ReadonlyArray<readonly [string, string]>) =>
  Effect.runPromise(loadConfig.pipe(Effect.withConfigProvider(ConfigProvider.fromMap(new Map(entries)))))

describe('Bayn configuration', () => {
  test('loads production-safe defaults without credentials', async () => {
    const config = await loadFrom([])

    expect(config).toEqual({ hostname: '0.0.0.0', port: 8080 })
  })

  test('loads explicit host and port values', async () => {
    const config = await loadFrom([
      ['BAYN_HOST', '127.0.0.1'],
      ['BAYN_PORT', '9090'],
    ])

    expect(config).toEqual({ hostname: '127.0.0.1', port: 9090 })
  })

  test('returns a typed failure for invalid configuration', async () => {
    const exit = await Effect.runPromiseExit(
      loadConfig.pipe(
        Effect.withConfigProvider(
          ConfigProvider.fromMap(
            new Map([
              ['BAYN_HOST', '   '],
              ['BAYN_PORT', 'not-a-port'],
            ]),
          ),
        ),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(exit.cause._tag).toBe('Fail')
      if (exit.cause._tag === 'Fail') {
        expect(exit.cause.error._tag).toBe('ConfigurationError')
      }
    }
  })
})
