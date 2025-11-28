import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'

import { buildCodexEnv } from './env'

describe('buildCodexEnv', () => {
  it('prefers base env values over process env', () => {
    const key = 'JANGAR_ENV_PREFERS_BASE'
    const original = process.env[key]
    process.env[key] = 'system'

    const env = buildCodexEnv({ baseEnv: { [key]: 'override' } })

    expect(env[key]).toBe('override')
    expect(process.env[key]).toBe('system')

    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  })

  it('prefixes PATH with the provided toolbelt directory', () => {
    const env = buildCodexEnv({ baseEnv: { PATH: '/usr/bin' }, toolbeltBinDir: '/tmp/toolbelt' })

    expect(env.PATH).toBe('/tmp/toolbelt:/usr/bin')
  })

  it('sets codex-specific helpers when depth and workdir are provided', () => {
    const env = buildCodexEnv({ depth: 3, workdir: '/tmp/project' })

    expect(env.CX_DEPTH).toBe('3')
    expect(env.CODEX_HOME).toBe(resolve('/tmp/project', '.codex'))
  })
})
