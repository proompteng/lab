import { describe, expect, it } from 'bun:test'

import type { EnabledAppInventory, EnabledAppInventoryEntry } from '../enabled-apps'
import {
  buildNixRolloutReport,
  formatNixRolloutReportMarkdown,
  type NixRolloutReleaseContract,
} from '../nix-rollout-report'

const entry = (overrides: Partial<EnabledAppInventoryEntry>): EnabledAppInventoryEntry => ({
  name: overrides.name ?? 'app',
  path: overrides.path ?? `argocd/applications/${overrides.name ?? 'app'}`,
  repoURL: overrides.repoURL ?? 'https://github.com/proompteng/lab.git',
  sourceFile: overrides.sourceFile ?? 'argocd/applicationsets/platform.yaml',
  sourceKind: overrides.sourceKind ?? 'applicationset-element',
  class: overrides.class ?? 'nix-image',
  enabled: overrides.enabled ?? true,
  hasHelmChart: overrides.hasHelmChart ?? false,
  repoImages: overrides.repoImages ?? [`registry.ide-newton.ts.net/lab/${overrides.name ?? 'app'}`],
  buildScriptPath: overrides.buildScriptPath,
  deployScriptPath: overrides.deployScriptPath,
  workflowPaths: overrides.workflowPaths ?? [],
  nixImageAttr: overrides.nixImageAttr,
  deferredReason: overrides.deferredReason,
})

const inventory = (entries: EnabledAppInventoryEntry[]): EnabledAppInventory => ({
  entries,
  applicationSetEntryCount: entries.length,
  directApplicationCount: 0,
})

const validContract = (overrides: Partial<NixRolloutReleaseContract> = {}): NixRolloutReleaseContract => ({
  service: overrides.service ?? 'app',
  image: overrides.image ?? 'registry.ide-newton.ts.net/lab/app',
  tag: overrides.tag ?? 'sha-123',
  digest: overrides.digest ?? 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  reference:
    overrides.reference ??
    'registry.ide-newton.ts.net/lab/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sourceSha: overrides.sourceSha ?? '1234567890abcdef',
  packageAttr: overrides.packageAttr ?? 'app-image',
  platforms: overrides.platforms ?? ['linux/amd64', 'linux/arm64'],
  builder: overrides.builder ?? 'nix-dockerTools-skopeo',
  invocation: overrides.invocation ?? 'github-actions',
  path: overrides.path ?? '.artifacts/app/release-contract.json',
})

describe('Nix rollout report', () => {
  it('audits live enabled-app inventory without counting reviewed upstream mirrors as deferred', () => {
    const report = buildNixRolloutReport({})
    const hermes = report.manifestOnlyImageApps.find((candidate) => candidate.name === 'hermes')
    const tigresse = report.manifestOnlyImageApps.find((candidate) => candidate.name === 'tigresse')

    expect(report.nixImages.length).toBeGreaterThan(0)
    expect(report.deferredApps).toEqual([])
    expect(report.missingBuildContracts).toEqual([])
    expect(hermes?.deferredReason).toContain('NousResearch/hermes-agent')
    expect(tigresse?.deferredReason).toContain('proompteng/tigresse')
  })

  it('reports missing build contract pieces for Nix image apps', () => {
    const report = buildNixRolloutReport({
      inventory: inventory([
        entry({
          name: 'broken',
          class: 'nix-image',
          repoImages: ['registry.ide-newton.ts.net/lab/broken'],
        }),
      ]),
    })

    expect(report.missingBuildContracts).toEqual([
      'broken: missing nix attr, manual build script, manual deploy script, workflow',
    ])
  })

  it('validates provided release contracts and maps them to Nix image apps when required', () => {
    const report = buildNixRolloutReport({
      inventory: inventory([
        entry({
          name: 'app',
          class: 'nix-image',
          nixImageAttr: 'app-image',
          buildScriptPath: 'packages/scripts/src/app/build-image.ts',
          deployScriptPath: 'packages/scripts/src/app/deploy-service.ts',
          workflowPaths: ['.github/workflows/product-nix-images.yml'],
        }),
      ]),
      releaseContracts: [validContract()],
      requireContracts: true,
    })

    expect(report.releaseContracts).toMatchObject({
      provided: 1,
      valid: 1,
      invalid: [],
      missingForNixImages: [],
    })
  })

  it('normalizes digest-pinned manifest refs before checking contract coverage', () => {
    const digest = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const report = buildNixRolloutReport({
      inventory: inventory([
        entry({
          name: 'torghut',
          repoImages: [`registry.ide-newton.ts.net/lab/torghut@${digest}`],
          nixImageAttr: 'torghut-image',
          buildScriptPath: 'packages/scripts/src/torghut/build-image.ts',
          deployScriptPath: 'packages/scripts/src/torghut/deploy-service.ts',
          workflowPaths: ['.github/workflows/torghut-build-push.yaml'],
        }),
      ]),
      releaseContracts: [
        validContract({
          service: 'torghut',
          image: 'registry.ide-newton.ts.net/lab/torghut',
          digest,
          reference: `registry.ide-newton.ts.net/lab/torghut@${digest}`,
          packageAttr: 'torghut-image',
        }),
      ],
      requireContracts: true,
    })

    expect(report.releaseContracts.missingForNixImages).toEqual([])
  })

  it('requires a digest-pinned manifest ref to match the release contract digest', () => {
    const deployedDigest = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const staleContractDigest = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
    const report = buildNixRolloutReport({
      inventory: inventory([
        entry({
          name: 'torghut',
          repoImages: [`registry.ide-newton.ts.net/lab/torghut@${deployedDigest}`],
          nixImageAttr: 'torghut-image',
          buildScriptPath: 'packages/scripts/src/torghut/build-image.ts',
          deployScriptPath: 'packages/scripts/src/torghut/deploy-service.ts',
          workflowPaths: ['.github/workflows/torghut-build-push.yaml'],
        }),
      ]),
      releaseContracts: [
        validContract({
          service: 'torghut',
          image: 'registry.ide-newton.ts.net/lab/torghut',
          digest: staleContractDigest,
          reference: `registry.ide-newton.ts.net/lab/torghut@${staleContractDigest}`,
          packageAttr: 'torghut-image',
        }),
      ],
      requireContracts: true,
    })

    expect(report.releaseContracts.valid).toBe(1)
    expect(report.releaseContracts.missingForNixImages).toEqual(['torghut'])
  })

  it('fails closed for incomplete digest references', () => {
    const digest = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const report = buildNixRolloutReport({
      inventory: inventory([
        entry({
          name: 'headlamp',
          repoImages: ['registry.ide-newton.ts.net/lab/headlamp@sha256'],
          nixImageAttr: 'headlamp-image',
          buildScriptPath: 'packages/scripts/src/headlamp/build-image.ts',
          deployScriptPath: 'packages/scripts/src/headlamp/deploy-service.ts',
          workflowPaths: ['.github/workflows/headlamp-ci.yml'],
        }),
      ]),
      releaseContracts: [
        validContract({
          service: 'headlamp',
          image: 'registry.ide-newton.ts.net/lab/headlamp',
          digest,
          reference: `registry.ide-newton.ts.net/lab/headlamp@${digest}`,
          packageAttr: 'headlamp-image',
        }),
      ],
      requireContracts: true,
    })

    expect(report.releaseContracts.valid).toBe(1)
    expect(report.releaseContracts.missingForNixImages).toEqual(['headlamp'])
  })

  it('flags invalid release contracts and missing required contract coverage', () => {
    const report = buildNixRolloutReport({
      inventory: inventory([
        entry({
          name: 'app',
          class: 'nix-image',
          nixImageAttr: 'app-image',
          buildScriptPath: 'packages/scripts/src/app/build-image.ts',
          deployScriptPath: 'packages/scripts/src/app/deploy-service.ts',
          workflowPaths: ['.github/workflows/product-nix-images.yml'],
        }),
      ]),
      releaseContracts: [
        validContract({
          service: 'other',
          image: 'registry.ide-newton.ts.net/lab/other',
          reference:
            'registry.ide-newton.ts.net/lab/other@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          packageAttr: 'other-image',
          platforms: ['linux/amd64'],
          path: '.artifacts/other/release-contract.json',
        }),
      ],
      requireContracts: true,
    })

    expect(report.releaseContracts.valid).toBe(0)
    expect(report.releaseContracts.invalid[0]).toContain('missing platform linux/arm64')
    expect(report.releaseContracts.missingForNixImages).toEqual(['app'])
  })

  it('rejects truncated digests even when they use the sha256 prefix', () => {
    const report = buildNixRolloutReport({
      inventory: inventory([
        entry({
          name: 'app',
          nixImageAttr: 'app-image',
          buildScriptPath: 'packages/scripts/src/app/build-image.ts',
          deployScriptPath: 'packages/scripts/src/app/deploy-service.ts',
          workflowPaths: ['.github/workflows/product-nix-images.yml'],
        }),
      ]),
      releaseContracts: [
        validContract({ digest: 'sha256:todo', reference: 'registry.ide-newton.ts.net/lab/app@sha256:todo' }),
      ],
      requireContracts: true,
    })

    expect(report.releaseContracts.valid).toBe(0)
    expect(report.releaseContracts.invalid[0]).toContain('digest is not a full sha256 digest')
    expect(report.releaseContracts.missingForNixImages).toEqual(['app'])
  })

  it('requires release-contract coverage for every image owned by a Nix app', () => {
    const report = buildNixRolloutReport({
      inventory: inventory([
        entry({
          name: 'agents',
          repoImages: [
            'registry.ide-newton.ts.net/lab/agents-controller',
            'registry.ide-newton.ts.net/lab/agents-runner',
          ],
          nixImageAttr: 'agents-controller-image',
          buildScriptPath: 'packages/scripts/src/agents/build-image.ts',
          deployScriptPath: 'packages/scripts/src/agents/deploy-service.ts',
          workflowPaths: ['.github/workflows/agents-build-push.yml'],
        }),
      ]),
      releaseContracts: [
        validContract({
          service: 'agents-controller',
          image: 'registry.ide-newton.ts.net/lab/agents-controller',
          reference:
            'registry.ide-newton.ts.net/lab/agents-controller@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          packageAttr: 'agents-controller-image',
        }),
      ],
      requireContracts: true,
    })

    expect(report.releaseContracts.missingForNixImages).toEqual(['agents:registry.ide-newton.ts.net/lab/agents-runner'])
  })

  it('formats a markdown report with inventory and gate sections', () => {
    const report = buildNixRolloutReport({
      inventory: inventory([
        entry({
          name: 'app',
          class: 'nix-image',
          nixImageAttr: 'app-image',
          buildScriptPath: 'packages/scripts/src/app/build-image.ts',
          deployScriptPath: 'packages/scripts/src/app/deploy-service.ts',
          workflowPaths: ['.github/workflows/product-nix-images.yml'],
        }),
      ]),
    })

    const markdown = formatNixRolloutReportMarkdown(report)

    expect(markdown).toContain('# Nix Enabled-App Rollout Report')
    expect(markdown).toContain('## Nix Image Apps')
    expect(markdown).toContain('| app | app-image |')
    expect(markdown).toContain('Missing Nix image build contracts: None')
  })
})
