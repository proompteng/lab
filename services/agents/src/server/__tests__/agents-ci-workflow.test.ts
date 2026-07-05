import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

describe('agents-ci workflow', () => {
  it('builds local Agents integration images from Nix archives', () => {
    const workflow = readFileSync(new URL('../../../../../.github/workflows/agents-ci.yml', import.meta.url), 'utf8')

    expect(workflow).toContain('Build and preload local Nix Agents image archives into kind')
    expect(workflow).toContain('nix build ".#${1}" --print-out-paths --no-link')
    expect(workflow).toContain(
      'build_nix_image_archive "${CONTROL_PLANE_IMAGE}" agents-control-plane-image CONTROL_PLANE_ARCHIVE',
    )
    expect(workflow).toContain(
      'build_nix_image_archive "${CONTROLLER_IMAGE}" agents-controller-image CONTROLLER_ARCHIVE',
    )
    expect(workflow).toContain('build_nix_image_archive "${RUNNER_IMAGE}" agents-codex-runner-image RUNNER_ARCHIVE')
    expect(workflow).toContain('kind load image-archive')
    expect(workflow).not.toContain('--build-arg "BUN_BASE_IMAGE=')
    expect(workflow).not.toContain('docker build')
    expect(workflow).not.toContain('kind load docker-image')
  })

  it('bounds kubectl downloads so integration runners fail instead of hanging', () => {
    const workflow = readFileSync(new URL('../../../../../.github/workflows/agents-ci.yml', import.meta.url), 'utf8')

    expect(workflow).toContain('--connect-timeout 20')
    expect(workflow).toContain('--max-time 120')
    expect(workflow).toContain('--retry 3')
    expect(workflow).toContain('--retry-all-errors')
    expect(workflow).toContain('timeout -k 30s "${AGENTS_TIMEOUT}" bun run packages/scripts/src/agents/smoke-agents.ts')
  })

  it('runs for Nix Agents image input changes', () => {
    const workflow = readFileSync(new URL('../../../../../.github/workflows/agents-ci.yml', import.meta.url), 'utf8')

    for (const path of [
      'flake.lock',
      'nix/images/agents.nix',
      'nix/images/bun-workspace-service.nix',
      'nix/images/openai-codex-cli.nix',
      'nix/packages.nix',
      'packages/scripts/src/shared/nix-oci-deploy.ts',
      'tsconfig.base.json',
    ]) {
      expect(workflow.split(`- '${path}'`).length - 1).toBe(2)
    }
  })
})
