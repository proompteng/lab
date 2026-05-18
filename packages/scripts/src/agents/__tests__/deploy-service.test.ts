import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __private } from '../deploy-service'

describe('agents deploy-service helpers', () => {
  it('parses runner and apply rollout flags', () => {
    expect(__private.parseArgs(['--skip-runner', '--no-apply'])).toMatchObject({
      buildRunner: false,
      apply: false,
    })
  })

  it('builds controller and control-plane images from the narrow control-plane Docker target', () => {
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
        target: 'control-plane',
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

  it('builds an Agents-owned compatibility database secret without source ownership metadata', () => {
    const manifest = __private.buildDatabaseSecretAliasManifest(
      {
        apiVersion: 'v1',
        kind: 'Secret',
        type: 'kubernetes.io/basic-auth',
        data: {
          uri: 'cG9zdGdyZXNxbDovL2FnZW50cw==',
        },
        metadata: {
          name: 'jangar-db-app',
          namespace: 'agents',
          uid: 'source-uid',
          resourceVersion: '123',
          ownerReferences: [{ name: 'source-owner' }],
          annotations: {
            'reflector.v1.k8s.emberstack.com/reflects': 'jangar/jangar-db-app',
          },
        },
      },
      {
        sourceNamespace: 'agents',
        sourceName: 'jangar-db-app',
        targetNamespace: 'agents',
        targetName: 'agents-db-app',
      },
    )

    expect(manifest.metadata?.name).toBe('agents-db-app')
    expect(manifest.metadata?.namespace).toBe('agents')
    expect(manifest.data?.uri).toBe('cG9zdGdyZXNxbDovL2FnZW50cw==')
    expect(manifest.metadata).not.toHaveProperty('uid')
    expect(manifest.metadata).not.toHaveProperty('resourceVersion')
    expect(manifest.metadata).not.toHaveProperty('ownerReferences')
    expect(manifest.metadata?.annotations).toEqual({
      'agents.proompteng.ai/created-by': 'agents-deploy-service',
      'agents.proompteng.ai/compat-source-secret': 'agents/jangar-db-app',
    })
  })
})
