import process from 'node:process'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isMainModule, runCli } from '../cli'

describe('isMainModule', () => {
  it('honours the meta.main boolean when provided', () => {
    expect(isMainModule({ main: true } as ImportMeta)).toBe(true)
    expect(isMainModule({ main: false } as ImportMeta)).toBe(false)
  })

  it('compares module url with process argv when meta.main is undefined', () => {
    const originalArgv = [...process.argv]
    process.argv[1] = '/tmp/entry.js'
    const meta = { url: 'file:///tmp/entry.js' } as ImportMeta
    expect(isMainModule(meta)).toBe(true)
    process.argv = originalArgv
  })
})

describe('runCli', () => {
  const originalArgv = [...process.argv]
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit called')
  })
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

  beforeEach(() => {
    process.argv[1] = '/tmp/entry.js'
  })

  afterEach(() => {
    process.argv = [...originalArgv]
    vi.clearAllMocks()
  })

  afterAll(() => {
    exitSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('does nothing when invoked for a non-main module', async () => {
    const fn = vi.fn(async () => undefined)
    await runCli({ main: false } as ImportMeta, fn)
    expect(fn).not.toHaveBeenCalled()
  })

  it('exits with the code returned by the handler', async () => {
    const fn = vi.fn(async () => 5)
    await expect(runCli({ url: 'file:///tmp/entry.js' } as ImportMeta, fn)).rejects.toThrow('process.exit called')
    expect(fn).toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(5)
  })

  it('prints the error and exits with code 1 when the handler throws', async () => {
    const fn = vi.fn(async () => {
      throw new Error('boom')
    })
    await expect(runCli({ url: 'file:///tmp/entry.js' } as ImportMeta, fn)).rejects.toThrow('process.exit called')
    expect(errorSpy).toHaveBeenCalledWith('boom')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
