import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  normalizeStringList,
  parseBooleanEnv,
  parseEnvArray,
  parseEnvList,
  parseEnvRecord,
  parseEnvStringList,
  parseJsonEnv,
  parseNumberEnv,
  parseOptionalNumber,
  parseStringList,
} from '~/server/agents-controller/env-config'

const TEST_ENV_KEY = 'JANGAR_AGENTS_CONTROLLER_ENV_CONFIG_TEST'

afterEach(() => {
  delete process.env[TEST_ENV_KEY]
  vi.restoreAllMocks()
})

describe('agents controller env-config module', () => {
  it('parses booleans and falls back on unknown values', () => {
    expect(parseBooleanEnv(undefined, true)).toBe(true)
    expect(parseBooleanEnv('yes', false)).toBe(true)
    expect(parseBooleanEnv('No', true)).toBe(false)
    expect(parseBooleanEnv('maybe', false)).toBe(false)
  })

  it('parses bounded integer env values with fallback', () => {
    expect(parseNumberEnv(undefined, 10, 1)).toBe(10)
    expect(parseNumberEnv('42', 10, 1)).toBe(42)
    expect(parseNumberEnv('0', 10, 1)).toBe(10)
    expect(parseNumberEnv('invalid', 10, 1)).toBe(10)
  })

  it('parses optional numeric values from numbers and strings', () => {
    expect(parseOptionalNumber(3.5)).toBe(3.5)
    expect(parseOptionalNumber(' 7.25 ')).toBe(7.25)
    expect(parseOptionalNumber('')).toBeUndefined()
    expect(parseOptionalNumber('NaN')).toBeUndefined()
  })

  it('parses JSON env values and warns when invalid', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    process.env[TEST_ENV_KEY] = '{"ok":true}'
    expect(parseJsonEnv(TEST_ENV_KEY)).toEqual({ ok: true })

    process.env[TEST_ENV_KEY] = 'not-json'
    expect(parseJsonEnv(TEST_ENV_KEY)).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`invalid ${TEST_ENV_KEY} JSON`))
  })

  it('parses env objects and arrays with null fallbacks', () => {
    process.env[TEST_ENV_KEY] = '{"a":1}'
    expect(parseEnvRecord(TEST_ENV_KEY)).toEqual({ a: 1 })
    expect(parseEnvArray(TEST_ENV_KEY)).toBeNull()

    process.env[TEST_ENV_KEY] = '[1,2]'
    expect(parseEnvArray(TEST_ENV_KEY)).toEqual([1, 2])
    expect(parseEnvRecord(TEST_ENV_KEY)).toBeNull()
  })

  it('parses and normalizes list values from arrays or csv envs', () => {
    expect(parseStringList([' a ', 1, '', 'b'])).toEqual(['a', 'b'])
    expect(parseStringList('not-array')).toEqual([])
    expect(normalizeStringList([' x ', 1, '', ' y'])).toEqual(['x', 'y'])

    process.env[TEST_ENV_KEY] = 'a, b, , c'
    expect(parseEnvList(TEST_ENV_KEY)).toEqual(['a', 'b', 'c'])

    process.env[TEST_ENV_KEY] = '[" d ", "", 1, "e"]'
    expect(parseEnvStringList(TEST_ENV_KEY)).toEqual(['d', 'e'])
  })

  it('falls back to csv parsing for non-array env values', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env[TEST_ENV_KEY] = 'one, two'

    expect(parseEnvStringList(TEST_ENV_KEY)).toEqual(['one', 'two'])
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`invalid ${TEST_ENV_KEY} JSON`))
  })
})
