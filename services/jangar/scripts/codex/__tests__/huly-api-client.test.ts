import { afterEach, describe, expect, it, vi } from 'vitest'

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn<(path: string) => boolean>(() => false),
}))

vi.mock('node:fs', () => ({
  existsSync: fsMocks.existsSync,
}))

import { resolveHulyApiScriptPath } from '../lib/huly-api-client'

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

  it('prefers an explicit HULY_API_SCRIPT_PATH override', () => {
    process.env.HULY_API_SCRIPT_PATH = '/custom/tools/huly-api.py'

    expect(resolveHulyApiScriptPath()).toBe('/custom/tools/huly-api.py')
    expect(existsSyncMock).not.toHaveBeenCalled()
  })

  it('falls back to the bundled codex skill path when source-relative paths are unavailable', () => {
    existsSyncMock.mockImplementation((path) => path === '/root/.codex/skills/huly-api/scripts/huly-api.py')

    expect(resolveHulyApiScriptPath()).toBe('/root/.codex/skills/huly-api/scripts/huly-api.py')
    expect(existsSyncMock).toHaveBeenCalled()
  })
})
