import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runBuildCodexImage } from '../build-codex-image'

const bunMocks = vi.hoisted(() => {
  const execMock = vi.fn(async (_command: string) => ({ text: async () => '' }))
  const isTemplateStringsArray = (value: unknown): value is TemplateStringsArray =>
    Array.isArray(value) && Object.hasOwn(value, 'raw')

  const makeTagged =
    () =>
    (strings: TemplateStringsArray, ...exprs: unknown[]) => {
      const command = strings.reduce((acc, part, index) => acc + part + (exprs[index] ?? ''), '').trim()
      execMock(command)
      return { text: async () => '' }
    }

  const dollar = (...args: unknown[]) => {
    const first = args[0]
    if (isTemplateStringsArray(first)) {
      return makeTagged()(first, ...(args.slice(1) as unknown[]))
    }
    if (typeof first === 'object' && first !== null) {
      return makeTagged()
    }
    throw new Error('Invalid $ invocation')
  }

  return { execMock, dollar }
})

vi.mock('bun', () => ({
  $: bunMocks.dollar,
}))

const execMock = bunMocks.execMock

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

describe('runBuildCodexImage', () => {
  let workspace: string
  let dockerfile: string
  let authFile: string
  let configFile: string
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'codex-build-test-'))
    dockerfile = join(workspace, 'Dockerfile.codex')
    authFile = join(workspace, 'auth.json')
    configFile = join(workspace, 'config.toml')

    await writeFile(dockerfile, 'FROM scratch\n')
    await writeFile(authFile, '{}')
    await writeFile(configFile, 'token=1')

    process.env.DOCKERFILE = dockerfile
    process.env.IMAGE_TAG = 'registry.test/codex:latest'
    process.env.CONTEXT_DIR = resolve(workspace, '..')
    process.env.CODEX_AUTH = authFile
    process.env.CODEX_CONFIG = configFile
    process.env.GITHUB_TOKEN = 'token'

    execMock.mockClear()
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
    resetEnv()
  })

  it('builds and pushes the codex image', async () => {
    await runBuildCodexImage()

    expect(execMock).toHaveBeenCalledWith(expect.stringContaining('docker build -f'))
    expect(execMock).toHaveBeenCalledWith(expect.stringContaining('docker push registry.test/codex:latest'))
  })

  it('throws when the Dockerfile is missing', async () => {
    delete process.env.DOCKERFILE
    process.env.DOCKERFILE = join(workspace, 'missing.Dockerfile')
    await expect(runBuildCodexImage()).rejects.toThrow(/Dockerfile not found/)
  })
})
