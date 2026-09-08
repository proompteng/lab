import { afterEach, describe, expect, it } from 'vitest'

import { assertClusterScopedForWildcard, parseNamespaceScopeEnv } from '~/server/namespace-scope'

const original = process.env.JANGAR_RBAC_CLUSTER_SCOPED
const originalEnv = {
  JANGAR_WORKFLOW_RELIABILITY_NAMESPACES: process.env.JANGAR_WORKFLOW_RELIABILITY_NAMESPACES,
}

afterEach(() => {
  if (original == null) {
    delete process.env.JANGAR_RBAC_CLUSTER_SCOPED
  } else {
    process.env.JANGAR_RBAC_CLUSTER_SCOPED = original
  }

  if (originalEnv.JANGAR_WORKFLOW_RELIABILITY_NAMESPACES == null) {
    delete process.env.JANGAR_WORKFLOW_RELIABILITY_NAMESPACES
  } else {
    process.env.JANGAR_WORKFLOW_RELIABILITY_NAMESPACES = originalEnv.JANGAR_WORKFLOW_RELIABILITY_NAMESPACES
  }
})

describe('namespace scope', () => {
  it('throws when wildcard namespaces are used without cluster RBAC', () => {
    delete process.env.JANGAR_RBAC_CLUSTER_SCOPED
    expect(() => assertClusterScopedForWildcard(['*'], 'workflow reliability status')).toThrow(
      "[jangar] workflow reliability status namespaces '*' require JANGAR_RBAC_CLUSTER_SCOPED=true",
    )
  })

  it('allows wildcard namespaces when cluster RBAC is enabled', () => {
    process.env.JANGAR_RBAC_CLUSTER_SCOPED = 'true'
    expect(() => assertClusterScopedForWildcard(['*'], 'workflow reliability status')).not.toThrow()
  })

  it('allows non-wildcard namespaces without cluster RBAC', () => {
    delete process.env.JANGAR_RBAC_CLUSTER_SCOPED
    expect(() => assertClusterScopedForWildcard(['agents'], 'workflow reliability status')).not.toThrow()
  })

  it('parses CSV namespaces', () => {
    process.env.JANGAR_WORKFLOW_RELIABILITY_NAMESPACES = 'agents,agents-ci'
    expect(
      parseNamespaceScopeEnv('JANGAR_WORKFLOW_RELIABILITY_NAMESPACES', {
        fallback: ['default'],
        label: 'workflow reliability status',
      }),
    ).toEqual(['agents', 'agents-ci'])
  })

  it('parses JSON array namespaces', () => {
    process.env.JANGAR_WORKFLOW_RELIABILITY_NAMESPACES = '["agents","agents-ci"]'
    expect(
      parseNamespaceScopeEnv('JANGAR_WORKFLOW_RELIABILITY_NAMESPACES', {
        fallback: ['default'],
        label: 'workflow reliability status',
      }),
    ).toEqual(['agents', 'agents-ci'])
  })

  it('rejects invalid JSON without falling back to CSV', () => {
    process.env.JANGAR_WORKFLOW_RELIABILITY_NAMESPACES = '["agents",]'
    expect(() =>
      parseNamespaceScopeEnv('JANGAR_WORKFLOW_RELIABILITY_NAMESPACES', {
        fallback: ['default'],
        label: 'workflow reliability status',
      }),
    ).toThrow(/invalid JANGAR_WORKFLOW_RELIABILITY_NAMESPACES JSON/i)
  })

  it('rejects namespaces containing whitespace', () => {
    process.env.JANGAR_WORKFLOW_RELIABILITY_NAMESPACES = 'agents,agents ci'
    expect(() =>
      parseNamespaceScopeEnv('JANGAR_WORKFLOW_RELIABILITY_NAMESPACES', {
        fallback: ['default'],
        label: 'workflow reliability status',
      }),
    ).toThrow(/must not contain whitespace/i)
  })

  it('rejects invalid DNS label namespaces', () => {
    process.env.JANGAR_WORKFLOW_RELIABILITY_NAMESPACES = 'Agents'
    expect(() =>
      parseNamespaceScopeEnv('JANGAR_WORKFLOW_RELIABILITY_NAMESPACES', {
        fallback: ['default'],
        label: 'workflow reliability status',
      }),
    ).toThrow(/must be a valid DNS label/i)
  })

  it('rejects empty parsed list', () => {
    process.env.JANGAR_WORKFLOW_RELIABILITY_NAMESPACES = ',,,'
    expect(() =>
      parseNamespaceScopeEnv('JANGAR_WORKFLOW_RELIABILITY_NAMESPACES', {
        fallback: ['default'],
        label: 'workflow reliability status',
      }),
    ).toThrow(/cannot be empty/i)
  })

  it('rejects empty env var value', () => {
    process.env.JANGAR_WORKFLOW_RELIABILITY_NAMESPACES = '   '
    expect(() =>
      parseNamespaceScopeEnv('JANGAR_WORKFLOW_RELIABILITY_NAMESPACES', {
        fallback: ['default'],
        label: 'workflow reliability status',
      }),
    ).toThrow(/set but empty/i)
  })

  it('dedupes namespaces stably', () => {
    process.env.JANGAR_WORKFLOW_RELIABILITY_NAMESPACES = 'agents,agents,agents-ci'
    expect(
      parseNamespaceScopeEnv('JANGAR_WORKFLOW_RELIABILITY_NAMESPACES', {
        fallback: ['default'],
        label: 'workflow reliability status',
      }),
    ).toEqual(['agents', 'agents-ci'])
  })
})
