import { describe, expect, it } from 'vitest'

import { __test__ as controlPlaneStream } from '~/routes/api/agents/control-plane/stream'
import { RESOURCE_MAP } from '~/server/primitives-kube'

describe('control plane stream', () => {
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
})
