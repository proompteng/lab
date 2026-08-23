import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Effect } from 'effect'

import {
  assertWorkflowBunEnvironmentSafety,
  lintWorkflowBunEnvironmentSafety,
  WorkflowBunEnvironmentSafetyError,
} from '../../src/workflow/bun-environment-lint'
import { canGuardBunEnvironmentAtRuntime } from '../../src/workflow/guards'
import { createWorker } from '../../src/worker'
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

test('rejects captures and property reads of global objects', async () => {
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
  expect(violations.some((violation) => violation.details?.memberExpression === 'globalThis[...]')).toBeTrue()
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('rejects global-object recovery through method calls, reflection, and argument escapes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    workflowsPath,
    [
      "export const valueOf = () => globalThis.valueOf().Bun.env.FLAG",
      "export const bracketValueOf = () => self['valueOf']().Bun.env.FLAG",
      "export const nestedAlias = () => globalThis.globalThis.Bun.env.FLAG",
      "export const descriptor = () => Object.getOwnPropertyDescriptor(globalThis, 'Bun')?.value.env.FLAG",
      "export const dynamicDescriptor = (key: string) => Object.getOwnPropertyDescriptor(global, key)?.value",
      'export const customEscape = (recover: (root: object) => unknown) => recover(self)',
      'export const spreadEscape = () => ({ ...globalThis })',
    ].join('\n'),
  )

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations.filter((violation) => violation.details?.memberExpression === 'globalThis.valueOf')).toHaveLength(1)
  expect(violations.filter((violation) => violation.details?.memberExpression === 'self.valueOf')).toHaveLength(1)
  expect(violations.some((violation) => violation.details?.memberExpression === 'globalThis.globalThis')).toBeTrue()
  expect(
    violations.filter((violation) => violation.details?.memberExpression === 'Object.getOwnPropertyDescriptor'),
  ).toHaveLength(2)
  expect(violations.filter((violation) => violation.rule === 'capture-global')).toHaveLength(4)
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('rejects global recovery through inherited accessors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    workflowsPath,
    [
      "Object.defineProperty(Object.prototype, 'root', { get() { return this } })",
      'export const inherited = () => globalThis.root.Bun.env.FLAG',
      "export const nativeBinding = () => process.root.binding('fs')",
    ].join('\n'),
  )

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations.some((violation) => violation.details?.memberExpression === 'globalThis.root')).toBeTrue()
  expect(violations.some((violation) => violation.details?.memberExpression === 'process.root')).toBeTrue()
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

test('rejects reflective access to every global-object property', async () => {
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

  expect(violations.filter((violation) => violation.details?.memberExpression === 'Reflect.get')).toHaveLength(5)
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

test('rejects VM modules that can evaluate against the Bun global', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    workflowsPath,
    [
      "import { runInThisContext } from 'node:vm'",
      "import vm from 'vm'",
      "export const nodePrefixed = () => runInThisContext('Bun.env.FLAG')",
      "export const bare = () => vm.runInThisContext('Bun.env.FLAG')",
    ].join('\n'),
  )

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations.filter((violation) => violation.rule === 'deny-import')).toHaveLength(2)
  expect(violations.every((violation) => violation.details?.specifier === 'vm')).toBeTrue()
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('rejects all runtime builtin imports instead of enumerating environment escape modules', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    workflowsPath,
    [
      "import inspector from 'node:inspector'",
      "import repl from 'repl'",
      "import { serialize } from 'bun:jsc'",
      "export const inspect = () => inspector.open()",
      "export const evaluate = () => repl.start()",
      'export const jsc = () => serialize({})',
    ].join('\n'),
  )

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations.filter((violation) => violation.rule === 'deny-import')).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ details: { specifier: 'inspector' } }),
      expect.objectContaining({ details: { specifier: 'repl' } }),
      expect.objectContaining({ details: { specifier: 'bun:jsc' } }),
    ]),
  )
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('rejects child process modules that can recover inherited environment state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    workflowsPath,
    [
      "import { execFileSync } from 'node:child_process'",
      "import childProcess from 'child_process'",
      "export const nodePrefixed = () => execFileSync('printenv', ['WORKFLOW_FLAG'])",
      "export const bare = () => childProcess.execFileSync('printenv', ['WORKFLOW_FLAG'])",
    ].join('\n'),
  )

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations.filter((violation) => violation.rule === 'deny-import')).toHaveLength(2)
  expect(violations.every((violation) => violation.details?.specifier === 'child_process')).toBeTrue()
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('rejects cluster modules that can fork unguarded processes with inherited environment state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    workflowsPath,
    [
      "import nodeCluster from 'node:cluster'",
      "import cluster from 'cluster'",
      "export const nodePrefixed = () => nodeCluster.setupPrimary({ exec: './unscanned-child.js' })",
      "export const bare = () => cluster.fork()",
    ].join('\n'),
  )

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations.filter((violation) => violation.rule === 'deny-import')).toHaveLength(2)
  expect(violations.every((violation) => violation.details?.specifier === 'cluster')).toBeTrue()
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('rejects filesystem modules that can read the process environment outside runtime guards', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    workflowsPath,
    [
      "import { readFileSync } from 'node:fs'",
      "import { readFile } from 'node:fs/promises'",
      "import { tmpdir } from 'node:os'",
      "export const sync = () => readFileSync('/proc/self/environ')",
      "export const async = () => readFile('/proc/self/environ')",
      'export const temp = () => tmpdir()',
    ].join('\n'),
  )

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ rule: 'deny-import', details: { specifier: 'fs' } }),
      expect.objectContaining({ rule: 'deny-import', details: { specifier: 'fs/promises' } }),
      expect.objectContaining({ rule: 'deny-import', details: { specifier: 'os' } }),
    ]),
  )
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('rejects Bun module and FFI imports that expose launch-specific state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    workflowsPath,
    [
      "import { env } from 'bun'",
      "import { dlopen } from 'bun:ffi'",
      'export const direct = () => env.WORKFLOW_FLAG',
      'export const native = dlopen',
    ].join('\n'),
  )

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ rule: 'deny-import', details: { specifier: 'bun:ffi' } }),
      expect.objectContaining({
        rule: 'deny-member-expression',
        details: { memberExpression: 'globalThis.Bun' },
      }),
    ]),
  )
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('rejects process native bindings that bypass guarded environment APIs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    workflowsPath,
    [
      "const nativeFs = process.binding('fs')",
      'const loadBinding = process.binding',
      "export const direct = () => nativeFs.readFileUtf8('/proc/self/environ')",
      "export const aliased = () => loadBinding('fs').readFileUtf8('/proc/self/environ')",
      "export const linked = () => process._linkedBinding('fs')",
      "export const nativeAddon = () => process.dlopen({}, '/tmp/addon.node')",
      "export const dotenv = () => process.loadEnvFile('/tmp/workflow.env')",
    ].join('\n'),
  )

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  for (const memberExpression of [
    'process.binding',
    'process._linkedBinding',
    'process.dlopen',
    'process.loadEnvFile',
  ]) {
    expect(violations.some((violation) => violation.details?.memberExpression === memberExpression)).toBeTrue()
  }
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('rejects process reports that expose launch-specific environment state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    workflowsPath,
    [
      "const reportKey = 'report'",
      "export const direct = () => process.report.getReport().environmentVariables.WORKFLOW_FLAG",
      "export const computed = () => process[reportKey].getReport().environmentVariables.WORKFLOW_FLAG",
      "export const reflected = () => Reflect.get(process, 'report').getReport().environmentVariables.WORKFLOW_FLAG",
    ].join('\n'),
  )

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations.some((violation) => violation.details?.memberExpression === 'process.report')).toBeTrue()
  expect(violations.some((violation) => violation.details?.memberExpression === 'process[...]')).toBeTrue()
  expect(violations.some((violation) => violation.details?.memberExpression === 'Reflect.get')).toBeTrue()
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('rejects runtime module loaders that can recover VM evaluation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    workflowsPath,
    [
      "import { createRequire } from 'node:module'",
      "import importedProcess from 'node:process'",
      "const loaderKey = 'getBuiltinModule'",
      'const loadBuiltin = process.getBuiltinModule',
      "const reflectedLoader = Reflect.get(process, 'getBuiltinModule')",
      'const runtimeRequire = require',
      'const moduleRequire = createRequire(import.meta.url)',
      "export const directBuiltin = () => process.getBuiltinModule('node:vm').runInThisContext('Bun.env.FLAG')",
      "export const computedBuiltin = () => process[loaderKey]('vm').runInThisContext('Bun.env.FLAG')",
      "export const recoveredBuiltin = () => process.valueOf().getBuiltinModule('vm').runInThisContext('Bun.env.FLAG')",
      "export const importedBuiltin = () => importedProcess.getBuiltinModule('vm').runInThisContext('Bun.env.FLAG')",
      "export const aliasedBuiltin = () => loadBuiltin('vm').runInThisContext('Bun.env.FLAG')",
      "export const reflectedBuiltin = () => reflectedLoader('vm').runInThisContext('Bun.env.FLAG')",
      "export const directRequire = () => require('node:vm').runInThisContext('Bun.env.FLAG')",
      "export const aliasedRequire = () => runtimeRequire('vm').runInThisContext('Bun.env.FLAG')",
      "export const createdRequire = () => moduleRequire('vm').runInThisContext('Bun.env.FLAG')",
    ].join('\n'),
  )

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations.some((violation) => violation.details?.memberExpression === 'process.getBuiltinModule')).toBeTrue()
  expect(violations.some((violation) => violation.details?.memberExpression === 'process[...]')).toBeTrue()
  expect(violations.some((violation) => violation.details?.memberExpression === 'process.valueOf')).toBeTrue()
  expect(violations.some((violation) => violation.details?.memberExpression === 'Reflect.get')).toBeTrue()
  expect(violations.some((violation) => violation.details?.memberExpression === 'import.meta.require')).toBeTrue()
  expect(violations.some((violation) => violation.details?.specifier === 'module')).toBeTrue()
  expect(violations.some((violation) => violation.details?.specifier === 'process')).toBeTrue()
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('rejects Bun macro imports across the source graph before bundling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const packageDir = join(dir, 'node_modules', '@fixture', 'macro-helper')
  const workflowsPath = join(dir, 'workflows.ts')
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(dir, 'local-macro.ts'), 'export const readLocalFlag = () => Bun.env.LOCAL_MACRO_FLAG\n')
  await writeFile(
    join(dir, 'local-helper.ts'),
    [
      "import { readLocalFlag } from './local-macro' with { type: 'macro' }",
      'export const localFlag = readLocalFlag()',
    ].join('\n'),
  )
  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: '@fixture/macro-helper', type: 'module', exports: './index.ts' }),
  )
  await writeFile(join(packageDir, 'macro.ts'), 'export const readPackageFlag = () => Bun.env.PACKAGE_MACRO_FLAG\n')
  await writeFile(
    join(packageDir, 'index.ts'),
    [
      "import { readPackageFlag } from './macro' with { type: 'macro' }",
      'export const packageFlag = readPackageFlag()',
    ].join('\n'),
  )
  await writeFile(
    workflowsPath,
    [
      "import { localFlag } from './local-helper'",
      "import { packageFlag } from '@fixture/macro-helper'",
      'export const workflow = () => [localFlag, packageFlag]',
    ].join('\n'),
  )

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations.filter((violation) => violation.details?.importAttribute === 'macro')).toHaveLength(2)
  expect(violations.some((violation) => violation.filePath.endsWith('/local-helper.ts'))).toBeTrue()
  expect(violations.some((violation) => violation.filePath.endsWith('/@fixture/macro-helper/index.ts'))).toBeTrue()
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('rejects Bun macro imports reached through local and package require calls before bundling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const packageDir = join(dir, 'node_modules', '@fixture', 'required-macro-helper')
  const workflowsPath = join(dir, 'workflows.ts')
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(dir, 'local-macro.ts'), 'export const readLocalFlag = () => Bun.env.LOCAL_MACRO_FLAG\n')
  await writeFile(
    join(dir, 'local-helper.ts'),
    [
      "import { readLocalFlag } from './local-macro' with { type: 'macro' }",
      'export const localFlag = readLocalFlag()',
    ].join('\n'),
  )
  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: '@fixture/required-macro-helper', type: 'module', exports: './index.ts' }),
  )
  await writeFile(join(packageDir, 'macro.ts'), 'export const readPackageFlag = () => Bun.env.PACKAGE_MACRO_FLAG\n')
  await writeFile(
    join(packageDir, 'index.ts'),
    [
      "import { readPackageFlag } from './macro' with { type: 'macro' }",
      'export const packageFlag = readPackageFlag()',
    ].join('\n'),
  )
  await writeFile(
    workflowsPath,
    [
      "const local = require('./local-helper')",
      "const requiredPackage = require('@fixture/required-macro-helper')",
      'export const workflow = () => [local.localFlag, requiredPackage.packageFlag]',
    ].join('\n'),
  )

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations.filter((violation) => violation.details?.importAttribute === 'macro')).toHaveLength(2)
  expect(violations.some((violation) => violation.filePath.endsWith('/local-helper.ts'))).toBeTrue()
  expect(violations.some((violation) => violation.filePath.endsWith('/@fixture/required-macro-helper/index.ts'))).toBeTrue()
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('rejects Bun macro imports reached through dynamic imports before bundling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(join(dir, 'macro.ts'), 'export const readFlag = () => Bun.env.DYNAMIC_MACRO_FLAG\n')
  await writeFile(
    join(dir, 'dynamic-helper.ts'),
    [
      "import { readFlag } from './macro' with { type: 'macro' }",
      'export const flag = readFlag()',
    ].join('\n'),
  )
  await writeFile(workflowsPath, "export const workflow = () => import('./dynamic-helper')\n")

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        filePath: join(dir, 'dynamic-helper.ts'),
        rule: 'deny-import',
        details: { specifier: './macro', importAttribute: 'macro' },
      }),
    ]),
  )
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('rejects worker-thread isolates that can read launch-specific state outside runtime guards', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    workflowsPath,
    [
      "import { Worker } from 'node:worker_threads'",
      "export const workflow = () => new Worker('postMessage(Bun.env.FLAG)', { eval: true })",
    ].join('\n'),
  )

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        rule: 'deny-import',
        details: { specifier: 'worker_threads' },
      }),
    ]),
  )
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('rejects global workers that can read launch-specific state outside runtime guards', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(join(dir, 'worker.ts'), 'postMessage(Bun.env.FLAG)\n')
  await writeFile(
    workflowsPath,
    [
      "export const direct = () => new Worker('./worker.ts')",
      "export const member = () => new globalThis.Worker('./worker.ts')",
    ].join('\n'),
  )

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations.some((violation) => violation.details?.global === 'Worker')).toBeTrue()
  expect(violations.some((violation) => violation.details?.memberExpression === 'globalThis.Worker')).toBeTrue()
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

test('rejects dynamic code through invoked constructor properties', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    workflowsPath,
    [
      "const constructorKey = 'constructor'",
      "export const direct = () => (() => {}).constructor('return Bun.env.FLAG')()",
      "export const optional = () => (() => {})?.constructor?.('return Bun.env.FLAG')()",
      "export const bracket = () => (() => {})['constructor']('return Bun.env.FLAG')()",
      "export const computed = (fn: () => void) => fn[constructorKey]('return Bun.env.FLAG')()",
      "export const unresolved = (key: string) => (() => {})[key]('return Bun.env.FLAG')()",
      "export const call = () => (() => {}).constructor.call(undefined, 'return Bun.env.FLAG')()",
      "export const chained = () => ({}).constructor.constructor('return Bun.env.FLAG')()",
    ].join('\n'),
  )

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(
    violations.filter(
      (violation) =>
        violation.rule === 'deny-member-expression' && violation.details?.memberProperty === 'constructor',
    ),
  ).toHaveLength(6)
  expect(
    violations.filter(
      (violation) => violation.rule === 'deny-member-expression' && violation.details?.memberProperty === '[...]',
    ),
  ).toHaveLength(1)
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('rejects tagged constructor invocation before shared helpers can be cached', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const helperPath = join(dir, 'shared-helper.ts')
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(helperPath, 'export const workflow = (() => {}).constructor`return Bun.env.FLAG`\n')
  await writeFile(workflowsPath, "export { workflow } from './shared-helper'\n")

  // Activities can execute the constructor tag while populating Bun's module cache before guards are installed.
  await import(pathToFileURL(helperPath).href)

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        rule: 'deny-member-expression',
        details: { memberProperty: 'constructor' },
      }),
    ]),
  )
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('rejects cached constructor captures that are invoked after module initialization', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const helperPath = join(dir, 'shared-helper.ts')
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    helperPath,
    [
      "const constructorKey = 'constructor'",
      'const Code = (() => {}).constructor',
      'const BracketCode = (() => {})[constructorKey]',
      "export const direct = () => Code('return Bun.env.FLAG')()",
      "export const bracket = () => BracketCode('return Bun.env.FLAG')()",
    ].join('\n'),
  )
  await writeFile(workflowsPath, "export { direct, bracket } from './shared-helper'\n")

  // Activities can populate Bun's module cache before WorkerRuntime.create() installs workflow guards.
  await import(pathToFileURL(helperPath).href)

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations.filter((violation) => violation.rule === 'capture-member-expression')).toHaveLength(2)
  expect(violations.every((violation) => violation.details?.memberProperty === 'constructor')).toBeTrue()
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('rejects constructors captured through reflection before guard installation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const helperPath = join(dir, 'shared-helper.ts')
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    helperPath,
    [
      "const constructorKey = 'constructor'",
      "const DirectCode = Reflect.get(Object.getPrototypeOf(() => {}), 'constructor')",
      'const ComputedCode = Reflect.get(Object.getPrototypeOf(() => {}), constructorKey)',
      "const DescriptorCode = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(() => {}), 'constructor')?.value",
      "export const direct = () => DirectCode('return Bun.env.FLAG')()",
      "export const computed = () => ComputedCode('return Bun.env.FLAG')()",
      "export const descriptor = () => DescriptorCode('return Bun.env.FLAG')()",
    ].join('\n'),
  )
  await writeFile(workflowsPath, "export { direct, computed, descriptor } from './shared-helper'\n")

  // Activities can populate Bun's module cache before WorkerRuntime.create() installs workflow guards.
  await import(pathToFileURL(helperPath).href)

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations.filter((violation) => violation.rule === 'capture-member-expression')).toHaveLength(3)
  expect(violations.every((violation) => violation.details?.memberProperty === 'constructor')).toBeTrue()
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('rejects constructor captures assigned after declaration or into class fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const helperPath = join(dir, 'shared-helper.ts')
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    helperPath,
    [
      'let AssignedCode = () => undefined',
      'AssignedCode = (() => {}).constructor',
      'class ConstructorHolder {',
      '  Code = (() => {}).constructor',
      "  run = () => this.Code('return Bun.env.FLAG')()",
      '}',
      "export const assigned = () => AssignedCode('return Bun.env.FLAG')()",
      'export const field = () => new ConstructorHolder().run()',
    ].join('\n'),
  )
  await writeFile(workflowsPath, "export { assigned, field } from './shared-helper'\n")

  // Activities can populate Bun's module cache before WorkerRuntime.create() installs workflow guards.
  await import(pathToFileURL(helperPath).href)

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations.filter((violation) => violation.rule === 'capture-member-expression')).toHaveLength(2)
  expect(violations.every((violation) => violation.details?.memberProperty === 'constructor')).toBeTrue()
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('rejects destructured constructor captures that are invoked after module initialization', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const helperPath = join(dir, 'shared-helper.ts')
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    helperPath,
    [
      'const { constructor: Code } = (() => {})',
      "const { ['constructor']: ComputedCode } = (() => {})",
      'const { constructor } = (() => {})',
      'const { nested: { constructor: NestedCode } } = { nested: () => {} }',
      'const ignored = 0, { constructor: MultiCode } = (() => {})',
      'let AssignedCode = () => {}',
      ';({ constructor: AssignedCode } = (() => {}))',
      'const [ArrayCode] = [(() => {}).constructor]',
      'const { value: ValueCode } = { value: (() => {}).constructor }',
      "export const direct = () => Code('return Bun.env.FLAG')()",
      "export const computed = () => ComputedCode('return Bun.env.FLAG')()",
      "export const shorthand = () => constructor('return Bun.env.FLAG')()",
      "export const nested = () => NestedCode('return Bun.env.FLAG')()",
      "export const multiple = () => MultiCode('return Bun.env.FLAG')()",
      "export const assigned = () => AssignedCode('return Bun.env.FLAG')()",
      "export const array = () => ArrayCode('return Bun.env.FLAG')()",
      "export const value = () => ValueCode('return Bun.env.FLAG')()",
    ].join('\n'),
  )
  await writeFile(
    workflowsPath,
    "export { direct, computed, shorthand, nested, multiple, assigned, array, value } from './shared-helper'\n",
  )

  // Activities can populate Bun's module cache before WorkerRuntime.create() installs workflow guards.
  await import(pathToFileURL(helperPath).href)

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations.filter((violation) => violation.rule === 'capture-member-expression')).toHaveLength(8)
  expect(violations.every((violation) => violation.details?.memberProperty === 'constructor')).toBeTrue()
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('rejects constructor captures nested in containers before guard installation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const helperPath = join(dir, 'shared-helper.ts')
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    helperPath,
    [
      'const holder = { Code: (() => {}).constructor }',
      "const nestedHolder = { nested: [(() => {})['constructor']] }",
      'const iifeHolder = { Code: (() => (() => {}).constructor)() }',
      "export const object = () => holder.Code('return Bun.env.FLAG')()",
      "export const nested = () => nestedHolder.nested[0]('return Bun.env.FLAG')()",
      "export const iife = () => iifeHolder.Code('return Bun.env.FLAG')()",
    ].join('\n'),
  )
  await writeFile(workflowsPath, "export { object, nested, iife } from './shared-helper'\n")

  // Activities can populate Bun's module cache before WorkerRuntime.create() installs workflow guards.
  await import(pathToFileURL(helperPath).href)

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations.filter((violation) => violation.rule === 'capture-member-expression')).toHaveLength(3)
  expect(violations.every((violation) => violation.details?.memberProperty === 'constructor')).toBeTrue()
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('accepts constructor metadata nested in a container when it cannot invoke or escape', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    workflowsPath,
    [
      'const metadata = { GeneratorFunction: function* () {}.constructor }',
      'const isGenerator = (value: unknown) =>',
      '  typeof value === "function" && value.constructor === metadata.GeneratorFunction',
      'export const workflow = (value: unknown) => isGenerator(value)',
    ].join('\n'),
  )

  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).resolves.toBeUndefined()
})

test('accepts captured constructor metadata that cannot invoke or escape the constructor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    workflowsPath,
    [
      'const GeneratorFunction = function* () {}.constructor',
      'const isGenerator = (value: unknown) =>',
      '  typeof value === "function" && value.constructor === GeneratorFunction',
      'export const workflow = (value: unknown) => isGenerator(value)',
    ].join('\n'),
  )

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

test('rejects computed global keys because inherited accessors can recover the receiver', async () => {
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

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations.filter((violation) => violation.details?.memberExpression === 'globalThis[...]')).toHaveLength(2)
  expect(violations.filter((violation) => violation.details?.memberExpression === 'Reflect.get')).toHaveLength(1)
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
})

test('rejects access to Temporal runtime guard state through registered symbols', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(
    workflowsPath,
    [
      "const processEnvKey = Symbol.for('@proompteng/temporal-bun-sdk.original.process.env')",
      "const stateKeyName = '@proompteng/temporal-bun-sdk.workflowGuards.state'",
      'const stateKey = Symbol.for(stateKeyName)',
      'export const processEnv = () => globalThis[processEnvKey].FLAG',
      "export const bunEnv = () => globalThis[Symbol.for('@proompteng/temporal-bun-sdk.original.Bun.env')].FLAG",
      'export const state = () => Reflect.get(globalThis, stateKey).mode',
      "export const spawn = () => Object.getOwnPropertyDescriptor(globalThis, Symbol.for('@proompteng/temporal-bun-sdk.original.Bun.spawn'))?.value(['env'])",
    ].join('\n'),
  )

  const violations = await lintWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })

  expect(violations.filter((violation) => violation.rule === 'deny-member-expression')).toHaveLength(4)
  await expect(assertWorkflowBunEnvironmentSafety({ workflowsPath, cwd: dir })).rejects.toBeInstanceOf(
    WorkflowBunEnvironmentSafetyError,
  )
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

test('worker startup prioritizes in-memory workflows over the public API default path under Bun 1.4', async () => {
  if (canGuardBunEnvironmentAtRuntime()) return

  await expect(
    createWorker({
      config: createTestTemporalConfig({ workflowGuards: 'strict' }),
      workflows: [{}] as never,
      workflowGuards: 'strict',
    }),
  ).rejects.toBeInstanceOf(WorkflowBunEnvironmentSafetyError)
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

test('worker startup isolates strict workflows from activity-populated module state under Bun 1.4', async () => {
  if (canGuardBunEnvironmentAtRuntime()) return

  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const sharedPath = join(dir, 'shared.ts')
  const activitiesPath = join(dir, 'activities.ts')
  const workflowsPath = join(dir, 'workflows.ts')
  await mkdir(join(dir, 'node_modules', '@proompteng'), { recursive: true })
  await symlink(join(import.meta.dir, '../../node_modules/effect'), join(dir, 'node_modules', 'effect'))
  await symlink(join(import.meta.dir, '../..'), join(dir, 'node_modules', '@proompteng', 'temporal-bun-sdk'))
  await writeFile(sharedPath, 'export const shared: { env?: unknown } = {}\n')
  await writeFile(
    activitiesPath,
    ["import { shared } from './shared'", 'shared.env = Bun.env', 'export const activities = {}'].join('\n'),
  )
  await writeFile(
    workflowsPath,
    [
      "import { Effect } from 'effect'",
      "import { defineWorkflow } from '@proompteng/temporal-bun-sdk/workflow'",
      "import { shared } from './shared'",
      "if (shared.env !== undefined) throw new Error('activity-populated module state leaked into workflows')",
      "export const workflows = [defineWorkflow('isolated-workflow', () => Effect.succeed(undefined))]",
    ].join('\n'),
  )

  await import(pathToFileURL(activitiesPath).href)

  const runtime = await WorkerRuntime.create({
    config: createTestTemporalConfig({
      workflowGuards: 'strict',
      workerBuildId: 'isolated-workflow-build',
      workerDeploymentName: 'isolated-workflow-deployment',
    }),
    workflowsPath,
    workflowGuards: 'strict',
  })
  await runtime.shutdown()
})

test('worker startup reports Bun environment source violations in warn mode under Bun 1.4', async () => {
  if (canGuardBunEnvironmentAtRuntime()) return

  const dir = await mkdtemp(join(tmpdir(), 'temporal-bun-env-lint-'))
  const workflowsPath = join(dir, 'workflows.ts')
  await writeFile(workflowsPath, 'export const workflows = Bun.env.FLAG\n')
  const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = []

  await expect(
    WorkerRuntime.create({
      config: createTestTemporalConfig({ workflowGuards: 'warn' }),
      workflowsPath,
      workflowGuards: 'warn',
      logger: {
        log: (level, message, fields) =>
          Effect.sync(() => {
            logs.push({ level, message, fields: fields as Record<string, unknown> })
          }),
      },
    }),
  ).rejects.toThrow('No workflow definitions were registered')

  expect(logs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        level: 'warn',
        message: 'Workflow Bun environment safety violation',
        fields: expect.objectContaining({
          workflowGuards: 'warn',
          rule: 'deny-member-expression',
          violationMessage: 'Disallowed member expression in workflow module: Bun.env',
        }),
      }),
    ]),
  )
})
