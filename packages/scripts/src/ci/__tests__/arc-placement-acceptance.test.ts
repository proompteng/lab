import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'
import YAML from 'yaml'

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
const verifier = join(repoRoot, '.github/scripts/verify-arc-placement.sh')
const workflow = YAML.parseDocument(
  readFileSync(join(repoRoot, '.github/workflows/arc-placement-acceptance.yml'), 'utf8'),
)

type RunnerProof = {
  slot: number
  pod: string
  node: string
  start: number
  end: number
} & (
  | { role: 'publication' }
  | { role: 'build'; inputBytes: number; outputBytes: number; inputSha256: string; outputSha256: string }
)

const proofs = (): RunnerProof[] => [
  ...Array.from(
    { length: 8 },
    (_, index): RunnerProof => ({
      role: 'build',
      slot: index + 1,
      pod: `build-${index + 1}`,
      node: index < 2 ? 'talos-192-168-1-194' : 'turin',
      start: 100,
      end: 200,
      inputBytes: 16_777_216,
      outputBytes: 16_777_216,
      inputSha256: 'a'.repeat(64),
      outputSha256: 'a'.repeat(64),
    }),
  ),
  ...Array.from(
    { length: 2 },
    (_, index): RunnerProof => ({
      role: 'publication',
      slot: index + 1,
      pod: `publication-${index + 1}`,
      node: 'talos-192-168-1-194',
      start: 155,
      end: 250,
    }),
  ),
]

const verify = (records: readonly unknown[]) => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-placement-proof-'))
  try {
    records.forEach((record, index) => {
      const artifact = join(directory, `artifact-${index}`)
      mkdirSync(artifact)
      writeFileSync(join(artifact, 'arc-complete.json'), typeof record === 'string' ? record : JSON.stringify(record))
    })
    return spawnSync('bash', [verifier, directory], { cwd: repoRoot, encoding: 'utf8' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('ARC placement proof', () => {
  test('accepts eight builders and two publication Pods with exactly 45 seconds of common overlap', () => {
    const result = verify(proofs())
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      buildRunners: 8,
      publicationRunners: 2,
      distinctPods: 10,
      overlapSeconds: 45,
    })
  })

  const invalid = [
    {
      name: 'a missing builder',
      change: (records: RunnerProof[]) => records.filter((record) => record.role !== 'build' || record.slot !== 8),
    },
    {
      name: 'a missing publication Pod',
      change: (records: RunnerProof[]) =>
        records.filter((record) => record.role !== 'publication' || record.slot !== 2),
    },
    {
      name: 'a duplicate build slot',
      change: (records: RunnerProof[]) =>
        records.map((record) => (record.role === 'build' && record.slot === 8 ? { ...record, slot: 1 } : record)),
    },
    {
      name: 'a duplicate publication slot',
      change: (records: RunnerProof[]) =>
        records.map((record) => (record.role === 'publication' ? { ...record, slot: 1 } : record)),
    },
    {
      name: 'a Pod reused across build and publication roles',
      change: (records: RunnerProof[]) =>
        records.map((record) =>
          record.role === 'publication' && record.slot === 1 ? { ...record, pod: 'build-1' } : record,
        ),
    },
    {
      name: 'an ineligible host',
      change: (records: RunnerProof[]) =>
        records.map((record) => (record.role === 'build' && record.slot === 1 ? { ...record, node: 'altra' } : record)),
    },
    {
      name: 'only 44 seconds of common overlap',
      change: (records: RunnerProof[]) =>
        records.map((record) => (record.role === 'publication' ? { ...record, start: 156 } : record)),
    },
    {
      name: 'non-overlapping publication',
      change: (records: RunnerProof[]) =>
        records.map((record) => (record.role === 'publication' ? { ...record, start: 201 } : record)),
    },
    {
      name: 'changed output bytes with the same payload length',
      change: (records: RunnerProof[]) =>
        records.map((record) =>
          record.role === 'build' && record.slot === 1 ? { ...record, outputSha256: 'b'.repeat(64) } : record,
        ),
    },
    {
      name: 'a truncated build output',
      change: (records: RunnerProof[]) =>
        records.map((record) =>
          record.role === 'build' && record.slot === 1 ? { ...record, outputBytes: 1 } : record,
        ),
    },
    {
      name: 'malformed matching checksums',
      change: (records: RunnerProof[]) =>
        records.map((record) =>
          record.role === 'build' && record.slot === 1
            ? { ...record, inputSha256: 'not-a-checksum', outputSha256: 'not-a-checksum' }
            : record,
        ),
    },
    {
      name: 'an empty Pod identity',
      change: (records: RunnerProof[]) =>
        records.map((record) => (record.role === 'publication' && record.slot === 1 ? { ...record, pod: '' } : record)),
    },
  ]

  test.each(invalid)('rejects $name', ({ change }) => {
    const result = verify(change(proofs()))
    expect(result.status).not.toBe(0)
  })

  test('rejects malformed JSON instead of ignoring its artifact', () => {
    const result = verify([...proofs(), '{'])
    expect(result.status).not.toBe(0)
  })
})

describe('ARC placement acceptance workflow', () => {
  test.each([
    { job: 'local-build', runner: 'arc-amd64', slots: [1, 2, 3, 4, 5, 6, 7, 8], parallel: 8 },
    { job: 'publication-tools', runner: 'arc-amd64-publish', slots: [1, 2], parallel: 2 },
  ])('requests simultaneous $job capacity with a bounded queue allowance', ({ job, runner, slots, parallel }) => {
    const specification = workflow.getIn(['jobs', job])
    if (!YAML.isMap(specification)) throw new Error(`Missing ${job} job`)
    const matrix = specification.getIn(['strategy', 'matrix', 'slot'])
    if (!YAML.isSeq(matrix)) throw new Error(`Missing ${job} slot matrix`)
    expect(matrix.toJSON()).toEqual(slots)
    expect(specification.get('runs-on')).toBe(runner)
    expect(specification.getIn(['strategy', 'max-parallel'])).toBe(parallel)
    expect(specification.get('timeout-minutes')).toBe(110)
  })
})
