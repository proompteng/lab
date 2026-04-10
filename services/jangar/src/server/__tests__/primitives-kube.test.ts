import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const objectApiMock = vi.hoisted(() => ({
  create: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  patch: vi.fn(),
  read: vi.fn(),
  replace: vi.fn(),
}))

const customObjectsMock = vi.hoisted(() => ({
  getNamespacedCustomObject: vi.fn(),
  listNamespacedCustomObject: vi.fn(),
  patchNamespacedCustomObject: vi.fn(),
  patchNamespacedCustomObjectStatus: vi.fn(),
}))

const coreApiMock = vi.hoisted(() => ({
  readNamespacedPodLog: vi.fn(),
}))

const objectApiFactoryMock = vi.hoisted(() => vi.fn(() => objectApiMock))
const loadAllYamlMock = vi.hoisted(() => vi.fn(() => []))
const makeApiClientMock = vi.hoisted(() =>
  vi.fn((api: { name?: string }) => {
    if (api?.name === 'CustomObjectsApi') return customObjectsMock
    if (api?.name === 'CoreV1Api') return coreApiMock
    throw new Error(`unexpected api client: ${api?.name ?? 'unknown'}`)
  }),
)

vi.mock('@kubernetes/client-node', () => ({
  CoreV1Api: class CoreV1Api {},
  CustomObjectsApi: class CustomObjectsApi {},
  KubeConfig: class KubeConfig {
    loadFromDefault() {}

    makeApiClient(api: { name?: string }) {
      return makeApiClientMock(api)
    }
  },
  KubernetesObjectApi: {
    makeApiClient: objectApiFactoryMock,
  },
  PatchStrategy: {
    MergePatch: 'application/merge-patch+json',
  },
  loadAllYaml: loadAllYamlMock,
}))

import { __private as transportPrivate } from '~/server/kubernetes-bun-transport'
import { createKubernetesClient, RESOURCE_MAP } from '~/server/primitives-kube'

describe('primitives-kube', () => {
  beforeEach(() => {
    delete (globalThis as typeof globalThis & { __jangarNativeKubeClients?: unknown }).__jangarNativeKubeClients
    delete (globalThis as typeof globalThis & { __jangarNativeKubeTlsCache?: unknown }).__jangarNativeKubeTlsCache
    objectApiFactoryMock.mockClear()
    makeApiClientMock.mockClear()
    loadAllYamlMock.mockClear()

    for (const mock of [
      objectApiMock.create,
      objectApiMock.delete,
      objectApiMock.list,
      objectApiMock.patch,
      objectApiMock.read,
      objectApiMock.replace,
      customObjectsMock.getNamespacedCustomObject,
      customObjectsMock.listNamespacedCustomObject,
      customObjectsMock.patchNamespacedCustomObject,
      customObjectsMock.patchNamespacedCustomObjectStatus,
      coreApiMock.readNamespacedPodLog,
    ]) {
      mock.mockReset()
    }
  })

  it('uses CustomObjectsApi for custom resource reads', async () => {
    customObjectsMock.getNamespacedCustomObject.mockResolvedValue({ metadata: { name: 'run-1' } })

    const kube = createKubernetesClient()
    const result = await kube.get(RESOURCE_MAP.AgentRun, 'run-1', 'agents')

    expect(result).toEqual({ metadata: { name: 'run-1' } })
    expect(customObjectsMock.getNamespacedCustomObject).toHaveBeenCalledWith({
      group: 'agents.proompteng.ai',
      version: 'v1alpha1',
      namespace: 'agents',
      plural: 'agentruns',
      name: 'run-1',
    })
    expect(objectApiMock.read).not.toHaveBeenCalled()
  })

  it('uses CustomObjectsApi for custom resource lists', async () => {
    customObjectsMock.listNamespacedCustomObject.mockResolvedValue({ items: [] })

    const kube = createKubernetesClient()
    const result = await kube.list(RESOURCE_MAP.AgentRun, 'agents', 'agents.proompteng.ai/agent-run=run-1')

    expect(result).toEqual({ items: [] })
    expect(customObjectsMock.listNamespacedCustomObject).toHaveBeenCalledWith({
      group: 'agents.proompteng.ai',
      version: 'v1alpha1',
      namespace: 'agents',
      plural: 'agentruns',
      labelSelector: 'agents.proompteng.ai/agent-run=run-1',
    })
    expect(objectApiMock.list).not.toHaveBeenCalled()
  })

  it('preserves name and namespace when patching custom resources', async () => {
    customObjectsMock.patchNamespacedCustomObject.mockResolvedValue({ metadata: { name: 'run-1' } })

    const kube = createKubernetesClient()
    await kube.patch(RESOURCE_MAP.AgentRun, 'run-1', 'agents', {
      metadata: {
        finalizers: ['agents.proompteng.ai/runtime-cleanup'],
      },
    })

    expect(customObjectsMock.patchNamespacedCustomObject).toHaveBeenCalledWith(
      {
        group: 'agents.proompteng.ai',
        version: 'v1alpha1',
        namespace: 'agents',
        plural: 'agentruns',
        name: 'run-1',
        body: {
          apiVersion: 'agents.proompteng.ai/v1alpha1',
          kind: 'AgentRun',
          metadata: {
            name: 'run-1',
            namespace: 'agents',
            finalizers: ['agents.proompteng.ai/runtime-cleanup'],
          },
        },
      },
      expect.objectContaining({
        middlewareMergeStrategy: 'append',
        middleware: expect.any(Array),
      }),
    )
    expect(objectApiMock.patch).not.toHaveBeenCalled()
  })

  it('patches custom resource status through CustomObjectsApi with the current resourceVersion', async () => {
    customObjectsMock.getNamespacedCustomObject.mockResolvedValue({
      metadata: {
        name: 'run-1',
        resourceVersion: '42',
      },
    })
    customObjectsMock.patchNamespacedCustomObjectStatus.mockResolvedValue({ status: { phase: 'Running' } })

    const kube = createKubernetesClient()
    await kube.applyStatus({
      apiVersion: 'agents.proompteng.ai/v1alpha1',
      kind: 'AgentRun',
      metadata: {
        name: 'run-1',
        namespace: 'agents',
      },
      status: {
        phase: 'Running',
      },
    })

    expect(customObjectsMock.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      {
        group: 'agents.proompteng.ai',
        version: 'v1alpha1',
        namespace: 'agents',
        plural: 'agentruns',
        name: 'run-1',
        fieldManager: 'jangar-status',
        body: {
          apiVersion: 'agents.proompteng.ai/v1alpha1',
          kind: 'AgentRun',
          metadata: {
            name: 'run-1',
            namespace: 'agents',
            resourceVersion: '42',
          },
          status: {
            phase: 'Running',
          },
        },
      },
      expect.objectContaining({
        middlewareMergeStrategy: 'append',
        middleware: expect.any(Array),
      }),
    )
  })

  it('materializes inline kubeconfig tls data for Bun transport', () => {
    const tls = transportPrivate.buildBunFetchTlsAssetPaths({
      getCurrentCluster: () => ({
        caData: Buffer.from('CA DATA').toString('base64'),
        skipTLSVerify: false,
      }),
      getCurrentUser: () => ({
        certData: Buffer.from('CERT DATA').toString('base64'),
        keyData: Buffer.from('KEY DATA').toString('base64'),
      }),
    } as never)

    expect(tls.rejectUnauthorized).toBe(true)
    expect(tls.caPaths).toHaveLength(1)
    expect(tls.certPath).toBeTruthy()
    expect(tls.keyPath).toBeTruthy()
    expect(readFileSync(tls.caPaths[0]!, 'utf8')).toBe('CA DATA')
    expect(readFileSync(tls.certPath!, 'utf8')).toBe('CERT DATA')
    expect(readFileSync(tls.keyPath!, 'utf8')).toBe('KEY DATA')
  })
})
