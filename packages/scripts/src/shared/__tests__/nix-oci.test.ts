import { describe, expect, it } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'

import { buildNixOciBuildPlan, buildNixOciReleaseContract } from '../nix-oci'

describe('Nix OCI build contract', () => {
  it.each([
    { publish: 'false', ref: 'refs/heads/main', deferred: true },
    { publish: 'true', ref: 'refs/heads/main', deferred: false },
    { publish: 'true', ref: 'refs/pull/1/merge', deferred: true },
  ])('retains receipt identity with publication=$publish on $ref', ({ publish, ref, deferred }) => {
    const root = new URL('../../../../../', import.meta.url)
    const workflow = YAML.parse(readFileSync(new URL('.github/workflows/nix-oci-build-common.yml', root), 'utf8')) as {
      jobs: { 'publish-index': { steps: Array<{ name?: string; run?: string }> } }
    }
    const script = workflow.jobs['publish-index'].steps.find((step) => step.name === 'Create OCI image index')?.run
    if (script === undefined) throw new Error('Missing native OCI index step')
    const directory = mkdtempSync(join(tmpdir(), 'nix-oci-index-receipt-'))
    try {
      const captured = join(directory, 'arguments')
      writeFileSync(join(directory, 'bash'), '#!/bin/bash\nprintf \'%s\\0\' "$@" > "$INDEX_ARGS_FILE"\n', {
        mode: 0o700,
      })
      const source = '1'.repeat(40)
      const result = Bun.spawnSync(['/bin/bash', '-c', script], {
        cwd: fileURLToPath(root),
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          INDEX_ARGS_FILE: captured,
          NIX_OCI_LOG_DIR: directory,
          IMAGE: 'registry.ide-newton.ts.net/lab/bayn',
          TAG: `sha-${source}`,
          LATEST: 'false',
          PUBLISH_KARGO_TAG: publish,
          KARGO_TAG_INCLUDE_RUN_ID: 'true',
          SOURCE_SHA: source,
          BUILD_CONCLUSION: 'success',
          GITHUB_RUN_ID: '123456',
          GITHUB_REPOSITORY: 'proompteng/lab',
          GITHUB_REF: ref,
        },
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(existsSync(captured)).toBe(true)
      const args = readFileSync(captured, 'utf8').split('\0')
      expect(args).toContain('--kargo-tag')
      expect(args[args.indexOf('--kargo-tag') + 1]).toBe(`kargo-sha-${source}-run-123456`)
      expect(args.includes('--defer-kargo-tag')).toBe(deferred)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('excludes retried cache downloads and retains terminal failures in the CI summary', () => {
    const result = Bun.spawnSync([
      '/bin/bash',
      fileURLToPath(new URL('../../../../../nix/ci-nix-oci-summary.test.sh', import.meta.url)),
    ])

    expect(result.stderr.toString()).toBe('')
    expect(result.exitCode).toBe(0)
  })

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
        lockfileHashes: {
          'flake.lock': 'flake-lock-hash',
        },
        toolVersions: {
          nix: 'nix 2.32.4',
        },
        cacheProvenance: {
          source: 'manual-script-not-collected',
        },
        timings: [],
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
      lockfileHashes: {
        'flake.lock': 'flake-lock-hash',
      },
      toolVersions: {
        nix: 'nix 2.32.4',
      },
      cacheProvenance: {
        source: 'manual-script-not-collected',
      },
      timings: [],
      builder: 'nix-dockerTools-skopeo',
      invocation: 'manual-script',
    })
  })
})
