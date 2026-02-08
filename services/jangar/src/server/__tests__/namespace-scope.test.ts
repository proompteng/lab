import { afterEach, describe, expect, it } from 'vitest'

import { assertClusterScopedForWildcard, parseNamespaceScopeEnv } from '~/server/namespace-scope'

const original = process.env.JANGAR_RBAC_CLUSTER_SCOPED
const originalEnv = {
  JANGAR_AGENTS_CONTROLLER_NAMESPACES: process.env.JANGAR_AGENTS_CONTROLLER_NAMESPACES,
}

afterEach(() => {
  if (original == null) {
    delete process.env.JANGAR_RBAC_CLUSTER_SCOPED
  } else {
    process.env.JANGAR_RBAC_CLUSTER_SCOPED = original
  }

  if (originalEnv.JANGAR_AGENTS_CONTROLLER_NAMESPACES == null) {
    delete process.env.JANGAR_AGENTS_CONTROLLER_NAMESPACES
  } else {
    process.env.JANGAR_AGENTS_CONTROLLER_NAMESPACES = originalEnv.JANGAR_AGENTS_CONTROLLER_NAMESPACES
  }
})

describe('namespace scope', () => {
  it('throws when wildcard namespaces are used without cluster RBAC', () => {
    delete process.env.JANGAR_RBAC_CLUSTER_SCOPED
    expect(() => assertClusterScopedForWildcard(['*'], 'agents controller')).toThrow(
      "[jangar] agents controller namespaces '*' require rbac.clusterScoped=true",
    )
  })

  it('allows wildcard namespaces when cluster RBAC is enabled', () => {
    process.env.JANGAR_RBAC_CLUSTER_SCOPED = 'true'
    expect(() => assertClusterScopedForWildcard(['*'], 'agents controller')).not.toThrow()
  })

  it('allows non-wildcard namespaces without cluster RBAC', () => {
    delete process.env.JANGAR_RBAC_CLUSTER_SCOPED
    expect(() => assertClusterScopedForWildcard(['agents'], 'agents controller')).not.toThrow()
  })

  it('parses CSV namespaces', () => {
    process.env.JANGAR_AGENTS_CONTROLLER_NAMESPACES = 'agents,agents-ci'
    expect(
      parseNamespaceScopeEnv('JANGAR_AGENTS_CONTROLLER_NAMESPACES', {
        fallback: ['default'],
        label: 'agents controller',
      }),
    ).toEqual(['agents', 'agents-ci'])
  })

  it('parses JSON array namespaces', () => {
    process.env.JANGAR_AGENTS_CONTROLLER_NAMESPACES = '["agents","agents-ci"]'
    expect(
      parseNamespaceScopeEnv('JANGAR_AGENTS_CONTROLLER_NAMESPACES', {
        fallback: ['default'],
        label: 'agents controller',
      }),
    ).toEqual(['agents', 'agents-ci'])
  })

  it('rejects invalid JSON without falling back to CSV', () => {
    process.env.JANGAR_AGENTS_CONTROLLER_NAMESPACES = '["agents",]'
    expect(() =>
      parseNamespaceScopeEnv('JANGAR_AGENTS_CONTROLLER_NAMESPACES', {
        fallback: ['default'],
        label: 'agents controller',
      }),
    ).toThrow(/invalid JANGAR_AGENTS_CONTROLLER_NAMESPACES JSON/i)
  })

  it('rejects namespaces containing whitespace', () => {
    process.env.JANGAR_AGENTS_CONTROLLER_NAMESPACES = 'agents,agents ci'
    expect(() =>
      parseNamespaceScopeEnv('JANGAR_AGENTS_CONTROLLER_NAMESPACES', {
        fallback: ['default'],
        label: 'agents controller',
      }),
    ).toThrow(/must not contain whitespace/i)
  })

  it('rejects invalid DNS label namespaces', () => {
    process.env.JANGAR_AGENTS_CONTROLLER_NAMESPACES = 'Agents'
    expect(() =>
      parseNamespaceScopeEnv('JANGAR_AGENTS_CONTROLLER_NAMESPACES', {
        fallback: ['default'],
        label: 'agents controller',
      }),
    ).toThrow(/must be a valid DNS label/i)
  })

  it('rejects empty parsed list', () => {
    process.env.JANGAR_AGENTS_CONTROLLER_NAMESPACES = ',,,'
    expect(() =>
      parseNamespaceScopeEnv('JANGAR_AGENTS_CONTROLLER_NAMESPACES', {
        fallback: ['default'],
        label: 'agents controller',
      }),
    ).toThrow(/cannot be empty/i)
  })

  it('rejects empty env var value', () => {
    process.env.JANGAR_AGENTS_CONTROLLER_NAMESPACES = '   '
    expect(() =>
      parseNamespaceScopeEnv('JANGAR_AGENTS_CONTROLLER_NAMESPACES', {
        fallback: ['default'],
        label: 'agents controller',
      }),
    ).toThrow(/set but empty/i)
  })

  it('dedupes namespaces stably', () => {
    process.env.JANGAR_AGENTS_CONTROLLER_NAMESPACES = 'agents,agents,agents-ci'
    expect(
      parseNamespaceScopeEnv('JANGAR_AGENTS_CONTROLLER_NAMESPACES', {
        fallback: ['default'],
        label: 'agents controller',
      }),
    ).toEqual(['agents', 'agents-ci'])
  })
})
