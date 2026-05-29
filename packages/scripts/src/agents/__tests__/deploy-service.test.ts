import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __private } from '../deploy-service'

const envKeys = ['AGENTS_IMAGE_TAG', 'AGENTS_IMAGE_PLATFORMS']

afterEach(() => {
  for (const key of envKeys) {
    delete process.env[key]
  }
})

describe('agents deploy-service helpers', () => {
  it('parses runner and apply rollout flags', () => {
    expect(__private.parseArgs(['--skip-runner', '--no-apply'])).toMatchObject({
      buildRunner: false,
      apply: false,
    })
  })

  it('builds controller and control-plane images from distinct Docker targets', () => {
    expect(
      __private.buildAgentsServiceImagePlans({
        registry: 'registry.example',
        repository: 'lab/agents-controller',
        controlPlaneRepository: 'lab/agents-control-plane',
        tag: 'abc1234',
        platforms: ['linux/arm64'],
      }),
    ).toEqual([
      {
        registry: 'registry.example',
        repository: 'lab/agents-controller',
        tag: 'abc1234',
        target: 'controller',
        platforms: ['linux/arm64'],
      },
      {
        registry: 'registry.example',
        repository: 'lab/agents-control-plane',
        tag: 'abc1234',
        target: 'control-plane',
        platforms: ['linux/arm64'],
      },
    ])
  })

  it('treats local Codex auth as optional for runner image builds', () => {
    const previousHome = process.env.HOME
    const dir = mkdtempSync(join(tmpdir(), 'agents-codex-auth-'))
    try {
      process.env.HOME = dir
      expect(__private.resolveCodexAuthPath()).toBeUndefined()

      const authDir = join(dir, '.codex')
      const authPath = join(authDir, 'auth.json')
      mkdirSync(authDir, { recursive: true })
      writeFileSync(authPath, '{}\n')

      expect(__private.resolveCodexAuthPath()).toBe(authPath)
      expect(__private.resolveCodexAuthPath(authPath)).toBe(authPath)
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('drops Argo CD hook resources from direct kubectl apply manifests', () => {
    const rendered = `apiVersion: v1
kind: ConfigMap
metadata:
  name: agents-config
---
apiVersion: batch/v1
kind: Job
metadata:
  name: agents-smoke-cleanup
  annotations:
    argocd.argoproj.io/hook: PreSync
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: cleanup
          image: alpine/k8s:1.30.11
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: agents
spec:
  template:
    spec:
      containers:
        - name: agents
          image: registry.example/agents@sha256:abc
`

    const filtered = __private.filterDirectApplyManifests(rendered)

    expect(filtered).toContain('kind: ConfigMap')
    expect(filtered).toContain('kind: Deployment')
    expect(filtered).not.toContain('kind: Job')
    expect(filtered).not.toContain('agents-smoke-cleanup')
    expect(filtered).not.toContain('argocd.argoproj.io/hook')
  })

  it('detects Argo CD hook manifests by annotation', () => {
    expect(
      __private.isArgoHookManifest({
        metadata: {
          annotations: {
            'argocd.argoproj.io/hook': 'PostSync',
          },
        },
      }),
    ).toBeTrue()

    expect(
      __private.isArgoHookManifest({
        metadata: {
          annotations: {
            'helm.sh/hook': 'test',
          },
        },
      }),
    ).toBeFalse()
  })

  it('updates control-plane, controller, and runner image pins together', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agents-deploy-values-'))
    const valuesPath = join(dir, 'values.yaml')

    writeFileSync(
      valuesPath,
      `image:
  repository: old/controller
  tag: old
  digest: sha256:old-controller
controlPlane:
  image:
    repository: old/control-plane
    tag: old
    digest: sha256:old-control-plane
controllers:
  image:
    repository: old/controllers-override
    tag: old
    digest: sha256:old-controllers-override
runner:
  image:
    repository: old/runner
    tag: old
    digest: sha256:old-runner
`,
    )

    __private.updateValuesFile(
      valuesPath,
      'registry.example/lab/agents-controller',
      'abc123',
      'sha256:controller',
      'registry.example/lab/agents-control-plane',
      'abc123',
      'sha256:control-plane',
      'registry.example/lab/agents-codex-runner',
      'abc123',
      'sha256:runner',
      {
        sourceHeadSha: 'abcdef1234567890',
        gitopsRevision: 'abcdef1234567890',
        sourceCiRunId: '12345',
        sourceCiConclusion: 'success',
        manifestImageDigest: 'sha256:control-plane',
        servingBuildCommit: 'abcdef1234567890',
        servingImageDigest: 'sha256:control-plane',
      },
    )

    const updated = readFileSync(valuesPath, 'utf8')
    expect(updated).toContain('repository: registry.example/lab/agents-controller')
    expect(updated).not.toContain('old/controllers-override')
    expect(updated).toContain('repository: registry.example/lab/agents-control-plane')
    expect(updated).toContain('repository: registry.example/lab/agents-codex-runner')
    expect(updated).toContain('digest: sha256:controller')
    expect(updated).toContain('digest: sha256:runner')
    expect(updated).toContain('AGENTS_SOURCE_HEAD_SHA: abcdef1234567890')
    expect(updated).toContain('AGENTS_SOURCE_CI_RUN_ID: "12345"')
    expect(updated).toContain('AGENTS_SERVING_IMAGE_DIGEST: sha256:control-plane')

    rmSync(dir, { recursive: true, force: true })
  })

  it('resolves the external database secret required by rendered Agents values', () => {
    expect(
      __private.resolveDatabaseSecretRequirement({
        database: {
          secretRef: {
            name: 'agents-db-app',
          },
        },
      }),
    ).toEqual({
      namespace: 'agents',
      name: 'agents-db-app',
    })

    expect(
      __private.resolveDatabaseSecretRequirement({
        database: {
          url: 'postgresql://agents:pw@postgres/agents',
          secretRef: {
            name: 'agents-db-app',
          },
        },
      }),
    ).toBeNull()
  })

  it('does not expose database secret compatibility alias helpers', () => {
    expect(__private).not.toHaveProperty('resolveDatabaseSecretSource')
    expect(__private).not.toHaveProperty('buildDatabaseSecretAliasManifest')
  })
})
