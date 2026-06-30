import { describe, expect, it } from 'bun:test'

import { buildNixOciBuildPlan, buildNixOciReleaseContract } from '../nix-oci'

describe('Nix OCI build contract', () => {
  it('builds the shared GitHub Actions and manual deploy image plan', () => {
    const plan = buildNixOciBuildPlan({
      service: 'oirat',
      imageName: 'oirat',
      packageAttr: 'oirat-image',
      tag: 'sha-abc1234',
      sourceSha: 'abc123456789',
    })

    expect(plan.image).toBe('registry.ide-newton.ts.net/lab/oirat')
    expect(plan.referenceTag).toBe('registry.ide-newton.ts.net/lab/oirat:sha-abc1234')
    expect(plan.nixBuildArgs).toEqual(['nix', 'build', '.#oirat-image', '--print-build-logs'])
    expect(plan.platformPushArgs['linux/amd64']).toContain('sha-abc1234-amd64')
    expect(plan.platformPushArgs['linux/arm64']).toContain('sha-abc1234-arm64')
    expect(plan.indexArgs).toContain('linux/amd64=sha-abc1234-amd64')
    expect(plan.indexArgs).toContain('linux/arm64=sha-abc1234-arm64')
  })

  it('refuses pushes outside the lab registry namespace', () => {
    expect(() =>
      buildNixOciBuildPlan({
        service: 'bad',
        imageName: 'bad',
        packageAttr: 'bad-image',
        tag: 'sha-bad',
        sourceSha: 'bad',
        registry: 'ghcr.io',
        repository: 'proompteng/bad',
      }),
    ).toThrow('Nix OCI image pushes must stay in registry.ide-newton.ts.net/lab')
  })

  it('serializes the same release contract shape for manual scripts and Actions', () => {
    const plan = buildNixOciBuildPlan({
      service: 'bumba',
      imageName: 'bumba',
      packageAttr: 'bumba-image',
      tag: 'sha-feedbee',
      sourceSha: 'feedbeefeedbeefeedbee',
    })

    expect(
      buildNixOciReleaseContract({
        plan,
        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        invocation: 'manual-script',
      }),
    ).toEqual({
      service: 'bumba',
      image: 'registry.ide-newton.ts.net/lab/bumba',
      tag: 'sha-feedbee',
      digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      reference:
        'registry.ide-newton.ts.net/lab/bumba@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sourceSha: 'feedbeefeedbeefeedbee',
      packageAttr: 'bumba-image',
      platforms: ['linux/amd64', 'linux/arm64'],
      builder: 'nix-dockerTools-skopeo',
      invocation: 'manual-script',
    })
  })
})
