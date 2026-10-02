import { describe, expect, it } from 'vitest'

import { requireReadOnlyKubectlArgs } from './cli-policy'

describe('read-only kubectl namespace flags', () => {
  it.each([
    ['-n', 'example', 'get', 'pods'],
    ['--namespace', 'example', 'logs', 'pod/example'],
    ['--namespace=example', 'auth', 'whoami'],
    ['-nexample', 'rollout', 'status', 'deployment/example'],
  ])('accepts namespace placement before a read-only command: %j', (...args) => {
    expect(() => requireReadOnlyKubectlArgs(args)).not.toThrow()
  })

  it.each([
    ['-n', 'example', 'exec', 'pod/example', '--', 'echo'],
    ['--namespace=example', 'delete', 'pod/example'],
    ['-nexample', 'rollout', 'restart', 'deployment/example'],
    ['-n', 'example', 'auth', 'reconcile', '-f', 'binding.yaml'],
    ['--namespace'],
    ['--namespace='],
    ['-n', '--context=other', 'get', 'pods'],
    ['--unknown', 'get', 'pods'],
  ])('rejects mutations and ambiguous flags: %j', (...args) => {
    expect(() => requireReadOnlyKubectlArgs(args)).toThrow()
  })
})
