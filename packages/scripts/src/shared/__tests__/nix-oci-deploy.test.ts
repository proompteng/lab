import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'bun:test'

import { buildAndPushNixImage } from '../nix-oci-deploy'

describe('buildAndPushNixImage', () => {
  it('writes an honest manual dry-run contract without claiming pushed platforms', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nix-oci-deploy-contract-'))
    const contractPath = join(dir, 'manual-release-contract.json')

    const result = await buildAndPushNixImage({
      service: 'oirat',
      imageName: 'oirat',
      packageAttr: 'oirat-image',
      tag: 'sha-test',
      sourceSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      dryRun: true,
      contractPath,
    })

    expect(result).toMatchObject({
      service: 'oirat',
      image: 'registry.ide-newton.ts.net/lab/oirat',
      tag: 'sha-test',
      digest: 'sha256:dry-run',
      platforms: [],
      platformDigests: {},
      lockfileHashes: {
        'flake.lock': expect.any(String),
        'bun.lock': expect.any(String),
      },
      dryRun: true,
    })

    const contract = JSON.parse(readFileSync(contractPath, 'utf8')) as Record<string, unknown>
    expect(contract).toMatchObject({
      service: 'oirat',
      image: 'registry.ide-newton.ts.net/lab/oirat',
      tag: 'sha-test',
      digest: 'sha256:dry-run',
      reference: 'registry.ide-newton.ts.net/lab/oirat@sha256:dry-run',
      sourceSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      packageAttr: 'oirat-image',
      platforms: [],
      platformDigests: {},
      lockfileHashes: {
        'flake.lock': expect.stringMatching(/^[0-9a-f]{64}$/),
        'bun.lock': expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      toolVersions: expect.any(Object),
      cacheProvenance: {
        source: 'manual-script-not-collected',
      },
      timings: [],
      builder: 'nix-dockerTools-skopeo',
      invocation: 'manual-script',
      dryRun: true,
    })
    expect(contract.imageTarPath).toBeUndefined()
  })
})
