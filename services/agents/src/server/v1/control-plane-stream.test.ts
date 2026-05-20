import { afterEach, describe, expect, it, vi } from 'vitest'

const kubeWatchMocks = vi.hoisted(() => ({
  startResourceWatch: vi.fn(() => ({ stop: vi.fn() })),
}))

const kubeTypesMocks = vi.hoisted(() => ({
  createKubernetesClient: vi.fn(),
}))

vi.mock('../kube-watch', () => kubeWatchMocks)
vi.mock('../kube-types', async () => {
  const actual = await vi.importActual<typeof import('../kube-types')>('../kube-types')
  return {
    ...actual,
    createKubernetesClient: kubeTypesMocks.createKubernetesClient,
  }
})

import { RESOURCE_MAP } from '../kube-types'
import { __test__ as controlPlaneStream, streamControlPlaneEvents } from './control-plane-stream'

describe('Agents control plane stream', () => {
  afterEach(() => {
    vi.clearAllMocks()
    delete process.env.AGENTS_SWARM_PRIMITIVE_ENABLED
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
    process.env.AGENTS_SWARM_PRIMITIVE_ENABLED = 'true'
    let swarmChecks = 0
    kubeTypesMocks.createKubernetesClient.mockReturnValue({
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
      new Request(`http://localhost/v1/control-plane/stream?namespace=${namespace}`),
    )
    const callsAfterFirst = vi.mocked(kubeWatchMocks.startResourceWatch).mock.calls.length

    const second = await streamControlPlaneEvents(
      new Request(`http://localhost/v1/control-plane/stream?namespace=${namespace}`),
    )
    const callsAfterSecond = vi.mocked(kubeWatchMocks.startResourceWatch).mock.calls.length

    const startWatchCalls = vi.mocked(kubeWatchMocks.startResourceWatch).mock.calls as unknown[][]
    const newlyAddedCalls = startWatchCalls.slice(callsAfterFirst)
    expect(newlyAddedCalls).toHaveLength(1)
    const newlyAddedOptions = (newlyAddedCalls[0]?.[0] ?? {}) as Record<string, unknown>
    expect(newlyAddedOptions.resource).toBe(RESOURCE_MAP.Swarm)

    const swarmWatches = startWatchCalls.filter((call) => {
      const options = (call[0] ?? {}) as Record<string, unknown>
      return options.resource === RESOURCE_MAP.Swarm
    })
    expect(swarmWatches).toHaveLength(1)
    const firstSwarmWatchOptions = (swarmWatches[0]?.[0] ?? {}) as Record<string, unknown>
    expect(firstSwarmWatchOptions.namespace).toBe(namespace)
    expect(swarmChecks).toBe(2)
    expect(callsAfterSecond - callsAfterFirst).toBe(1)

    await first.body?.cancel()
    await second.body?.cancel()
  })
})
