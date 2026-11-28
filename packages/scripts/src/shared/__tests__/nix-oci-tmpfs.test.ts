import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'bun:test'
import { parseDocument } from 'yaml'

const workflowDir = new URL('../../../../../.github/workflows/', import.meta.url)
const buildWorkflow = 'nix-oci-build-common.yml'
const readWorkflow = (filename: string) => parseDocument(readFileSync(new URL(filename, workflowDir), 'utf8'))

const callerTmpfs = (filename: string, job: string) => {
  const workflow = readWorkflow(filename)
  expect(workflow.getIn(['jobs', job, 'uses'])).toBe(`./.github/workflows/${buildWorkflow}`)
  return workflow.getIn(['jobs', job, 'with', 'tmpfs'])
}

describe('Nix OCI build runner storage', () => {
  it('uses the same opt-in for both architectures and defaults to Ceph RBD', () => {
    const workflow = readWorkflow(buildWorkflow)
    const input = ['on', 'workflow_call', 'inputs', 'tmpfs']
    const platform = ['jobs', 'build-platform']

    expect(workflow.getIn([...input, 'type'])).toBe('boolean')
    expect(workflow.getIn([...input, 'default'])).toBe(false)
    expect(workflow.getIn([...platform, 'strategy', 'matrix', 'include', 0, 'runner'])).toBe('arc-amd64')
    expect(workflow.getIn([...platform, 'strategy', 'matrix', 'include', 1, 'runner'])).toBe('arc-arm64')
    expect(workflow.getIn([...platform, 'runs-on'])).toBe(
      "${{ format('{0}{1}', matrix.runner, inputs.tmpfs && '-tmpfs' || '') }}",
    )
  })

  it.each([
    ['bumba-ci.yml', 'nix-image'],
    ['froussard-ci.yml', 'nix-image'],
    ['headlamp-ci.yml', 'nix-image'],
    ['headlamp-ci.yml', 'nix-image-pr'],
    ['hermes-toolchain-build-push.yml', 'nix-image'],
    ['oirat-ci.yml', 'nix-image'],
    ['product-nix-images.yml', 'build-docs'],
    ['product-nix-images.yml', 'build-synthesis'],
    ['sag-build-push.yaml', 'nix-image'],
    ['symphony-build-push.yaml', 'nix-image'],
    ['torghut-build-push.yaml', 'nix-image'],
    ['torghut-hyperliquid-feed-build-push.yaml', 'nix-image'],
    ['torghut-notebook-build-push.yaml', 'nix-image'],
    ['torghut-ta-build-push.yaml', 'nix-image'],
    ['torghut-webull-feed-build-push.yaml', 'nix-image'],
  ])('%s / %s opts into standard tmpfs', (filename, job) => {
    expect(callerTmpfs(filename, job)).toBe(true)
  })

  it.each([
    ['arc-runner-build-push.yml', 'nix-image'],
    ['attic-build-push.yaml', 'build-and-push'],
    ['attic-build-push.yaml', 'validate'],
    ['jangar-build-push.yaml', 'nix-image'],
    ['ofz.yaml', 'build-ofz'],
    ['opencode-ci.yml', 'image'],
    ['product-nix-images.yml', 'build-app'],
    ['product-nix-images.yml', 'build-proompteng'],
    ['relay.yml', 'image'],
  ])('%s / %s stays on Ceph RBD', (filename, job) => {
    expect([false, undefined]).toContain(callerTmpfs(filename, job))
  })
})
