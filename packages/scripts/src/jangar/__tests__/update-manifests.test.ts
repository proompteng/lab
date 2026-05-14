import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import YAML from 'yaml'

import { repoRoot } from '../../shared/cli'
import { updateJangarManifests } from '../update-manifests'

const imageName = 'registry.ide-newton.ts.net/lab/jangar'

const createFixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'jangar-manifests-test-'))
  const kustomizationPath = join(dir, 'kustomization.yaml')
  const serviceManifestPath = join(dir, 'deployment.yaml')
  const workerManifestPath = join(dir, 'worker-deployment.yaml')
  const agentsValuesPath = join(dir, 'agents-values.yaml')

  writeFileSync(
    kustomizationPath,
    `images:
  - name: registry.ide-newton.ts.net/lab/jangar
    newTag: "old-tag"
    digest: sha256:old
`,
    'utf8',
  )
  writeFileSync(
    serviceManifestPath,
    `metadata:
  annotations:
    deploy.knative.dev/rollout: "2025-01-01T00:00:00.000Z"
spec:
  template:
    spec:
      containers:
        - name: app
          env:
            - name: JANGAR_RUNTIME_IMAGE
              value: registry.ide-newton.ts.net/lab/jangar:old-tag@sha256:old
`,
    'utf8',
  )
  writeFileSync(
    workerManifestPath,
    `metadata:
  annotations:
    kubectl.kubernetes.io/restartedAt: "2025-01-01T00:00:00.000Z"
`,
    'utf8',
  )
  writeFileSync(
    agentsValuesPath,
    `image:
  repository: registry.ide-newton.ts.net/lab/jangar
  tag: "old-tag"
  digest: sha256:old
runner:
  image:
    repository: registry.ide-newton.ts.net/lab/jangar
    tag: "old-tag"
    digest: sha256:old
controlPlane:
  image:
    repository: registry.ide-newton.ts.net/lab/jangar-control-plane
    tag: "keep-tag"
    digest: sha256:keep
`,
    'utf8',
  )

  return { dir, kustomizationPath, serviceManifestPath, workerManifestPath, agentsValuesPath }
}

describe('updateJangarManifests', () => {
  it('updates tag, digest, and rollout annotations', () => {
    const fixture = createFixture()
    const rolloutTimestamp = '2026-02-20T06:30:00.000Z'

    const result = updateJangarManifests({
      imageName,
      tag: 'new-tag',
      digest: 'sha256:newdigest',
      rolloutTimestamp,
      kustomizationPath: relative(repoRoot, fixture.kustomizationPath),
      serviceManifestPath: relative(repoRoot, fixture.serviceManifestPath),
    })

    const kustomization = YAML.parse(readFileSync(fixture.kustomizationPath, 'utf8')) as {
      images?: Array<{ name?: string; newTag?: string; digest?: string }>
    }
    const serviceManifest = YAML.parse(readFileSync(fixture.serviceManifestPath, 'utf8')) as {
      metadata?: { annotations?: Record<string, string> }
      spec?: { template?: { spec?: { containers?: Array<{ env?: Array<{ name?: string; value?: string }> }> } } }
    }
    expect(kustomization.images?.[0]).toEqual({
      name: imageName,
      newTag: 'new-tag',
      digest: 'sha256:newdigest',
    })
    expect(serviceManifest.metadata?.annotations?.['deploy.knative.dev/rollout']).toBe(rolloutTimestamp)
    expect(serviceManifest.spec?.template?.spec?.containers?.[0]?.env).toContainEqual({
      name: 'JANGAR_RUNTIME_IMAGE',
      value: 'registry.ide-newton.ts.net/lab/jangar:new-tag@sha256:newdigest',
    })
    expect(result.changed).toEqual({
      kustomization: true,
      service: true,
      runtimeImageEnv: true,
      sourceHeadShaEnv: false,
      gitopsRevisionEnv: false,
      sourceCiRunIdEnv: false,
      sourceCiConclusionEnv: false,
      manifestImageDigestEnv: false,
      servingBuildCommitEnv: false,
      servingImageDigestEnv: false,
      worker: false,
      agentsValues: false,
    })

    rmSync(fixture.dir, { recursive: true, force: true })
  })

  it('updates an optional legacy worker rollout annotation when configured', () => {
    const fixture = createFixture()
    const rolloutTimestamp = '2026-02-20T06:45:00.000Z'

    const result = updateJangarManifests({
      imageName,
      tag: 'new-tag',
      digest: 'sha256:newdigest',
      rolloutTimestamp,
      kustomizationPath: relative(repoRoot, fixture.kustomizationPath),
      serviceManifestPath: relative(repoRoot, fixture.serviceManifestPath),
      workerManifestPath: relative(repoRoot, fixture.workerManifestPath),
    })

    const workerManifest = YAML.parse(readFileSync(fixture.workerManifestPath, 'utf8')) as {
      metadata?: { annotations?: Record<string, string> }
    }

    expect(workerManifest.metadata?.annotations?.['kubectl.kubernetes.io/restartedAt']).toBe(rolloutTimestamp)
    expect(result.changed.worker).toBe(true)

    rmSync(fixture.dir, { recursive: true, force: true })
  })

  it('updates source rollout truth env when revision metadata is provided', () => {
    const fixture = createFixture()
    const sourceHeadSha = '9e7b87d813d9732d44586e213d9f47ec178f705a'
    const gitopsRevision = '9e7b87d8'

    const result = updateJangarManifests({
      imageName,
      tag: 'truth-tag',
      digest: 'sha256:truthdigest',
      sourceHeadSha,
      gitopsRevision,
      rolloutTimestamp: '2026-02-20T06:50:00.000Z',
      kustomizationPath: relative(repoRoot, fixture.kustomizationPath),
      serviceManifestPath: relative(repoRoot, fixture.serviceManifestPath),
    })

    const serviceManifest = YAML.parse(readFileSync(fixture.serviceManifestPath, 'utf8')) as {
      spec?: { template?: { spec?: { containers?: Array<{ env?: Array<{ name?: string; value?: string }> }> } } }
    }
    const env = serviceManifest.spec?.template?.spec?.containers?.[0]?.env

    expect(env).toContainEqual({
      name: 'JANGAR_SOURCE_HEAD_SHA',
      value: sourceHeadSha,
    })
    expect(env).toContainEqual({
      name: 'JANGAR_GITOPS_REVISION',
      value: gitopsRevision,
    })
    expect(result.changed.sourceHeadShaEnv).toBe(true)
    expect(result.changed.gitopsRevisionEnv).toBe(true)

    rmSync(fixture.dir, { recursive: true, force: true })
  })

  it('inserts digest when digest field is missing and normalizes repo digests', () => {
    const fixture = createFixture()
    const kustomizationWithoutDigest = `images:
  - name: registry.ide-newton.ts.net/lab/jangar
    newTag: "old-tag"
`
    writeFileSync(fixture.kustomizationPath, kustomizationWithoutDigest, 'utf8')

    updateJangarManifests({
      imageName,
      tag: 'digest-add',
      digest: 'registry.ide-newton.ts.net/lab/jangar@sha256:abc123',
      rolloutTimestamp: '2026-02-20T07:00:00.000Z',
      kustomizationPath: relative(repoRoot, fixture.kustomizationPath),
      serviceManifestPath: relative(repoRoot, fixture.serviceManifestPath),
    })

    const kustomization = YAML.parse(readFileSync(fixture.kustomizationPath, 'utf8')) as {
      images?: Array<{ name?: string; newTag?: string; digest?: string }>
    }
    expect(kustomization.images?.[0]).toEqual({
      name: imageName,
      newTag: 'digest-add',
      digest: 'sha256:abc123',
    })

    rmSync(fixture.dir, { recursive: true, force: true })
  })

  it('updates agents values when agents-values-path is provided', () => {
    const fixture = createFixture()
    const rolloutTimestamp = '2026-02-20T08:00:00.000Z'

    const result = updateJangarManifests({
      imageName,
      tag: 'agents-tag',
      digest: 'sha256:agentsdigest',
      rolloutTimestamp,
      kustomizationPath: relative(repoRoot, fixture.kustomizationPath),
      serviceManifestPath: relative(repoRoot, fixture.serviceManifestPath),
      agentsValuesPath: relative(repoRoot, fixture.agentsValuesPath),
    })

    const values = readFileSync(fixture.agentsValuesPath, 'utf8')
    const parsed = YAML.parse(values) as {
      image?: { repository?: string; tag?: string; digest?: string }
      runner?: { image?: { repository?: string; tag?: string; digest?: string } }
      controlPlane?: { image?: { repository?: string; tag?: string; digest?: string } }
    }

    expect(parsed.image).toEqual({
      repository: 'registry.ide-newton.ts.net/lab/jangar',
      tag: 'agents-tag',
      digest: 'sha256:agentsdigest',
    })
    expect(parsed.runner?.image).toEqual({
      repository: 'registry.ide-newton.ts.net/lab/jangar',
      tag: 'agents-tag',
      digest: 'sha256:agentsdigest',
    })
    expect(parsed.controlPlane?.image).toEqual({
      repository: 'registry.ide-newton.ts.net/lab/jangar-control-plane',
      tag: 'keep-tag',
      digest: 'sha256:keep',
    })
    expect(result.changed.agentsValues).toBe(true)

    rmSync(fixture.dir, { recursive: true, force: true })
  })

  it('updates control-plane values when control-plane image metadata is provided', () => {
    const fixture = createFixture()

    const result = updateJangarManifests({
      imageName,
      tag: 'agents-tag',
      digest: 'sha256:agentsdigest',
      controlPlaneImageName: 'registry.ide-newton.ts.net/lab/jangar-control-plane',
      controlPlaneDigest: 'sha256:controlplanedigest',
      rolloutTimestamp: '2026-02-20T08:30:00.000Z',
      kustomizationPath: relative(repoRoot, fixture.kustomizationPath),
      serviceManifestPath: relative(repoRoot, fixture.serviceManifestPath),
      agentsValuesPath: relative(repoRoot, fixture.agentsValuesPath),
    })

    const values = readFileSync(fixture.agentsValuesPath, 'utf8')
    const parsed = YAML.parse(values) as {
      controlPlane?: { image?: { repository?: string; tag?: string; digest?: string } }
    }

    expect(parsed.controlPlane?.image).toEqual({
      repository: 'registry.ide-newton.ts.net/lab/jangar-control-plane',
      tag: 'agents-tag',
      digest: 'sha256:controlplanedigest',
    })
    expect(result.changed.agentsValues).toBe(true)

    rmSync(fixture.dir, { recursive: true, force: true })
  })

  it('publishes source-serving proof env to service and agents control-plane values', () => {
    const fixture = createFixture()
    const sourceHeadSha = '9e7b87d813d9732d44586e213d9f47ec178f705a'
    const gitopsRevision = '9e7b87d8'
    const controlPlaneDigest = 'sha256:controlplanedigest'

    const result = updateJangarManifests({
      imageName,
      tag: 'agents-tag',
      digest: 'sha256:agentsdigest',
      controlPlaneImageName: 'registry.ide-newton.ts.net/lab/jangar-control-plane',
      controlPlaneDigest,
      sourceHeadSha,
      gitopsRevision,
      sourceCiRunId: '123456',
      sourceCiConclusion: 'success',
      rolloutTimestamp: '2026-02-20T08:45:00.000Z',
      kustomizationPath: relative(repoRoot, fixture.kustomizationPath),
      serviceManifestPath: relative(repoRoot, fixture.serviceManifestPath),
      agentsValuesPath: relative(repoRoot, fixture.agentsValuesPath),
    })

    const serviceManifest = YAML.parse(readFileSync(fixture.serviceManifestPath, 'utf8')) as {
      spec?: { template?: { spec?: { containers?: Array<{ env?: Array<{ name?: string; value?: string }> }> } } }
    }
    const values = YAML.parse(readFileSync(fixture.agentsValuesPath, 'utf8')) as {
      controlPlane?: { env?: { vars?: Record<string, string> } }
    }
    const serviceEnv = serviceManifest.spec?.template?.spec?.containers?.[0]?.env
    const expectedProofEnv = {
      JANGAR_SOURCE_HEAD_SHA: sourceHeadSha,
      JANGAR_GITOPS_REVISION: gitopsRevision,
      JANGAR_SOURCE_CI_RUN_ID: '123456',
      JANGAR_SOURCE_CI_CONCLUSION: 'success',
      JANGAR_MANIFEST_IMAGE_DIGEST: controlPlaneDigest,
      JANGAR_SERVING_BUILD_COMMIT: sourceHeadSha,
      JANGAR_SERVING_IMAGE_DIGEST: controlPlaneDigest,
    }

    for (const [name, value] of Object.entries(expectedProofEnv)) {
      expect(serviceEnv).toContainEqual({ name, value })
      expect(values.controlPlane?.env?.vars?.[name]).toBe(value)
    }
    expect(result.changed).toMatchObject({
      sourceHeadShaEnv: true,
      gitopsRevisionEnv: true,
      sourceCiRunIdEnv: true,
      sourceCiConclusionEnv: true,
      manifestImageDigestEnv: true,
      servingBuildCommitEnv: true,
      servingImageDigestEnv: true,
      agentsValues: true,
    })

    rmSync(fixture.dir, { recursive: true, force: true })
  })
})
