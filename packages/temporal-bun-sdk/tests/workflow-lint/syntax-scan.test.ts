import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  collectWorkflowDynamicImportPositions,
  collectWorkflowModuleSpecifiers,
  scanWorkflowSyntaxTokens,
} from '../../src/bin/workflow-lint/syntax-scan'
import { buildWorkflowLintGraph } from '../../src/bin/workflow-lint/graph'
import { lintWorkflowModuleAst } from '../../src/bin/workflow-lint/rules'

describe('workflow lint syntax scanner', () => {
  test('distinguishes type-only import references from runtime dynamic imports', () => {
    const source = [
      "type ActivityInput = import('./activities').ActivityInput",
      "type WrappedActivityInput =",
      "  import('./activities').ActivityInput",
      "type Box<T extends import('./activities').ActivityInput> = T",
      "class State { input!: import('./activities').ActivityInput }",
      "const activity: import('./activities').ActivityInput = {} as never",
      "const wrappedActivity:",
      "  import('./activities').ActivityInput = {} as never",
      "const asserted = value as import('./activities').ActivityInput",
      "const generic = make<import('./activities').ActivityInput>()",
      "const angled = <import('./activities').ActivityInput>value",
      "const run = (name: string) => import(name)",
      "const fallback = ok ? cached : import(name)",
      "const object = { module: import(name) }",
      "const nestedObject = { nested: { module: import(name) } }",
      "const comparison = score < import(path) > (threshold)",
      "const modulePromise = import('./runtime-module')",
    ].join('\n')

    const positions = collectWorkflowDynamicImportPositions(scanWorkflowSyntaxTokens(source))

    expect(positions).toHaveLength(6)
    expect(positions.map((position) => source.slice(position).split('\n')[0])).toEqual([
      'import(name)',
      'import(name)',
      'import(name) }',
      'import(name) } }',
      'import(path) > (threshold)',
      "import('./runtime-module')",
    ])
  })

  test('collects named import and export module specifiers', () => {
    const source = [
      "import { readFile } from 'node:fs/promises'",
      "export { child } from './child'",
    ].join('\n')

    expect(collectWorkflowModuleSpecifiers(scanWorkflowSyntaxTokens(source)).map((item) => item.specifier)).toEqual([
      'node:fs/promises',
      './child',
    ])
  })

  test('treats nested import types in assertions as erased', () => {
    const source = [
      "const asserted = value as Array<import('./activities').ActivityInput>",
      "const satisfied = value satisfies ReadonlyArray<import('./activities').ActivityInput>",
      'const runtimeAfterAssertion = (value as unknown, import(name))',
    ].join('\n')

    const positions = collectWorkflowDynamicImportPositions(scanWorkflowSyntaxTokens(source))

    expect(positions.map((position) => source.slice(position).split('\n')[0])).toEqual(['import(name))'])
  })

  test('traverses relative dependencies imported with named imports', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-lint-'))
    await writeFile(join(dir, 'entry.ts'), "import { child } from './child'\nexport const workflow = () => child()", 'utf8')
    await writeFile(join(dir, 'child.ts'), "import { readFile } from 'node:fs/promises'\nexport const child = () => readFile('/tmp/example')", 'utf8')

    const { graph, violations } = await buildWorkflowLintGraph({
      cwd: dir,
      entry: 'entry.ts',
      denyImports: new Set(['node:fs/promises']),
    })

    expect([...graph.modules].map((filePath) => filePath.split('/').at(-1)).sort()).toEqual(['child.ts', 'entry.ts'])
    expect(violations.map((violation) => violation.specifier)).toContain('node:fs/promises')
  })

  test('does not capture denied globals used only in type aliases', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-lint-'))
    const filePath = join(dir, 'workflow.ts')
    await writeFile(
      filePath,
      [
        'type Result = Promise<void>',
        'export const workflow = () => {',
        '  const runtimePromise = Promise',
        '  const runtimeFetch =',
        '    Promise',
        '  return runtimePromise.resolve(runtimeFetch)',
        '}',
      ].join('\n'),
      'utf8',
    )

    const violations = await lintWorkflowModuleAst({
      filePath,
      denyGlobals: new Set(['Promise']),
      denyImports: new Set<string>(),
      denyMemberExpressions: new Set<string>(),
    })

    expect(violations.map((violation) => violation.details?.global)).toEqual(['Promise', 'Promise'])
    expect(violations.map((violation) => violation.line)).toEqual([3, 5])
  })

  test('does not flag declarations named like denied globals', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-lint-'))
    const filePath = join(dir, 'workflow.ts')
    await writeFile(
      filePath,
      [
        'function fetch(input: string) { return input }',
        'interface Adapter { fetch(): void }',
        'const adapter = {',
        '  fetch()',
        '  { return undefined }',
        '}',
        'class AdapterClass {',
        '  fetch()',
        '  { return undefined }',
        '}',
        'export const workflow = () => {',
        "  return fetch('runtime')",
        '}',
      ].join('\n'),
      'utf8',
    )

    const violations = await lintWorkflowModuleAst({
      filePath,
      denyGlobals: new Set(['fetch']),
      denyImports: new Set<string>(),
      denyMemberExpressions: new Set<string>(),
    })

    expect(violations.map((violation) => violation.details?.global)).toEqual(['fetch'])
    expect(violations[0]?.line).toBe(12)
  })

  test('flags denied global calls before standalone blocks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-lint-'))
    const filePath = join(dir, 'workflow.ts')
    await writeFile(
      filePath,
      ['export const workflow = () => {', '  fetch()', '  { const standalone = true }', '}'].join('\n'),
      'utf8',
    )

    const violations = await lintWorkflowModuleAst({
      filePath,
      denyGlobals: new Set(['fetch']),
      denyImports: new Set<string>(),
      denyMemberExpressions: new Set<string>(),
    })

    expect(violations.map((violation) => violation.details?.global)).toEqual(['fetch'])
    expect(violations[0]?.line).toBe(2)
  })

  test('flags optional and ternary calls to denied globals', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-lint-'))
    const filePath = join(dir, 'workflow.ts')
    await writeFile(
      filePath,
      [
        'export const workflow = (ok: boolean, url: string, cached: unknown) => {',
        "  fetch?.('https://example.com')",
        '  setTimeout?.(() => {}, 1)',
        '  const result = ok ? fetch(url) : cached',
        '  return result',
        '}',
      ].join('\n'),
      'utf8',
    )

    const violations = await lintWorkflowModuleAst({
      filePath,
      denyGlobals: new Set(['fetch', 'setTimeout']),
      denyImports: new Set<string>(),
      denyMemberExpressions: new Set<string>(),
    })

    expect(violations.map((violation) => violation.details?.global)).toEqual(
      expect.arrayContaining(['fetch', 'setTimeout', 'fetch']),
    )
    expect(violations.map((violation) => violation.line)).toEqual(expect.arrayContaining([2, 3, 4]))
  })

  test('does not flag type-only typeof member queries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-lint-'))
    const filePath = join(dir, 'workflow.ts')
    await writeFile(
      filePath,
      [
        'type NowFn = typeof Date.now',
        'const now: typeof Date.now = fallback',
        'const assertedNow = fallback as typeof Date.now',
        'export const workflow = () => {',
        '  const runtime = { kind: typeof Date.now }',
        '  return typeof Date.now ?? runtime',
        '}',
        'const runtimeAfterAssertion = (fallback as unknown, typeof Date.now)',
      ].join('\n'),
      'utf8',
    )

    const violations = await lintWorkflowModuleAst({
      filePath,
      denyGlobals: new Set<string>(),
      denyImports: new Set<string>(),
      denyMemberExpressions: new Set(['Date.now']),
    })

    expect(violations.map((violation) => violation.details?.memberExpression)).toEqual([
      'Date.now',
      'Date.now',
      'Date.now',
    ])
    expect(violations.map((violation) => violation.line)).toEqual([5, 6, 8])
  })

  test('does not flag type-only typeof Bun.spawn queries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-lint-'))
    const filePath = join(dir, 'workflow.ts')
    await writeFile(
      filePath,
      [
        'type SpawnFn = typeof Bun.spawn',
        'const spawn: typeof Bun.spawn = fallback',
        'const assertedSpawn = fallback as typeof Bun.spawn',
        'export const workflow = () => {',
        '  const runtime = { kind: typeof Bun.spawn }',
        '  return typeof Bun.spawn ?? runtime',
        '}',
        'const runtimeAfterAssertion = (fallback as unknown, typeof Bun.spawn)',
      ].join('\n'),
      'utf8',
    )

    const violations = await lintWorkflowModuleAst({
      filePath,
      denyGlobals: new Set(['Bun.spawn']),
      denyImports: new Set<string>(),
      denyMemberExpressions: new Set<string>(),
    })

    expect(violations.map((violation) => violation.details?.global)).toEqual([
      'Bun.spawn',
      'Bun.spawn',
      'Bun.spawn',
    ])
    expect(violations.map((violation) => violation.line)).toEqual([5, 6, 8])
  })

  test('flags optional element access for denied workflow APIs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-lint-'))
    const filePath = join(dir, 'workflow.ts')
    await writeFile(
      filePath,
      [
        'export const workflow = () => {',
        "  Date?.['now']()",
        "  const env = process?.['env']",
        "  return Bun?.['file']('/tmp/example') ?? env",
        '}',
      ].join('\n'),
      'utf8',
    )

    const violations = await lintWorkflowModuleAst({
      filePath,
      denyGlobals: new Set<string>(),
      denyImports: new Set<string>(),
      denyMemberExpressions: new Set(['Date.now', 'process.env', 'Bun.file']),
    })

    expect(violations.map((violation) => violation.details?.memberExpression)).toEqual(
      expect.arrayContaining(['Date.now', 'process.env', 'Bun.file']),
    )
  })

  test('does not flag denied member names nested under user objects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-lint-'))
    const filePath = join(dir, 'workflow.ts')
    await writeFile(
      filePath,
      [
        'export const workflow = (payload: { Date: { now: () => number }; Math: { random: () => number } }) => {',
        '  const safeNow = payload.Date.now()',
        '  const safeRandom = payload.Math.random()',
        '  return { safeNow, safeRandom, unsafe: Date.now() }',
        '}',
      ].join('\n'),
      'utf8',
    )

    const violations = await lintWorkflowModuleAst({
      filePath,
      denyGlobals: new Set<string>(),
      denyImports: new Set<string>(),
      denyMemberExpressions: new Set(['Date.now', 'Math.random']),
    })

    expect(violations.map((violation) => violation.details?.memberExpression)).toEqual(['Date.now'])
    expect(violations[0]?.line).toBe(4)
  })

  test('flags optional chained member expressions for denied workflow APIs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-lint-'))
    const filePath = join(dir, 'workflow.ts')
    await writeFile(
      filePath,
      [
        'export const workflow = () => {',
        '  Date?.now()',
        '  const random = Math?.random',
        '  return process?.env.FOO ?? random()',
        '}',
      ].join('\n'),
      'utf8',
    )

    const violations = await lintWorkflowModuleAst({
      filePath,
      denyGlobals: new Set<string>(),
      denyImports: new Set<string>(),
      denyMemberExpressions: new Set(['Date.now', 'Math.random', 'process.env']),
    })

    expect(violations.map((violation) => violation.details?.memberExpression)).toEqual(
      expect.arrayContaining(['Date.now', 'Math.random', 'process.env']),
    )
  })
})
