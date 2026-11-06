import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { Result, Schema } from 'effect'

const formal = process.env['BAYN_FORMAL_EXECUTABLE'] === undefined ? describe.skip : describe
const directory = resolve(import.meta.dir, '../../formal')
const ScopeSchema = Schema.fromJsonString(
  Schema.Struct({
    modules: Schema.Array(Schema.String),
    declarations: Schema.Array(Schema.Struct({ name: Schema.String, module: Schema.String })),
    runtimeImplementations: Schema.Array(
      Schema.Struct({ name: Schema.String, module: Schema.String, safety: Schema.Literals(['partial', 'unsafe']) }),
    ),
  }),
)
const readScope = (path: string) =>
  Result.getOrThrow(Schema.decodeUnknownResult(ScopeSchema)(readFileSync(path, 'utf8')))
const run = (args: readonly string[], fixture?: string) => {
  const result = Bun.spawnSync({
    cmd: [...args],
    cwd: directory,
    env: {
      ...process.env,
      ...(fixture === undefined
        ? {}
        : { LEAN_PATH: [fixture, process.env['LEAN_PATH']].filter((path) => path !== undefined).join(delimiter) }),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    code: result.exitCode,
    output: new TextDecoder().decode(result.stdout),
    errors: new TextDecoder().decode(result.stderr),
  }
}
const success = (args: readonly string[], fixture?: string) => {
  const result = run(args, fixture)
  if (result.code !== 0) throw new Error(`${args.join(' ')} failed: ${result.errors}${result.output}`)
  return result.output
}

formal('complete owned Lean proof export', () => {
  test('the production scope contains every tracked model module and all statistical and execution roots', () => {
    const files = success(['git', 'ls-files', '-z', '--', '*.lean', ':!:Export.lean']).split('\0').filter(Boolean)
    const expected = files.map((path) => path.slice(0, -5).replaceAll('/', '.'))
    const scope = readScope(join(directory, '.lake/bayn-proof-scope.json'))
    expect(scope.modules).toEqual(expected)
    const names = new Set(scope.declarations.map((declaration) => declaration.name))
    for (const name of [
      'Bayn.profit_conservation',
      'Bayn.safety_has_no_error_budget',
      'Bayn.conditional_radius_never_understates_variance',
      'Bayn.registered_expected_profit_bound',
      'Bayn.conditional_qualification_preserves_every_requirement',
      'Bayn.single_session_without_arbitrary_activity_quota_is_reachable',
      'Bayn.bestMomentum',
      'Bayn.expenseCoverage',
      'Bayn.latestBatchCompletion',
      'Bayn.latestCompatibleEntryWindow',
      'Bayn.sampleWindow',
      'Bayn.tariffCoveredUntil',
      'Bayn.weightedAllocationsAux',
      'evaluate',
      'main',
    ])
      expect(names.has(name)).toBe(true)
    expect(scope.declarations.every((declaration) => scope.modules.includes(declaration.module))).toBe(true)
    expect(
      scope.runtimeImplementations.some((implementation) => implementation.name === 'Bayn.bestMomentum._unsafe_rec'),
    ).toBe(true)
    expect(scope.declarations.some((declaration) => declaration.name === 'Bayn.bestMomentum._unsafe_rec')).toBe(false)
  })

  test('module ownership includes foreign namespaces and unused private proofs, with full used dependencies', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'bayn-export-scope-'))
    try {
      writeFileSync(
        join(fixture, 'ScopeDependency.lean'),
        'module\npublic section\nnamespace Dependency\ntheorem needed : True := True.intro\naxiom unrelatedForbidden : False\nend Dependency\n',
      )
      writeFileSync(
        join(fixture, 'ScopeOwned.lean'),
        'module\npublic import ScopeDependency\npublic section\nnamespace OutsideBayn\ntheorem owned : True := Dependency.needed\nprivate theorem hidden : True := True.intro\nend OutsideBayn\n',
      )
      writeFileSync(
        join(fixture, 'ScopeBadOwned.lean'),
        'axiom requiredForbidden : False\ntheorem invalidOwnedProof : False := requiredForbidden\n',
      )
      writeFileSync(
        join(fixture, 'ScopeUnsafeOwned.lean'),
        'unsafe def uncheckable : Nat := 0\ntheorem stillFine : True := True.intro\n',
      )
      for (const name of ['ScopeDependency', 'ScopeOwned', 'ScopeBadOwned', 'ScopeUnsafeOwned'])
        success(
          ['lake', 'env', 'lean', '-R', fixture, '-o', join(fixture, `${name}.olean`), join(fixture, `${name}.lean`)],
          fixture,
        )
      const manifest = join(fixture, 'scope.json')
      const exported = success(['lake', 'env', 'lean', '--run', 'Export.lean', manifest, 'ScopeOwned'], fixture)
      const scope = readScope(manifest)
      expect(scope.modules).toEqual(['ScopeOwned'])
      expect(scope.declarations.map((declaration) => declaration.name)).toContain('OutsideBayn.owned')
      expect(scope.declarations.some((declaration) => declaration.name.endsWith('.OutsideBayn.hidden'))).toBe(true)
      expect(scope.declarations.every((declaration) => declaration.module === 'ScopeOwned')).toBe(true)
      expect(exported).toContain('"needed"')
      expect(exported).not.toContain('"unrelatedForbidden"')
      const legacy = success(['lake', 'env', 'leanexport', 'ScopeOwned'], fixture)
      expect(legacy).toContain('"unrelatedForbidden"')
      const valid = join(fixture, 'valid.ndjson')
      const invalid = join(fixture, 'invalid.ndjson')
      writeFileSync(valid, exported)
      writeFileSync(
        invalid,
        success(['lake', 'env', 'lean', '--run', 'Export.lean', manifest, 'ScopeBadOwned'], fixture),
      )
      expect(readScope(manifest).declarations.some((declaration) => declaration.name === 'requiredForbidden')).toBe(
        true,
      )
      expect(run(['lake', 'env', 'lean', '--run', 'Export.lean', manifest], fixture).code).not.toBe(0)
      const unsafe = run(['lake', 'env', 'lean', '--run', 'Export.lean', manifest, 'ScopeUnsafeOwned'], fixture)
      expect(unsafe.code).not.toBe(0)
      expect(unsafe.errors + unsafe.output).toContain('Non-logical model declaration')
      if (process.platform === 'linux') {
        expect(run(['lake', 'check', '--from-export', valid, '--paranoid']).code).toBe(0)
        expect(run(['lake', 'check', '--from-export', invalid, '--paranoid']).code).not.toBe(0)
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  }, 60_000)
})
