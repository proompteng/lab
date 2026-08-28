import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

type Rule = {
  resources?: string[]
  verbs?: string[]
}

type Role = {
  kind?: string
  metadata?: { name?: string }
  rules?: Rule[]
}

const rbac = Bun.YAML.parse(
  readFileSync(new URL('../../../../argocd/applications/tengri/rbac.yaml', import.meta.url), 'utf8'),
) as Role[]

test('Tengri can watch Secret and PVC deletion to completion', () => {
  const role = rbac.find((document) => document.kind === 'Role' && document.metadata?.name === 'tengri')
  const cleanupRule = role?.rules?.find(
    (rule) => rule.resources?.includes('persistentvolumeclaims') && rule.resources.includes('secrets'),
  )

  expect(cleanupRule?.verbs).toEqual(['delete', 'get', 'list', 'patch', 'watch'])
})
