import { describe, expect, it } from 'bun:test'

import { localSmokeRunnerImage, resolveSmokeRunnerImage } from '../resolve-smoke-runner-image'

const publishedSource = { mode: 'published', sourceSha: 'a'.repeat(40) } as const
const localSelection = { image: localSmokeRunnerImage, buildLocal: true }

describe('resolveSmokeRunnerImage', () => {
  it('uses the checkout image for local smoke without querying the registry', async () => {
    const failProbe = async () => {
      throw new Error('unexpected registry query')
    }
    expect(await resolveSmokeRunnerImage({ mode: 'local' }, failProbe)).toEqual(localSelection)
  })

  it('pins the published multi-architecture index at the promoted source revision', async () => {
    const digest = `sha256:${'b'.repeat(64)}`
    const selection = await resolveSmokeRunnerImage(publishedSource, async (url, init) => {
      expect(url).toBe(
        `https://registry.ide-newton.ts.net/v2/lab/agents-smoke-runner/manifests/sha-${publishedSource.sourceSha}`,
      )
      expect(new Headers(init.headers).get('Accept')).toContain('application/vnd.oci.image.index.v1+json')
      return Response.json({}, { headers: { 'Docker-Content-Digest': digest } })
    })
    expect(selection).toEqual({
      image: `registry.ide-newton.ts.net/lab/agents-smoke-runner:sha-${publishedSource.sourceSha}@${digest}`,
      buildLocal: false,
    })
  })

  it.each(['MANIFEST_UNKNOWN', 'NAME_UNKNOWN'])('builds from checkout on a registry 404 with %s', async (code) => {
    const selection = await resolveSmokeRunnerImage(publishedSource, async () =>
      Response.json({ errors: [{ code }] }, { status: 404 }),
    )
    expect(selection).toEqual(localSelection)
  })

  it.each([401, 403, 429, 500])('does not rebuild on registry HTTP %i', async (status) => {
    await expect(
      resolveSmokeRunnerImage(publishedSource, async () =>
        Response.json({ errors: [{ code: 'MANIFEST_UNKNOWN' }] }, { status }),
      ),
    ).rejects.toThrow(`HTTP ${status}`)
  })

  it.each(['<html>Not Found</html>', '{}', '{"errors":[{"code":"DENIED"}]}'])(
    'does not rebuild on an unverified 404 (%s)',
    async (body) => {
      await expect(
        resolveSmokeRunnerImage(publishedSource, async () => new Response(body, { status: 404 })),
      ).rejects.toThrow('HTTP 404')
    },
  )

  it.each([{}, { 'Docker-Content-Digest': 'sha256:invalid' }])(
    'rejects successful registry responses without a valid digest (%j)',
    async (headers) => {
      await expect(
        resolveSmokeRunnerImage(publishedSource, async () => Response.json({}, { headers })),
      ).rejects.toThrow('no valid Docker-Content-Digest')
    },
  )

  it('propagates transport errors rather than rebuilding', async () => {
    await expect(
      resolveSmokeRunnerImage(publishedSource, async () => {
        throw new Error('registry unreachable')
      }),
    ).rejects.toThrow('registry unreachable')
  })

  it('rejects missing release provenance rather than probing a mutable tag', async () => {
    await expect(resolveSmokeRunnerImage({ mode: 'published', sourceSha: '' })).rejects.toThrow('full source SHA')
  })
})
