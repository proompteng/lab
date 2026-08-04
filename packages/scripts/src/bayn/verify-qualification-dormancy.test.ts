import { describe, expect, test } from 'bun:test'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  evaluateQualificationDormancy,
  qualificationWorkflowOutputs,
  verifyQualificationDormancy,
  type QualificationLifecycleDecision,
} from './verify-qualification-dormancy'

const repositoryRoot = resolve(import.meta.dir, '../../../..')
const verifierPath = resolve(import.meta.dir, 'verify-qualification-dormancy.ts')
const hasCanonicalLifecycleRuntime = await readFile(
  resolve(repositoryRoot, 'services/bayn/node_modules/effect/package.json'),
  'utf8',
)
  .then((manifest) => (JSON.parse(manifest) as { readonly version?: unknown }).version === '4.0.0-beta.102')
  .catch(() => false)
const lifecycleTest = hasCanonicalLifecycleRuntime ? test : test.skip

describe('qualification dormancy command', () => {
  lifecycleTest('delegates the checked-out lineage to the service lifecycle decision', async () => {
    const decision = await verifyQualificationDormancy(repositoryRoot)
    expect(decision).toEqual({
      status: 'dormant',
      reason: 'development-not-approved',
      candidateOrdinal: 24,
    })
  })

  test('maps only explicit lifecycle eligibility to a runnable workflow output', () => {
    const reviewedOnly = {
      status: 'dormant',
      reason: 'development-not-approved',
      candidateOrdinal: 21,
    } satisfies QualificationLifecycleDecision
    expect(qualificationWorkflowOutputs(reviewedOnly)).toMatchObject({ eligible: 'false', dormant: 'true' })

    expect(
      qualificationWorkflowOutputs({
        status: 'dormant',
        reason: 'development-rejected',
        candidateOrdinal: 21,
      }),
    ).toEqual({
      eligible: 'false',
      dormant: 'true',
      reason: 'development-rejected',
      candidateOrdinal: '21',
    })
    expect(
      qualificationWorkflowOutputs({
        status: 'ready',
        reason: 'qualification-eligible',
        candidateOrdinal: 21,
        preregistrationSourceRevision: 'a'.repeat(40),
        preregistrationBlobOid: 'b'.repeat(40),
      }),
    ).toEqual({
      eligible: 'true',
      dormant: 'false',
      reason: 'qualification-eligible',
      candidateOrdinal: '21',
    })
  })

  lifecycleTest('writes closed workflow outputs without exposing credential material', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bayn-qualification-dormancy-'))
    try {
      const githubOutput = join(directory, 'github-output')
      const child = Bun.spawn(
        [process.execPath, verifierPath, '--repository-root', repositoryRoot, '--github-output', githubOutput],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])

      expect(exitCode).toBe(0)
      expect(stderr).toBe('')
      expect(stdout).toContain('"status":"dormant"')
      expect(await readFile(githubOutput, 'utf8')).toBe(
        'eligible=false\ndormant=true\nreason=development-not-approved\ncandidate_ordinal=24\n',
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  lifecycleTest('fails closed on malformed lineage without writing a workflow output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bayn-qualification-malformed-'))
    try {
      const ledgerDirectory = join(directory, 'services/bayn/src/candidate-development-trials')
      await mkdir(ledgerDirectory, { recursive: true })
      await writeFile(
        join(ledgerDirectory, 'ledger.ts'),
        'export const candidateDevelopmentTrialLedgerState = {}\n',
        'utf8',
      )
      const githubOutput = join(directory, 'github-output')
      const child = Bun.spawn(
        [process.execPath, verifierPath, '--repository-root', directory, '--github-output', githubOutput],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, BAYN_QUALIFICATION_PASSWORD: 'must-not-be-printed' },
        },
      )
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])

      expect(exitCode).toBe(1)
      expect(stdout).toBe('')
      expect(stderr).toContain('ledger: INVALID_STATE')
      expect(`${stdout}${stderr}`).not.toContain('must-not-be-printed')
      await access(githubOutput).then(
        () => {
          throw new Error('malformed lineage unexpectedly wrote GitHub outputs')
        },
        (error) => {
          expect(error).toMatchObject({ code: 'ENOENT' })
        },
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('keeps lifecycle validation in the service instead of reimplementing it in the adapter', async () => {
    const source = await readFile(verifierPath, 'utf8')

    expect(source).toContain('decideQualificationDormancy')
    expect(source).not.toContain('Bun.Transpiler')
    expect(source).not.toContain('scanImports')
    expect(source).not.toContain('Bun.spawn')
    expect(source).not.toContain('node:child_process')
    expect(source).not.toContain('createHash')
    expect(source).not.toContain('realpath')
    expect(source).not.toContain('stat(')
  })

  lifecycleTest('delegates malformed lineage validation to the service lifecycle decision', async () => {
    expect(await evaluateQualificationDormancy({})).toMatchObject({
      ok: false,
      issue: { path: 'history.schemaVersion', reason: 'UNSUPPORTED_SCHEMA' },
    })
  })
})
