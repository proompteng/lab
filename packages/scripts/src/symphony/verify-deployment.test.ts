import { describe, expect, it } from 'bun:test'

import { imageIdMatchesDigest, selectReadyContainerImages } from './verify-deployment'

describe('Symphony deployment image verification', () => {
  const digest = `sha256:${'a'.repeat(64)}`

  it('accepts Kubernetes image IDs pinned to the expected digest', () => {
    expect(imageIdMatchesDigest(`registry.example/symphony@${digest}`, digest)).toBe(true)
    expect(imageIdMatchesDigest(`docker-pullable://registry.example/symphony@${digest}`, digest)).toBe(true)
  })

  it('selects the actual container name independently of the deployment name', () => {
    expect(
      selectReadyContainerImages(
        {
          items: [
            {
              metadata: { name: 'symphony-jangar-abc' },
              status: {
                containerStatuses: [{ name: 'symphony', imageID: `registry.example/symphony@${digest}`, ready: true }],
              },
            },
          ],
        },
        'symphony',
      ),
    ).toEqual([{ pod: 'symphony-jangar-abc', imageID: `registry.example/symphony@${digest}` }])
  })
})
