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
import { createKubernetesClient, RESOURCE_MAP, resolveKubernetesResourceTarget } from '~/server/primitives-kube'

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

  it('uses the core object API for persistent volume claim storage proof', async () => {
    objectApiMock.read.mockResolvedValue({ metadata: { name: 'workspace-1' }, status: { phase: 'Bound' } })
    objectApiMock.list.mockResolvedValue({ items: [] })
    objectApiMock.delete.mockResolvedValue({ metadata: { name: 'workspace-1' } })

    const kube = createKubernetesClient()
    await expect(kube.get(RESOURCE_MAP.PersistentVolumeClaim, 'workspace-1', 'agents')).resolves.toEqual({
      metadata: { name: 'workspace-1' },
      status: { phase: 'Bound' },
    })
    await expect(
      kube.list(RESOURCE_MAP.PersistentVolumeClaim, 'agents', 'workspaces.proompteng.ai/workspace=workspace-1'),
    ).resolves.toEqual({ items: [] })
    await expect(
      kube.delete(RESOURCE_MAP.PersistentVolumeClaim, 'workspace-1', 'agents', { wait: false }),
    ).resolves.toEqual({
      metadata: { name: 'workspace-1' },
    })

    expect(objectApiMock.read).toHaveBeenCalledWith({
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name: 'workspace-1',
        namespace: 'agents',
      },
    })
    expect(objectApiMock.list).toHaveBeenCalledWith(
      'v1',
      'PersistentVolumeClaim',
      'agents',
      undefined,
      undefined,
      undefined,
      undefined,
      'workspaces.proompteng.ai/workspace=workspace-1',
    )
    expect(objectApiMock.delete).toHaveBeenCalledWith(
      {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: {
          name: 'workspace-1',
          namespace: 'agents',
        },
      },
      undefined,
      undefined,
      0,
      undefined,
      'Background',
      {
        apiVersion: 'v1',
        kind: 'DeleteOptions',
      },
    )
    expect(customObjectsMock.getNamespacedCustomObject).not.toHaveBeenCalled()
    expect(customObjectsMock.listNamespacedCustomObject).not.toHaveBeenCalled()
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

  it('resolves PersistentVolumeClaim aliases through the core v1 resource target', () => {
    for (const alias of ['persistentvolumeclaim', 'persistentvolumeclaims', 'pvc', 'pvcs']) {
      expect(resolveKubernetesResourceTarget(alias)).toEqual({
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        plural: 'persistentvolumeclaims',
        namespaceScoped: true,
      })
    }
  })

  it('uses KubernetesObjectApi for PersistentVolumeClaim reads and lists', async () => {
    objectApiMock.read.mockResolvedValue({ metadata: { name: 'workspace-pvc' } })
    objectApiMock.list.mockResolvedValue({ items: [] })

    const kube = createKubernetesClient()
    const pvc = await kube.get('persistentvolumeclaim', 'workspace-pvc', 'agents')
    const pvcs = await kube.list('persistentvolumeclaims', 'agents', 'workspaces.proompteng.ai/name=workspace-pvc')

    expect(pvc).toEqual({ metadata: { name: 'workspace-pvc' } })
    expect(pvcs).toEqual({ items: [] })
    expect(objectApiMock.read).toHaveBeenCalledWith({
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name: 'workspace-pvc',
        namespace: 'agents',
      },
    })
    expect(objectApiMock.list).toHaveBeenCalledWith(
      'v1',
      'PersistentVolumeClaim',
      'agents',
      undefined,
      undefined,
      undefined,
      undefined,
      'workspaces.proompteng.ai/name=workspace-pvc',
    )
    expect(customObjectsMock.getNamespacedCustomObject).not.toHaveBeenCalled()
    expect(customObjectsMock.listNamespacedCustomObject).not.toHaveBeenCalled()
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
