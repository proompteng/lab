import { afterEach, describe, expect, it, vi } from 'vitest'

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn<(path: string) => boolean>(() => false),
}))

vi.mock('node:fs', () => ({
  existsSync: fsMocks.existsSync,
}))

import {
  isRuntimeMissingComponentError,
  resolveHulyApiScriptPath,
  RuntimeMissingComponentError,
} from '../lib/huly-api-client'

const existsSyncMock = fsMocks.existsSync
const ORIGINAL_ENV = { ...process.env }

const resetEnv = () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key]
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value
  }
}

describe('resolveHulyApiScriptPath', () => {
  afterEach(() => {
    resetEnv()
    existsSyncMock.mockReset()
    existsSyncMock.mockReturnValue(false)
  })

  it('prefers an explicit HULY_API_SCRIPT_PATH override when the configured path exists', () => {
    process.env.HULY_API_SCRIPT_PATH = '/custom/tools/huly-api.py'
    existsSyncMock.mockImplementation((path) => path === '/custom/tools/huly-api.py')

    expect(resolveHulyApiScriptPath()).toBe('/custom/tools/huly-api.py')
    expect(existsSyncMock).toHaveBeenCalledWith('/custom/tools/huly-api.py')
  })

  it('throws a typed error when an explicit HULY_API_SCRIPT_PATH override is missing', () => {
    process.env.HULY_API_SCRIPT_PATH = '/custom/tools/huly-api.py'

    try {
      resolveHulyApiScriptPath()
      throw new Error('expected missing helper error')
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeMissingComponentError)
      expect(isRuntimeMissingComponentError(error)).toBe(true)
      expect((error as RuntimeMissingComponentError).componentKind).toBe('python_helper')
      expect((error as RuntimeMissingComponentError).reasonCode).toBe('runtime_kit_component_missing')
      expect((error as RuntimeMissingComponentError).checkedPaths).toEqual(['/custom/tools/huly-api.py'])
    }
  })

  it('prefers the source-relative helper path when it is available', () => {
    existsSyncMock.mockImplementation((path) => path.endsWith('/skills/huly-api/scripts/huly-api.py'))

    expect(resolveHulyApiScriptPath()).toMatch(/skills\/huly-api\/scripts\/huly-api\.py$/)
  })

  it('falls back to the bundled codex skill path when source-relative paths are unavailable', () => {
    existsSyncMock.mockImplementation((path) => path === '/root/.codex/skills/huly-api/scripts/huly-api.py')

    expect(resolveHulyApiScriptPath()).toBe('/root/.codex/skills/huly-api/scripts/huly-api.py')
    expect(existsSyncMock).toHaveBeenCalled()
  })

  it('throws a typed error when no helper path exists in the runtime', () => {
    try {
      resolveHulyApiScriptPath()
      throw new Error('expected missing helper error')
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeMissingComponentError)
      expect((error as RuntimeMissingComponentError).checkedPaths).toEqual(
        expect.arrayContaining([
          expect.stringContaining('/skills/huly-api/scripts/huly-api.py'),
          '/app/skills/huly-api/scripts/huly-api.py',
        ]),
      )
    }
  })
})
