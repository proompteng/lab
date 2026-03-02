import { afterEach, describe, expect, it, vi } from 'vitest'

const kubeWatchMocks = vi.hoisted(() => ({
  startResourceWatch: vi.fn(() => ({ stop: vi.fn() })),
}))

const primitivesKubeMocks = vi.hoisted(() => ({
  createKubernetesClient: vi.fn(),
}))

vi.mock('~/server/kube-watch', () => kubeWatchMocks)
vi.mock('~/server/primitives-kube', async () => {
  const actual = await vi.importActual<typeof import('~/server/primitives-kube')>('~/server/primitives-kube')
  return {
    ...actual,
    createKubernetesClient: primitivesKubeMocks.createKubernetesClient,
  }
})

import { __test__ as controlPlaneStream, streamControlPlaneEvents } from '~/routes/api/agents/control-plane/stream'
import { RESOURCE_MAP } from '~/server/primitives-kube'

describe('control plane stream', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('skips swarm watch when the swarm CRD is unavailable', async () => {
    const kube = {
      list: async (resource: string) => {
        if (resource === RESOURCE_MAP.Swarm) {
          throw new Error(
            `Error from server (NotFound): the server doesn't have a resource type "${RESOURCE_MAP.Swarm}"`,
          )
        }
        return { items: [] }
      },
    }

    await expect(controlPlaneStream.isSwarmWatchSupported('agents', kube)).resolves.toBe(false)
  })

  it('continues to watch swarm when list fails for non-resource-type reasons', async () => {
    const kube = {
      list: async (resource: string) => {
        if (resource === RESOURCE_MAP.Swarm) {
          throw new Error(
            'Error from server (Forbidden): user is forbidden to list resource "swarms.swarm.proompteng.ai"',
          )
        }
        return { items: [] }
      },
    }

    await expect(controlPlaneStream.isSwarmWatchSupported('agents', kube)).resolves.toBe(true)
  })

  it('adds swarm watch when CRD appears for an existing namespace stream', async () => {
    let swarmChecks = 0
    primitivesKubeMocks.createKubernetesClient.mockReturnValue({
      list: async (resource: string) => {
        if (resource === RESOURCE_MAP.Swarm) {
          swarmChecks += 1
          if (swarmChecks === 1) {
            throw new Error(
              `Error from server (NotFound): the server doesn't have a resource type "${RESOURCE_MAP.Swarm}"`,
            )
          }
        }
        return { items: [] }
      },
    })

    const namespace = 'swarm-upgrade'
    const first = await streamControlPlaneEvents(
      new Request(`http://localhost/api/agents/control-plane/stream?namespace=${namespace}`),
    )
    const callsAfterFirst = vi.mocked(kubeWatchMocks.startResourceWatch).mock.calls.length

    const second = await streamControlPlaneEvents(
      new Request(`http://localhost/api/agents/control-plane/stream?namespace=${namespace}`),
    )
    const callsAfterSecond = vi.mocked(kubeWatchMocks.startResourceWatch).mock.calls.length

    const newlyAddedCalls = vi.mocked(kubeWatchMocks.startResourceWatch).mock.calls.slice(callsAfterFirst)
    expect(newlyAddedCalls).toHaveLength(1)
    expect(newlyAddedCalls[0]?.[0].resource).toBe(RESOURCE_MAP.Swarm)

    const swarmWatches = vi
      .mocked(kubeWatchMocks.startResourceWatch)
      .mock.calls.filter(([options]) => options.resource === RESOURCE_MAP.Swarm)
    expect(swarmWatches).toHaveLength(1)
    expect(swarmWatches[0]?.[0].namespace).toBe(namespace)
    expect(swarmChecks).toBe(2)
    expect(callsAfterSecond - callsAfterFirst).toBe(1)

    await first.body?.cancel()
    await second.body?.cancel()
  })
})
