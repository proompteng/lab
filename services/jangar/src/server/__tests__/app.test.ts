import { readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const crosswsMock = vi.hoisted(() => {
  let lastOptions: unknown
  const handleUpgrade = vi.fn(async () => null)
  const factory = vi.fn((options: unknown) => {
    lastOptions = options
    return {
      handleUpgrade,
      websocket: {},
    }
  })

  return {
    handleUpgrade,
    factory,
    getLastOptions: () => lastOptions,
    reset: () => {
      lastOptions = undefined
      handleUpgrade.mockClear()
      factory.mockClear()
    },
  }
})

vi.mock('../metrics', () => ({
  getPrometheusMetricsPath: () => '/metrics',
  isPrometheusMetricsEnabled: () => false,
  renderPrometheusMetrics: vi.fn(),
}))

vi.mock('crossws/adapters/bun', () => ({
  default: crosswsMock.factory,
}))

vi.mock('~/server/terminal-pty-manager', () => ({
  getTerminalPtyManager: vi.fn(() => ({
    getSession: vi.fn(() => null),
    startSession: vi.fn(),
  })),
  resetTerminalPtyManager: vi.fn(),
}))

import { createJangarRuntime, getClientOutputDirCandidates } from '../app'

const clientDir = fileURLToPath(new URL('../../../.output/public/', import.meta.url))
const indexPath = resolve(clientDir, 'index.html')
const traversalTargetPath = resolve(clientDir, '../public-review-secret.txt')
const clientIndexHtml = '<!doctype html><html><body>jangar client shell</body></html>'
const traversalSecret = 'top-secret-review-artifact'

const detectMimeType = (path: string) => {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8'
  if (path.endsWith('.js')) return 'application/javascript; charset=utf-8'
  if (path.endsWith('.css')) return 'text/css; charset=utf-8'
  return 'application/octet-stream'
}

const readIfExists = async (path: string) => {
  try {
    return await readFile(path)
  } catch {
    return null
  }
}

const withTempFile = async (path: string, contents: string) => {
  const original = await readIfExists(path)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)

  return async () => {
    if (original === null) {
      await rm(path, { force: true })
      return
    }

    await writeFile(path, original)
  }
}

describe('createJangarRuntime client serving', () => {
  let hadBun = false
  let originalBunFile: typeof Bun.file | undefined
  const bunFileStub = ((path: string) =>
    new Blob([readFileSync(path)], {
      type: detectMimeType(path),
    })) as typeof Bun.file

  beforeEach(() => {
    crosswsMock.reset()
    hadBun = 'Bun' in globalThis
    originalBunFile = hadBun ? Bun.file : undefined

    if (hadBun) {
      ;(Bun as unknown as { file: typeof Bun.file }).file = bunFileStub
      return
    }

    Object.defineProperty(globalThis, 'Bun', {
      configurable: true,
      writable: true,
      value: { file: bunFileStub } satisfies Partial<typeof Bun>,
    })
  })

  afterEach(() => {
    if (hadBun && originalBunFile) {
      ;(Bun as unknown as { file: typeof Bun.file }).file = originalBunFile
      return
    }

    delete (globalThis as Record<string, unknown>).Bun
  })

  it('finds the client output directory for bundled server chunks', () => {
    const candidates = getClientOutputDirCandidates({
      cwd: '/tmp/jangar-test-cwd',
      moduleUrl: 'file:///app/services/jangar/.output/server/chunks/app-123.mjs',
    })

    expect(candidates).toContain('/app/services/jangar/.output/public')
  })

  it('serves the client shell for SPA routes but not API namespaces', async () => {
    const restoreIndex = await withTempFile(indexPath, clientIndexHtml)

    try {
      const runtime = await createJangarRuntime({ serveClient: true })

      const clientRouteResponse = await runtime.handleRequest(new Request('http://localhost/dashboard'))
      expect(clientRouteResponse.status).toBe(200)
      expect(await clientRouteResponse.text()).toBe(clientIndexHtml)

      const apiResponse = await runtime.handleRequest(new Request('http://localhost/api/__missing__'))
      expect(apiResponse.status).toBe(404)
      expect(await apiResponse.text()).toBe('Not Found')
    } finally {
      await restoreIndex()
    }
  })

  it('does not serve sibling files outside the client output directory', async () => {
    const restoreIndex = await withTempFile(indexPath, clientIndexHtml)
    const restoreSecret = await withTempFile(traversalTargetPath, traversalSecret)

    try {
      const runtime = await createJangarRuntime({ serveClient: true })

      const response = await runtime.handleRequest(new Request('http://localhost/%2e%2e/public-review-secret.txt'))
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/html')

      const text = await response.text()
      expect(text).toBe(clientIndexHtml)
      expect(text).not.toContain(traversalSecret)
    } finally {
      await restoreSecret()
      await restoreIndex()
    }
  })

  it('does not serve the client shell unless the caller opts into it', async () => {
    const restoreIndex = await withTempFile(indexPath, clientIndexHtml)

    try {
      const runtime = await createJangarRuntime()
      const response = await runtime.handleRequest(new Request('http://localhost/dashboard'))

      expect(response.status).toBe(404)
    } finally {
      await restoreIndex()
    }
  })

  it('does not blindly upgrade websocket requests for non-websocket routes', async () => {
    const restoreIndex = await withTempFile(indexPath, clientIndexHtml)

    try {
      const runtime = await createJangarRuntime({ serveClient: true })
      const result = await runtime.handleUpgrade(
        new Request('http://localhost/dashboard', {
          headers: { upgrade: 'websocket' },
        }),
        {} as Bun.Server<unknown>,
      )

      expect(result.kind).toBe('response')
      if (result.kind !== 'response') throw new Error('Expected websocket upgrade to return a normal response')
      expect(result.response.status).toBe(200)
      expect(await result.response.text()).toBe(clientIndexHtml)
      expect(crosswsMock.handleUpgrade).not.toHaveBeenCalled()
    } finally {
      await restoreIndex()
    }
  })

  it('resolves route websocket hooks before upgrading terminal sessions', async () => {
    const runtime = await createJangarRuntime()
    const request = new Request('http://localhost/api/terminals/jangar-terminal-codex-test/ws?reconnect=test-token', {
      headers: { upgrade: 'websocket' },
    })

    const result = await runtime.handleUpgrade(request, {} as Bun.Server<unknown>)

    expect(result.kind).toBe('handled')
    expect(crosswsMock.handleUpgrade).toHaveBeenCalledOnce()

    const adapterOptions = crosswsMock.getLastOptions() as { resolve?: (request: Request) => unknown }
    expect(adapterOptions.resolve).toBeTypeOf('function')
    const hooks = adapterOptions.resolve ? await adapterOptions.resolve(request) : undefined

    expect(hooks).toMatchObject({
      close: expect.any(Function),
      error: expect.any(Function),
      message: expect.any(Function),
      open: expect.any(Function),
      upgrade: expect.any(Function),
    })
  })
})
