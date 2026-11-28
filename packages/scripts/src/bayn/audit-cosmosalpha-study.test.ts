import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { auditCosmosalphaStudy } from './audit-cosmosalpha-study'

let root: string
let sourceRoot: string
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const commit = 'a'.repeat(40)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cosmos-config-audit-'))
  sourceRoot = join(root, 'source')
  mkdirSync(sourceRoot)
  writeFileSync(join(sourceRoot, 'example.py'), 'fixture source bytes\n')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const config = (architecture: 'graph' | 'no-flow' | 'mcts' | 'chain', seed = 7) => `
[architecture]
name = "${architecture === 'no-flow' ? 'graph' : architecture}"
[data]
start_date = "2010-04-01"
end_date = "2019-05-31"
[universe]
name = "csi300"
[returns]
horizon_days = 1
[preprocessing]
protocol = "gplearn_neutralized_v1"
[operators]
allowed_windows = [5, 10, 20]
[factor_generation]
max_proposals = 2
[evaluation]
min_cross_section_samples = 100
acceptance_threshold = 0.02
[prompts]
manifest = "builtin:v2"
[llm]
model_alias = "qwen38-flamingo"
temperature = 0.0
[qlib]
enabled = true
[qlib.market]
provider_uri = "/same-provider"
[workflow]
max_cycles = 102
[runtime]
random_seed = ${seed}
max_workers = ${architecture === 'mcts' || architecture === 'chain' ? 1 : 4}
[storage]
backend = "local_sqlite"
root = "/${architecture}-artifacts"
${architecture === 'mcts' ? '[mcts]\nmax_iterations = 50' : ''}
${
  architecture === 'graph' || architecture === 'no-flow'
    ? `
[graph.initialization]
random_seed = ${seed}
initial_node_count = 2
[graph.search]
max_expansion_attempts = 100
[graph.flow]
gamma = ${architecture === 'no-flow' ? '0.0' : '0.75'}
iterations = 100
`
    : ''
}
`

type FixtureRun = { runId: string; seed: number; content: string; arm?: string }
const trio = (): FixtureRun[] =>
  (['graph', 'mcts', 'no-flow'] satisfies Array<Parameters<typeof config>[0]>).map((arm) => ({
    runId: arm,
    seed: 7,
    content: config(arm),
  }))

const plan = (runs = trio()) => {
  const identity = JSON.stringify({
    sourceCommit: commit,
    files: [{ path: 'src/cosmosalpha/example.py', sha256: digest('fixture source bytes\n') }],
  })
  writeFileSync(join(root, 'identity.json'), identity)
  const path = join(root, 'plan.json')
  writeFileSync(
    path,
    JSON.stringify({
      sourceCommit: commit,
      sourceIdentityFile: 'identity.json',
      sourceIdentitySha256: digest(identity),
      runs: runs.map((run, index) => {
        const file = `arm-${index}.toml`
        writeFileSync(join(root, file), run.content)
        return { runId: run.runId, seed: run.seed, arm: run.arm, config: file, sha256: digest(run.content) }
      }),
    }),
  )
  return path
}

describe('CosmosAlpha configuration audit', () => {
  test('checks a complete contrast while retaining native budget units and unverified boundaries', () => {
    const result = auditCosmosalphaStudy(plan(), sourceRoot)
    expect(result.status).toBe('configuration-consistent')
    expect(result.findings).toEqual([])
    expect(result.sourceFilesMatched).toBe(1)
    expect(result.runs.map((run) => run.architecture)).toEqual(['graph', 'mcts', 'no-flow'])
    expect(result.runs.map((run) => run.nativeBudget)).toEqual([
      { unit: 'parent-expansion-attempts', maximum: 100, configuredMaxProposals: 2 },
      { unit: 'mcts-iterations', maximum: 50, configuredMaxProposals: 2 },
      { unit: 'parent-expansion-attempts', maximum: 100, configuredMaxProposals: 2 },
    ])
    expect(result.scope).toBe('configuration-audit-only')
    expect(result.unverified).toContain(
      'Paper MCTS multi-subtree behavior is not established by architecture.name=mcts.',
    )
  })

  test('identifies the actual Graph/Chain study as missing MCTS and No-Flow', () => {
    const result = auditCosmosalphaStudy(
      plan([
        { runId: 'graph', seed: 7, content: config('graph') },
        { runId: 'chain', seed: 7, content: config('chain') },
      ]),
      sourceRoot,
    )
    expect(result.findings.map((item) => item.detail)).toEqual([
      'Expected one mcts config, found 0',
      'Expected one no-flow config, found 0',
    ])
  })

  test('infers architecture from config bytes even when the plan calls Graph MCTS', () => {
    const runs = trio()
    runs[1] = { runId: 'fake-mcts', seed: 7, arm: 'mcts', content: config('graph') }
    const result = auditCosmosalphaStudy(plan(runs), sourceRoot)
    expect(result.findings.map((item) => item.detail)).toContain('Expected one mcts config, found 0')
    expect(result.runs[1]?.architecture).toBe('graph')
  })

  test.each([
    ['minimum samples', 'min_cross_section_samples = 100', 'min_cross_section_samples = 50', 'evaluation'],
    ['provider', 'provider_uri = "/same-provider"', 'provider_uri = "/different-provider"', 'qlib'],
    ['model', 'qwen38-flamingo', 'other-model', 'llm'],
    ['period', '2019-05-31', '2025-12-31', 'data'],
  ])('rejects a changed %s in the MCTS comparison', (_name, before, after, section) => {
    const runs = trio()
    runs[1] = { runId: 'mcts', seed: 7, content: config('mcts').replace(before, after) }
    const result = auditCosmosalphaStudy(plan(runs), sourceRoot)
    expect(result.findings).toContainEqual({ subject: 'mcts', detail: `${section} differs from graph` })
  })

  test('requires No-Flow to change only gamma and storage root', () => {
    const runs = trio()
    runs[2] = { runId: 'no-flow', seed: 7, content: config('no-flow').replace('iterations = 100', 'iterations = 50') }
    expect(auditCosmosalphaStudy(plan(runs), sourceRoot).findings).toContainEqual({
      subject: 'seed 7',
      detail: 'No-Flow changes settings beyond gamma and storage root',
    })
  })

  test('checks every planned seed rather than pooling contrasts across seeds', () => {
    const runs = trio()
    runs[1] = { runId: 'mcts', seed: 8, content: config('mcts', 8) }
    const result = auditCosmosalphaStudy(plan(runs), sourceRoot)
    expect(result.findings).toContainEqual({ subject: 'seed 7', detail: 'Expected one mcts config, found 0' })
    expect(result.findings).toContainEqual({ subject: 'seed 8', detail: 'Expected one graph config, found 0' })
  })

  test('rejects config bytes changed after freezing', () => {
    const path = plan()
    writeFileSync(join(root, 'arm-0.toml'), config('graph').replace('gamma = 0.75', 'gamma = 0.5'))
    expect(auditCosmosalphaStudy(path, sourceRoot).findings).toContainEqual({
      subject: 'graph',
      detail: 'Config bytes differ from the frozen plan',
    })
  })

  test('rejects installed source drift', () => {
    const path = plan()
    writeFileSync(join(sourceRoot, 'example.py'), 'changed source\n')
    expect(auditCosmosalphaStudy(path, sourceRoot).findings).toContainEqual({
      subject: 'source identity',
      detail: 'Installed source differs from manifest: src/cosmosalpha/example.py',
    })
  })

  test('rejects source manifest drift before trusting its file list', () => {
    const path = plan()
    writeFileSync(join(root, 'identity.json'), '{}')
    expect(auditCosmosalphaStudy(path, sourceRoot).findings).toContainEqual({
      subject: 'source identity',
      detail: 'Source manifest differs from frozen plan',
    })
  })

  test('CLI success remains explicitly limited to configuration consistency', () => {
    const child = Bun.spawnSync([process.execPath, import.meta.dir + '/audit-cosmosalpha-study.ts', plan(), sourceRoot])
    expect(child.exitCode).toBe(0)
    const output = JSON.parse(child.stdout.toString())
    expect(output.scope).toBe('configuration-audit-only')
    expect(output.unverified.length).toBeGreaterThan(0)
  })

  test('rejects duplicate run identities and mismatched seeds', () => {
    const runs = trio()
    runs[1] = { runId: 'graph', seed: 7, content: config('mcts') }
    runs[2] = { runId: 'no-flow', seed: 8, content: config('no-flow') }
    const result = auditCosmosalphaStudy(plan(runs), sourceRoot)
    expect(result.findings).toContainEqual({ subject: 'graph', detail: 'Duplicate runId' })
    expect(result.findings).toContainEqual({ subject: 'no-flow', detail: 'Configured seed differs from plan seed' })
  })

  test('CLI returns a failing audit and writes no study files', () => {
    const path = plan([{ runId: 'graph', seed: 7, content: config('graph') }])
    const original = readFileSync(path, 'utf8')
    const child = Bun.spawnSync([process.execPath, import.meta.dir + '/audit-cosmosalpha-study.ts', path, sourceRoot])
    expect(child.exitCode).toBe(1)
    expect(JSON.parse(child.stdout.toString()).status).toBe('configuration-mismatch')
    expect(readFileSync(path, 'utf8')).toBe(original)
  })
})
