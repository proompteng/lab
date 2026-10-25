import { describe, expect, it } from 'bun:test'

import { imageReferenceMatchesDigest, retryOperation, selectReadyContainerImages } from './verify-deployment'

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

  it('retries runtime convergence until a lagging deployment reaches the expected digest', async () => {
    let attempts = 0
    const sleeps: number[] = []

    const result = await retryOperation(
      async () => {
        attempts += 1
        if (attempts < 3) throw new Error('old digest still running')
        return 'converged'
      },
      {
        attempts: 3,
        intervalSeconds: 10,
        sleepFn: async (seconds) => {
          sleeps.push(seconds)
        },
      },
    )

    expect(result).toBe('converged')
    expect(attempts).toBe(3)
    expect(sleeps).toEqual([10, 10])
  })

  it('fails after the bounded runtime convergence attempts are exhausted', async () => {
    let attempts = 0

    const error = await retryOperation(
      async () => {
        attempts += 1
        throw new Error('old digest still running')
      },
      { attempts: 2, intervalSeconds: 0, sleepFn: async () => undefined },
    ).then(
      () => undefined,
      (failure: unknown) => failure,
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('old digest still running')
    expect(attempts).toBe(2)
  })
})
