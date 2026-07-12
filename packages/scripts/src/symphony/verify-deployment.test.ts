import { describe, expect, it } from 'bun:test'

import { imageReferenceMatchesDigest, selectReadyContainerImages } from './verify-deployment'

describe('Symphony deployment image verification', () => {
  const digest = `sha256:${'a'.repeat(64)}`

  it('accepts Kubernetes image references pinned to the expected digest', () => {
    expect(imageReferenceMatchesDigest(`registry.example/symphony@${digest}`, digest)).toBe(true)
    expect(imageReferenceMatchesDigest(`docker-pullable://registry.example/symphony@${digest}`, digest)).toBe(true)
  })

  it('verifies the pinned pod spec when the runtime reports a platform-specific image ID', () => {
    const runningImages = selectReadyContainerImages(
      {
        items: [
          {
            metadata: { name: 'symphony-jangar-abc' },
            spec: {
              containers: [{ name: 'symphony', image: `registry.example/symphony:main@${digest}` }],
            },
            status: {
              containerStatuses: [
                {
                  name: 'symphony',
                  imageID: `containerd://sha256:${'b'.repeat(64)}`,
                  ready: true,
                },
              ],
            },
          },
        ],
      },
      'symphony',
    )

    expect(runningImages).toEqual([
      {
        pod: 'symphony-jangar-abc',
        image: `registry.example/symphony:main@${digest}`,
        imageID: `containerd://sha256:${'b'.repeat(64)}`,
      },
    ])
    expect(runningImages.every((status) => imageReferenceMatchesDigest(status.image, digest))).toBe(true)
  })
})
