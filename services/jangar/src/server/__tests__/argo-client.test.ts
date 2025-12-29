import type { PathOrFileDescriptor } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}))

import { readFileSync } from 'node:fs'
import { buildArtifactDownloadUrl, createArgoClient, extractWorkflowArtifacts } from '~/server/argo-client'

const DEFAULT_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token'
const TOKEN_ENV_KEYS = ['ARGO_TOKEN', 'ARGO_SERVER_TOKEN', 'ARGO_TOKEN_FILE', 'ARGO_SERVER_TOKEN_FILE'] as const

type FetchFn = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => ReturnType<typeof fetch>

const setFetchMock = (body: Record<string, unknown> = {}) => {
  const fetchMock = vi.fn<FetchFn>(
    async () =>
      ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
      }) as Response,
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

const snapshotEnv = () =>
  TOKEN_ENV_KEYS.reduce<Record<string, string | undefined>>((acc, key) => {
    acc[key] = process.env[key]
    return acc
  }, {})

const restoreEnv = (snapshot: Record<string, string | undefined>) => {
  for (const key of TOKEN_ENV_KEYS) {
    const value = snapshot[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

let envSnapshot: Record<string, string | undefined>
const originalFetch = globalThis.fetch
const readFileSyncMock = vi.mocked(readFileSync)
type FetchMock = ReturnType<typeof setFetchMock>
type FetchCall = Parameters<FetchFn>

const getFetchInit = (fetchMock: FetchMock): FetchCall[1] | undefined => {
  const call = fetchMock.mock.calls[0] as FetchCall | undefined
  if (!call) {
    throw new Error('Expected fetch to be called')
  }
  return call[1]
}

beforeEach(() => {
  envSnapshot = snapshotEnv()
  readFileSyncMock.mockReset()
})

afterEach(() => {
  restoreEnv(envSnapshot)
  globalThis.fetch = originalFetch
  readFileSyncMock.mockReset()
})

describe('extractWorkflowArtifacts', () => {
  it('captures artifacts from outputs and nodes', () => {
    const workflow = {
      metadata: {
        name: 'github-codex-implementation-abc123',
        namespace: 'argo-workflows',
        uid: 'uid-123',
      },
      status: {
        outputs: {
          artifacts: [
            {
              name: 'implementation-changes',
              s3: { key: 'path/implementation-changes.tgz', bucket: 'argo-workflows' },
            },
          ],
        },
        nodes: {
          'node-1': {
            id: 'node-1',
            outputs: {
              artifacts: [
                {
                  name: 'implementation-changes',
                  s3: { key: 'path/implementation-changes.tgz', bucket: 'argo-workflows' },
                },
                {
                  name: 'implementation-log',
                  s3: { key: 'path/implementation-log.tgz', bucket: 'argo-workflows' },
                },
              ],
            },
          },
          'node-2': {
            id: 'node-2',
            outputs: {
              artifacts: [
                {
                  name: 'implementation-events',
                  http: { url: 'https://example.com/events.jsonl' },
                },
              ],
            },
          },
        },
      },
    }

    const { workflow: info, artifacts } = extractWorkflowArtifacts(workflow)

    expect(info.name).toBe('github-codex-implementation-abc123')
    expect(info.namespace).toBe('argo-workflows')

    const changesWithNode = artifacts.find(
      (artifact) => artifact.name === 'implementation-changes' && artifact.nodeId === 'node-1',
    )
    expect(changesWithNode?.key).toBe('path/implementation-changes.tgz')
    expect(changesWithNode?.bucket).toBe('argo-workflows')

    const eventArtifact = artifacts.find((artifact) => artifact.name === 'implementation-events')
    expect(eventArtifact?.url).toBe('https://example.com/events.jsonl')
  })
})

describe('buildArtifactDownloadUrl', () => {
  it('uses uid-based artifact downloads when available', () => {
    const url = buildArtifactDownloadUrl(
      'http://argo-workflows-server:2746/',
      { name: 'workflow', namespace: 'argo-workflows', uid: 'uid-999' },
      { name: 'implementation-log', nodeId: 'node-1' },
    )
    expect(url).toBe('http://argo-workflows-server:2746/artifacts-by-uid/uid-999/node-1/implementation-log')
  })

  it('falls back to namespace/name when uid is missing', () => {
    const url = buildArtifactDownloadUrl(
      'http://argo-workflows-server:2746',
      { name: 'workflow', namespace: 'argo-workflows', uid: null },
      { name: 'implementation-log', nodeId: 'node-1' },
    )
    expect(url).toBe('http://argo-workflows-server:2746/artifacts/argo-workflows/workflow/node-1/implementation-log')
  })
})

describe('createArgoClient auth headers', () => {
  it('adds Authorization header from ARGO_TOKEN', async () => {
    process.env.ARGO_TOKEN = 'token-123'
    const fetchMock = setFetchMock()
    const client = createArgoClient({ baseUrl: 'http://argo' })

    await client.getWorkflow('argo-workflows', 'workflow-1')

    const init = getFetchInit(fetchMock)
    expect(init?.headers).toEqual(
      expect.objectContaining({
        accept: 'application/json',
        authorization: 'Bearer token-123',
      }),
    )
    expect(readFileSyncMock).not.toHaveBeenCalled()
  })

  it('adds Authorization header from ARGO_TOKEN_FILE', async () => {
    process.env.ARGO_TOKEN_FILE = '/tmp/argo-token'
    readFileSyncMock.mockImplementation((path: PathOrFileDescriptor) => {
      if (typeof path === 'string' && path === '/tmp/argo-token') return 'file-token'
      throw new Error('missing token')
    })
    const fetchMock = setFetchMock()
    const client = createArgoClient({ baseUrl: 'http://argo' })

    await client.getWorkflow('argo-workflows', 'workflow-2')

    const init = getFetchInit(fetchMock)
    expect(init?.headers).toEqual(
      expect.objectContaining({
        accept: 'application/json',
        authorization: 'Bearer file-token',
      }),
    )
    expect(readFileSyncMock).toHaveBeenCalledWith('/tmp/argo-token', 'utf8')
  })

  it('falls back to the service-account token file', async () => {
    readFileSyncMock.mockImplementation((path: PathOrFileDescriptor) => {
      if (typeof path === 'string' && path === DEFAULT_TOKEN_PATH) return 'sa-token'
      throw new Error('missing token')
    })
    const fetchMock = setFetchMock()
    const client = createArgoClient({ baseUrl: 'http://argo' })

    await client.getWorkflow('argo-workflows', 'workflow-3')

    const init = getFetchInit(fetchMock)
    expect(init?.headers).toEqual(
      expect.objectContaining({
        accept: 'application/json',
        authorization: 'Bearer sa-token',
      }),
    )
    expect(readFileSyncMock).toHaveBeenCalledWith(DEFAULT_TOKEN_PATH, 'utf8')
  })
})
