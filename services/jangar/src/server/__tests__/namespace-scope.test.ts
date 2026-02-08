import { afterEach, describe, expect, it } from 'vitest'

import { assertClusterScopedForWildcard } from '~/server/namespace-scope'

const original = process.env.JANGAR_RBAC_CLUSTER_SCOPED

afterEach(() => {
  if (original == null) {
    delete process.env.JANGAR_RBAC_CLUSTER_SCOPED
  } else {
    process.env.JANGAR_RBAC_CLUSTER_SCOPED = original
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
})
