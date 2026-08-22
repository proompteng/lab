import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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

test('rejects import.meta.env and Bun access through every global-object alias', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    workflowsPath,
    [
      'const runtime = globalThis.Bun',
      "const bracketRuntime = globalThis['Bun']",
      'const nodeGlobalRuntime = global.Bun',
      "const selfRuntime = self['Bun']",
      'const meta = import.meta',
      'export const direct = () => import.meta.env.FLAG',
      'export const parenthesized = () => ((import.meta)).env.FLAG',
      'export const indirect = () =>',
      '  runtime.env.FLAG ?? bracketRuntime.env.FLAG ?? nodeGlobalRuntime.env.FLAG ?? selfRuntime.env.FLAG ?? meta.env.FLAG',
    ].join('\n'),
  )

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(
    violations.filter((violation) => violation.details?.memberExpression === 'import.meta.env'),
  ).toHaveLength(2)
  expect(violations.some((violation) => violation.details?.memberExpression === 'import.meta')).toBeTrue()
  expect(
    violations.filter((violation) => violation.details?.memberExpression === 'globalThis.Bun').length,
  ).toBeGreaterThanOrEqual(2)
  expect(violations.some((violation) => violation.details?.memberExpression === 'global.Bun')).toBeTrue()
  expect(violations.some((violation) => violation.details?.memberExpression === 'self.Bun')).toBeTrue()
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('rejects captures of global objects without flagging safe property captures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    workflowsPath,
    [
      'const root = globalThis',
      'const parenthesizedRoot = ((globalThis))',
      'const nodeGlobal = global',
      'const browserGlobal = self',
      "const safeProperty = globalThis['crypto']",
      'export const direct = () => root.Bun.env.FLAG',
      'export const parenthesized = () => parenthesizedRoot.Bun.env.FLAG',
      'export const node = () => nodeGlobal.Bun.env.FLAG',
      'export const browser = () => browserGlobal.Bun.env.FLAG',
      'export const safe = () => safeProperty',
    ].join('\n'),
  )

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations.filter((violation) => violation.rule === 'capture-global')).toHaveLength(4)
  expect(violations.map((violation) => violation.details?.global)).toEqual(
    expect.arrayContaining(['globalThis', 'global', 'self']),
  )
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('accepts locally shadowed global-object alias names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    workflowsPath,
    [
      "const self = { Bun: { env: { FLAG: 'local' } } }",
      'export const local = () => self.Bun.env.FLAG',
      'export const parameters = (global: typeof self, globalThis: typeof self) =>',
      '  global.Bun.env.FLAG ?? globalThis.Bun.env.FLAG',
    ].join('\n'),
  )

  expect(await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).toEqual([])
})

test('rejects reflective access to the Bun global', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    workflowsPath,
    [
      "const object = { value: 'ok' }",
      "export const direct = () => Reflect.get(globalThis, 'Bun').env.FLAG",
      "export const bracket = () => Reflect['get'](globalThis, 'Bun').env.FLAG",
      "export const nodeGlobal = () => Reflect.get(global, 'Bun').env.FLAG",
      "export const browserGlobal = () => Reflect.get(self, 'Bun').env.FLAG",
      "export const safeObjectLookup = () => Reflect.get(object, 'value')",
      "export const safeGlobalLookup = () => Reflect.get(globalThis, 'crypto')",
    ].join('\n'),
  )

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations.filter((violation) => violation.details?.memberExpression === 'Reflect.get')).toHaveLength(4)
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('rejects direct, indirect, and globalThis dynamic code access', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    workflowsPath,
    [
      "export const directEval = () => eval('Bun').env.FLAG",
      "export const indirectEval = () => (0, eval)('Bun').env.FLAG",
      "export const directFunction = () => Function('return Bun.env.FLAG')()",
      "export const indirectFunction = () => (0, Function)('return Bun.env.FLAG')()",
      "export const globalEval = () => globalThis.eval('Bun').env.FLAG",
      "export const globalFunction = () => globalThis['Function']('return Bun.env.FLAG')()",
      "export const reflectiveEval = () => Reflect.get(globalThis, 'eval')('Bun').env.FLAG",
    ].join('\n'),
  )

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        rule: 'deny-global',
        message: 'Disallowed global in workflow module: eval()',
        details: { global: 'eval' },
      }),
      expect.objectContaining({
        rule: 'deny-global',
        message: 'Disallowed indirect global reference in workflow module: eval',
        details: { global: 'eval' },
      }),
      expect.objectContaining({
        rule: 'deny-global',
        message: 'Disallowed global in workflow module: Function()',
        details: { global: 'Function' },
      }),
      expect.objectContaining({
        rule: 'deny-global',
        message: 'Disallowed indirect global reference in workflow module: Function',
        details: { global: 'Function' },
      }),
      expect.objectContaining({
        rule: 'deny-member-expression',
        details: { memberExpression: 'globalThis.eval' },
      }),
      expect.objectContaining({
        rule: 'deny-member-expression',
        details: { memberExpression: 'globalThis[...]', global: 'Function' },
      }),
      expect.objectContaining({
        rule: 'deny-member-expression',
        details: { memberExpression: 'Reflect.get', global: 'eval' },
      }),
    ]),
  )
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('accepts a capture of the built-in Function apply implementation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(workflowsPath, 'export const safeApply = Function.prototype.apply\n')

  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).resolves.toBeUndefined()
})

test('rejects computed Bun global access and fails closed for dynamic keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    workflowsPath,
    [
      "const bunKey = 'Bun'",
      "let reassignedKey = 'crypto'",
      "reassignedKey = 'Bun'",
      "const Symbol = { for: () => 'Bun' }",
      "const shadowedSymbolKey = Symbol.for('@fixture/not-a-symbol')",
      'export const staticKey = () => globalThis[bunKey].env.FLAG',
      'export const reassigned = () => globalThis[reassignedKey].env.FLAG',
      'export const shadowedSymbol = () => globalThis[shadowedSymbolKey].env.FLAG',
      'export const dynamic = (key: string) => globalThis[key]',
      'export const reflective = (key: string) => Reflect.get(globalThis, key)',
    ].join('\n'),
  )

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations.filter((violation) => violation.details?.memberExpression === 'globalThis[...]')).toHaveLength(4)
  expect(violations.some((violation) => violation.details?.memberExpression === 'Reflect.get')).toBeTrue()
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('accepts computed global keys proven not to resolve to Bun', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    workflowsPath,
    [
      "const storeKey = 'effect/FiberCurrent'",
      "const symbolKey = Symbol.for('@fixture/workflow-state')",
      'export const workflow = () => [globalThis[storeKey], globalThis[symbolKey]]',
      'export const reflective = () => Reflect.get(globalThis, storeKey)',
    ].join('\n'),
  )

  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).resolves.toBeUndefined()
})

test('ignores erased type-only imports when proving workflow source safety', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    workflowsPath,
    [
      "import type { Activity } from './activity'",
      "import { type Helper } from './helper'",
      "export type { Exported } from './exported'",
      'export const workflow = (_input: Activity | Helper) => undefined',
    ].join('\n'),
  )
  for (const [name, exportedType] of [
    ['activity', 'Activity'],
    ['helper', 'Helper'],
    ['exported', 'Exported'],
  ]) {
    await writeFile(
      join(dir, `${name}.ts`),
      `import { randomBytes } from 'node:crypto'\nexport type ${exportedType} = ReturnType<typeof randomBytes>\n`,
    )
  }

  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).resolves.toBeUndefined()
})

test('follows bare package imports before declaring workflow source safe', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const helperDir = join(dir, 'node_modules', '@fixture', 'workflow-helper')
  const workflowsPath = join(dir, 'workflows.ts')
  await mkdir(helperDir, { recursive: true })
  await writeFile(
    join(helperDir, 'package.json'),
    JSON.stringify({ name: '@fixture/workflow-helper', type: 'module', exports: './index.ts' }),
  )
  await writeFile(join(helperDir, 'index.ts'), 'export const flag = globalThis.Bun.env.FLAG\n')
  await writeFile(
    workflowsPath,
    "import { flag } from '@fixture/workflow-helper'\nexport const workflow = () => flag\n",
  )

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations.some((violation) => violation.details?.memberExpression === 'globalThis.Bun')).toBeTrue()
  await expect(
    WorkerRuntime.create({
      config: createTestTemporalConfig({ workflowGuards: 'strict' }),
      workflowsPath,
      workflowGuards: 'strict',
    }),
  ).rejects.toBeInstanceOf(WorkflowBunEnvironmentSafetyError)
})

test('inspects bare side-effect imports even when package metadata marks them pure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const helperDir = join(dir, 'node_modules', '@fixture', 'workflow-side-effect')
  const workflowsPath = join(dir, 'workflows.ts')
  await mkdir(helperDir, { recursive: true })
  await writeFile(
    join(helperDir, 'package.json'),
    JSON.stringify({
      name: '@fixture/workflow-side-effect',
      type: 'module',
      exports: './index.ts',
      sideEffects: false,
    }),
  )
  await writeFile(join(helperDir, 'index.ts'), 'globalThis.Bun.env.FLAG\n')
  await writeFile(workflowsPath, "import '@fixture/workflow-side-effect'\nexport const workflow = () => undefined\n")

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations.some((violation) => violation.details?.memberExpression === 'globalThis.Bun')).toBeTrue()
})

test('follows tsconfig workspace aliases before declaring workflow source safe', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const sourceDir = join(dir, 'src')
  const workflowsPath = join(dir, 'workflows.ts')
  await mkdir(sourceDir, { recursive: true })
  await writeFile(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@workflow/*': ['src/*'] } } }),
  )
  await writeFile(join(sourceDir, 'helper.ts'), 'export const flag = import.meta.env.FLAG\n')
  await writeFile(
    workflowsPath,
    "import { flag } from '@workflow/helper'\nexport const workflow = () => flag\n",
  )

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations.some((violation) => violation.details?.memberExpression === 'import.meta.env')).toBeTrue()
})

test('fails closed when a bare workflow import cannot be inspected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(workflowsPath, "import { flag } from '@fixture/missing-helper'\nexport const workflow = () => flag\n")

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        rule: 'unresolved-import',
        details: { specifier: '@fixture/missing-helper' },
      }),
    ]),
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
