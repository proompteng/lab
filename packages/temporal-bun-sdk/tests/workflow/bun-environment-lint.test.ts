import { expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assertWorkflowBunEnvironmentSafety,
  lintWorkflowBunEnvironmentSafety,
  WorkflowBunEnvironmentSafetyError,
} from '../../src/workflow/bun-environment-lint'
import { canGuardBunEnvironmentAtRuntime } from '../../src/workflow/guards'
import { WorkerRuntime } from '../../src/worker/runtime'
import { createTestTemporalConfig } from '../helpers/observability'

test('rejects direct, parenthesized, and aliased Bun environment access', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    workflowsPath,
    [
      'const runtime = Bun',
      'const parenthesizedRuntime = ((Bun))',
      'export const direct = () => ((Bun)).env.FLAG',
      'export const indirect = () => runtime.env.FLAG ?? parenthesizedRuntime.env.FLAG',
    ].join('\n'),
  )

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations.some((violation) => violation.details?.memberExpression === 'Bun.env')).toBeTrue()
  expect(violations.filter((violation) => violation.details?.global === 'Bun')).toHaveLength(3)
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('accepts workflow modules without Bun runtime references', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(workflowsPath, 'export const workflow = (flag: string) => flag\n')

  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).resolves.toBeUndefined()
})

test('rejects in-memory workflows when Bun environment interception is unavailable', async () => {
  await expect(assertWorkflowBunEnvironmentSafety({ workflows: [{}] as never })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('worker startup enforces source safety before loading workflows under Bun 1.4', async () => {
  if (canGuardBunEnvironmentAtRuntime()) return

  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(workflowsPath, 'const runtime = Bun\nexport const workflows = runtime.env.FLAG\n')

  await expect(
    WorkerRuntime.create({
      config: createTestTemporalConfig({ workflowGuards: 'strict' }),
      workflowsPath,
      workflowGuards: 'strict',
    }),
  ).rejects.toBeInstanceOf(WorkflowBunEnvironmentSafetyError)
})
