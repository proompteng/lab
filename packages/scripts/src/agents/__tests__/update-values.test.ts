import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __private, updateAgentsValuesFromCliOptions } from '../update-values'

const sha = 'a'.repeat(40)
const controllerDigest = `sha256:${'1'.repeat(64)}`
const controlPlaneDigest = `sha256:${'2'.repeat(64)}`
const runnerDigest = `sha256:${'3'.repeat(64)}`
const agentsShellDigest = `sha256:${'4'.repeat(64)}`

describe('agents update-values helper', () => {
  it('writes promoted controller, control-plane, and runner multi-arch digests', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agents-update-values-'))
    const valuesPath = join(dir, 'values.yaml')
    try {
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
runner:
  image:
    repository: old/runner
    tag: old
    digest: sha256:old-runner
agentsShell:
  image:
    repository: old/shell
    tag: old
    digest: sha256:old-shell
controllers:
  image:
    repository: old/controller
    tag: old
    digest: sha256:old-controller
`,
      )

      updateAgentsValuesFromCliOptions({
        valuesPath,
        tag: 'abc12345',
        controllerRepository: 'registry.example/lab/agents-controller',
        controllerDigest,
        controlPlaneRepository: 'registry.example/lab/agents-control-plane',
        controlPlaneDigest,
        agentsShellRepository: 'registry.example/lab/agents-shell',
        agentsShellDigest,
        runnerRepository: 'registry.example/lab/agents-codex-runner',
        runnerDigest,
        sourceSha: sha,
        runId: '123456',
        ciConclusion: 'success',
      })

      const updated = readFileSync(valuesPath, 'utf8')
      expect(updated).toContain('repository: registry.example/lab/agents-controller')
      expect(updated).toContain('repository: registry.example/lab/agents-control-plane')
      expect(updated).toContain('repository: registry.example/lab/agents-shell')
      expect(updated).toContain('repository: registry.example/lab/agents-codex-runner')
      expect(updated).toContain('tag: abc12345')
      expect(updated).toContain(`digest: ${controllerDigest}`)
      expect(updated).toContain(`digest: ${controlPlaneDigest}`)
      expect(updated).toContain(`digest: ${agentsShellDigest}`)
      expect(updated).toContain(`digest: ${runnerDigest}`)
      expect(updated).toContain(`AGENTS_SOURCE_HEAD_SHA: ${sha}`)
      expect(updated).toContain('AGENTS_SOURCE_CI_RUN_ID: "123456"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('normalizes repository-qualified digests and rejects malformed digests', () => {
    expect(__private.normalizeDigest(`registry.example/repo@${controllerDigest}`)).toBe(controllerDigest)
    expect(() =>
      updateAgentsValuesFromCliOptions({
        valuesPath: 'argocd/applications/agents/values.yaml',
        tag: 'abc12345',
        controllerRepository: 'registry.example/lab/agents-controller',
        controllerDigest: 'sha256:not-valid',
        controlPlaneRepository: 'registry.example/lab/agents-control-plane',
        controlPlaneDigest,
        agentsShellRepository: 'registry.example/lab/agents-shell',
        agentsShellDigest,
        runnerRepository: 'registry.example/lab/agents-codex-runner',
        runnerDigest,
        sourceSha: sha,
      }),
    ).toThrow('Invalid digest for controllerDigest')
  })
})
