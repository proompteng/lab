import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { writeReleaseContract } from '../../jangar/release-contract'
import { repoRoot } from '../../shared/cli'
import { resolvePublishedJangarImage } from '../resolve-published-jangar-image'

describe('resolvePublishedJangarImage', () => {
  it('uses the immutable control-plane image from the release contract when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resolve-published-jangar-image-'))
    const contractPath = join(dir, 'contract.json')

    writeReleaseContract(relative(repoRoot, contractPath), {
      sourceSha: '1234567890abcdef1234567890abcdef12345678',
      tag: '12345678',
      digest: 'sha256:6af34b1781155267ed6821833feb0ee8856b2b08128cb0ac9b0c388615b380fe',
      image: 'registry.ide-newton.ts.net/lab/jangar',
      controlPlaneImage: 'registry.ide-newton.ts.net/lab/jangar-control-plane',
      controlPlaneDigest: 'sha256:6e621beae7d0c07f1d3ae3618435b762f954e1b1410e46ea7dac56db8f5ced96',
      createdAt: '2026-02-20T06:30:00.000Z',
    })

    expect(resolvePublishedJangarImage(relative(repoRoot, contractPath))).toEqual({
      sourceSha: '1234567890abcdef1234567890abcdef12345678',
      imageRepository: 'registry.ide-newton.ts.net/lab/jangar-control-plane',
      imageTag: '12345678',
      imageDigest: 'sha256:6e621beae7d0c07f1d3ae3618435b762f954e1b1410e46ea7dac56db8f5ced96',
      imageRef:
        'registry.ide-newton.ts.net/lab/jangar-control-plane@sha256:6e621beae7d0c07f1d3ae3618435b762f954e1b1410e46ea7dac56db8f5ced96',
      digestSource: 'contract',
    })

    rmSync(dir, { recursive: true, force: true })
  })

  it('falls back to the SHA tag for older contracts without control-plane metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resolve-published-jangar-image-'))
    const contractPath = join(dir, 'contract.json')

    writeReleaseContract(relative(repoRoot, contractPath), {
      sourceSha: 'fedcba0987654321fedcba0987654321fedcba09',
      tag: 'fedcba09',
      digest: 'sha256:92b26b54d2ee65b1ce53f15fe4cb37500865167583515a69f8f299ec52ffb405',
      image: 'registry.ide-newton.ts.net/lab/jangar',
      createdAt: '2026-02-20T06:32:00.000Z',
    })

    expect(resolvePublishedJangarImage(relative(repoRoot, contractPath))).toEqual({
      sourceSha: 'fedcba0987654321fedcba0987654321fedcba09',
      imageRepository: 'registry.ide-newton.ts.net/lab/jangar-control-plane',
      imageTag: 'fedcba09',
      imageDigest: '',
      imageRef: 'registry.ide-newton.ts.net/lab/jangar-control-plane:fedcba09',
      digestSource: 'tag-resolution-needed',
    })

    rmSync(dir, { recursive: true, force: true })
  })
})
