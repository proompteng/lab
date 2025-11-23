import path from 'node:path'

import { expect, test } from 'bun:test'

import { temporalDefaults, type WorkflowImportPolicy } from '../src/config'
import { assertWorkflowImportsDeterministic, WorkflowImportGuardError } from '../src/workflow/import-guard'

const fixture = (file: string) => path.join(__dirname, 'fixtures', 'workflows', 'import-guard', file)

const clonePolicy = (overrides: Partial<WorkflowImportPolicy> = {}): WorkflowImportPolicy => ({
  allow: [...temporalDefaults.workflowImportPolicy.allow],
  block: [...temporalDefaults.workflowImportPolicy.block],
  ignore: [...temporalDefaults.workflowImportPolicy.ignore],
  unsafeAllow: temporalDefaults.workflowImportPolicy.unsafeAllow,
  ...overrides,
})

test('default policy blocks nondeterministic built-ins', async () => {
  const policy = clonePolicy()
  const promise = assertWorkflowImportsDeterministic(fixture('blocked.ts'), policy)

  await expect(promise).rejects.toThrow(WorkflowImportGuardError)
  await promise.catch((error) => {
    expect(error).toBeInstanceOf(WorkflowImportGuardError)
    if (error instanceof WorkflowImportGuardError) {
      const specifiers = error.violations.map((violation) => violation.specifier)
      expect(specifiers).toContain('fs')
      expect(specifiers).toContain('crypto')
    }
  })
})

test('allowed built-ins pass the guard', async () => {
  const policy = clonePolicy()
  await expect(assertWorkflowImportsDeterministic(fixture('allowed.ts'), policy)).resolves.toBeUndefined()
})

test('allow list override unblocks selected built-ins', async () => {
  const policy = clonePolicy({
    allow: [...temporalDefaults.workflowImportPolicy.allow, 'fs', 'crypto'],
  })

  await expect(assertWorkflowImportsDeterministic(fixture('blocked.ts'), policy)).resolves.toBeUndefined()
})

test('ignore list skips checks for specified modules', async () => {
  const policy = clonePolicy({
    ignore: ['fs', 'crypto'],
  })

  await expect(assertWorkflowImportsDeterministic(fixture('blocked.ts'), policy)).resolves.toBeUndefined()
})

test('escape hatch bypasses guard when enabled', async () => {
  const policy = clonePolicy({ unsafeAllow: true })

  await expect(assertWorkflowImportsDeterministic(fixture('blocked.ts'), policy)).resolves.toBeUndefined()
})
