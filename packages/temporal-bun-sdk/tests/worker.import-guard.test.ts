import { join } from 'node:path'

import { expect, test } from 'bun:test'

import { defaultWorkflowImportPolicy, type WorkflowImportPolicy } from '../src/config'
import { guardWorkflowImports } from '../src/workflow/import-guard'

const fixture = (file: string) =>
  join(import.meta.dir, 'fixtures', 'workflows', 'import-guard', file)

const clonePolicy = (policy: WorkflowImportPolicy): WorkflowImportPolicy => ({
  allow: [...policy.allow],
  block: [...policy.block],
  ignore: [...policy.ignore],
  unsafeImportsAllowed: policy.unsafeImportsAllowed,
})

test('fails fast on blocked built-in imports', async () => {
  await expect(guardWorkflowImports(fixture('disallowed-fs.ts'), defaultWorkflowImportPolicy)).rejects.toThrow(
    /fs/,
  )
})

test('allows safe built-ins by default', async () => {
  await expect(guardWorkflowImports(fixture('allowed.ts'), defaultWorkflowImportPolicy)).resolves.toBeUndefined()
})

test('honors allow list overrides', async () => {
  const policy = clonePolicy(defaultWorkflowImportPolicy)
  policy.allow.push('fs')
  policy.block = policy.block.filter((entry) => entry !== 'fs')

  await expect(guardWorkflowImports(fixture('disallowed-fs.ts'), policy)).resolves.toBeUndefined()
})

test('ignores specifiers on the ignore list', async () => {
  const policy = clonePolicy(defaultWorkflowImportPolicy)
  policy.ignore.push('fs')

  await expect(guardWorkflowImports(fixture('disallowed-fs.ts'), policy)).resolves.toBeUndefined()
})

test('recursively scans nested workflow imports', async () => {
  await expect(guardWorkflowImports(fixture('nested-entry.ts'), defaultWorkflowImportPolicy)).rejects.toThrow(/path/)
})

test('escape hatch bypasses the guard', async () => {
  const policy = clonePolicy(defaultWorkflowImportPolicy)
  policy.unsafeImportsAllowed = true

  await expect(guardWorkflowImports(fixture('disallowed-fs.ts'), policy)).resolves.toBeUndefined()
})
