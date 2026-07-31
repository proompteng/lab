import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import {
  evaluateQualificationDormancy,
  validateQualificationDormancyLoaderMessage,
  type QualificationCandidatePreregistration,
} from './verify-qualification-dormancy'

const verifierPath = resolve(import.meta.dir, 'verify-qualification-dormancy.ts')
const temporaryDirectories: string[] = []
const hash = (character: string): string => character.repeat(64)
const revision = (character: string): string => character.repeat(40)
const authoritativeImports = [
  "import { candidateDevelopmentCalendarContract } from './candidate-development'",
  "import { canonicalHashV1Result } from './hash'",
].join('\n')

const moduleSource = (history: unknown, prefix = ''): string =>
  `${authoritativeImports}\n${prefix}export const frozenCandidateDevelopmentTrialHistory = ${JSON.stringify(history)} as const\n`

const reviewedPreregistration = (): QualificationCandidatePreregistration => ({
  schemaVersion: 'bayn.candidate-development-next-preregistration.v1',
  candidateOrdinal: 3,
  priorTrialCount: 2,
  strategyProtocolHash: hash('1'),
  strategyIdentityHash: hash('2'),
  candidateDevelopmentProtocolHash: hash('3'),
  calendarHash: hash('4'),
  priorTrialsHash: hash('5'),
  modulePath: 'services/bayn/src/strategy/example/candidate-3.ts',
  moduleSha256: hash('6'),
  marketData: {
    schemaVersion: 'bayn.candidate-development-market-data-source.v1',
    snapshotId: hash('7'),
    finalizedSnapshotContentHash: hash('8'),
    inputManifestHash: hash('9'),
    boundedContentHash: hash('a'),
  },
  preregistration: {
    sourceRevision: revision('b'),
    path: 'services/bayn/candidates/ordinal-3-example-preregistration.json',
    blobOid: revision('c'),
  },
})

const trialHistory = (input?: {
  readonly schemaVersion?: 'bayn.candidate-development-trial-history.v1' | 'bayn.candidate-development-trial-history.v2'
  readonly next?: QualificationCandidatePreregistration | null
  readonly invalidation?: unknown
}): Record<string, unknown> => {
  const reviewed = reviewedPreregistration()
  const schemaVersion = input?.schemaVersion ?? 'bayn.candidate-development-trial-history.v1'
  return {
    schemaVersion,
    completedCandidateOrdinals: [1],
    developmentCandidateOrdinals: [2],
    latestReviewedCandidateLegacyPriorTrials: {},
    latestReviewedCandidatePriorTrials: {},
    latestTerminalEvidence: {},
    candidatePreregistration: {},
    latestReviewedCandidatePreregistration: reviewed,
    latestDevelopmentEvidence: {
      candidateOrdinal: 2,
      priorTrialCount: 1,
      status: 'DEVELOPMENT_REJECTED',
      evidenceContentHash: hash('d'),
      evaluatedSourceRevision: revision('e'),
      failureStage: 'development-evaluation',
      developmentMetricsObserved: true,
      qualificationAttemptConsumed: false,
    },
    nextCandidatePreregistration: input?.next === undefined ? reviewed : input.next,
    ...(schemaVersion === 'bayn.candidate-development-trial-history.v2'
      ? { latestInvalidPrecommit: input?.invalidation ?? null }
      : {}),
  }
}

const invalidPrecommit = (): Record<string, unknown> => {
  const reviewed = reviewedPreregistration()
  return {
    schemaVersion: 'bayn.candidate-development-precommit-invalidation.v1',
    candidateOrdinal: reviewed.candidateOrdinal,
    priorTrialCount: reviewed.priorTrialCount,
    status: 'PRECOMMIT_INVALID',
    attemptStatus: 'UNATTEMPTED',
    metricBearingAttemptsConsumed: 0,
    qualificationAttemptConsumed: false,
    reviewedHeadRevision: revision('f'),
    mergedSourceRevision: revision('0'),
    preregistration: {
      ...reviewed.preregistration,
      sha256: hash('b'),
    },
    sourceManifest: {
      path: 'services/bayn/candidates/ordinal-3-example-source-manifest.json',
      blobOid: revision('1'),
      sha256: hash('c'),
    },
    invalidatedModule: {
      path: reviewed.modulePath,
      blobOid: revision('2'),
      sha256: reviewed.moduleSha256,
      lineCount: 10,
      byteCount: 100,
      findings: [
        'TYPE_CHECK_DISABLED',
        'DOWNCOMPILED_BUNDLE',
        'EMBEDDED_OFFICIAL_SESSIONS',
        'EMBEDDED_MARKET_BARS',
        'RUNTIME_INPUT_IGNORED',
      ],
    },
    naturalBuild: {
      runId: '1234',
      imagePublished: true,
      imageDigest: `sha256:${hash('d')}`,
      deploymentAllowed: false,
    },
    release: {
      runId: '5678',
      conclusion: 'CANCELLED',
      promotionCompleted: false,
      rerunAllowed: false,
    },
    nextCandidatePreregistration: null,
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('qualification dormancy verifier', () => {
  test('returns a clean no-op when no preregistration is authorized', () => {
    expect(evaluateQualificationDormancy(trialHistory({ next: null }))).toEqual({
      status: 'dormant',
      reason: 'preregistration-missing',
      candidateOrdinal: null,
    })
  })

  test('returns a clean no-op for an unattempted invalid precommit', () => {
    expect(
      evaluateQualificationDormancy(
        trialHistory({
          schemaVersion: 'bayn.candidate-development-trial-history.v2',
          next: null,
          invalidation: invalidPrecommit(),
        }),
      ),
    ).toEqual({
      status: 'dormant',
      reason: 'precommit-invalid-unattempted',
      candidateOrdinal: 3,
    })
  })

  test('allows only the exact separately reviewed non-null preregistration', () => {
    expect(evaluateQualificationDormancy(trialHistory())).toEqual({
      status: 'ready',
      reason: 'reviewed-preregistration-present',
      candidateOrdinal: 3,
      preregistrationSourceRevision: revision('b'),
      preregistrationBlobOid: revision('c'),
    })
  })

  test('accepts exactly one closed authenticated IPC result', () => {
    const nonce = hash('f')
    const payload = JSON.stringify(trialHistory({ next: null }))
    const message = { type: 'result', nonce, payload }

    expect(validateQualificationDormancyLoaderMessage(message, nonce, null)).toBe(payload)
    for (const invalid of [
      null,
      { ...message, nonce: hash('e') },
      { ...message, type: 'bootstrap' },
      { ...message, payload: 1 },
      { ...message, extra: true },
    ]) {
      expect(() => validateQualificationDormancyLoaderMessage(invalid, nonce, null)).toThrow()
    }
    expect(() => validateQualificationDormancyLoaderMessage(message, 'not-a-nonce', null)).toThrow()
    expect(() => validateQualificationDormancyLoaderMessage(message, nonce, payload)).toThrow()
    expect(() =>
      validateQualificationDormancyLoaderMessage(
        { type: 'result', nonce, payload: 'x'.repeat(1024 * 1024 + 1) },
        nonce,
        null,
      ),
    ).toThrow()
  })

  test('fails closed on malformed, mismatched, and ambiguous evidence', () => {
    const reviewed = reviewedPreregistration()
    const mismatched: QualificationCandidatePreregistration = {
      ...reviewed,
      preregistration: { ...reviewed.preregistration, sourceRevision: revision('a') },
    }
    const invalidation = invalidPrecommit()
    invalidation.attemptStatus = 'ATTEMPTED'

    const malformed: unknown[] = [
      null,
      {},
      { ...trialHistory(), schemaVersion: 'bayn.candidate-development-trial-history.v3' },
      { ...trialHistory(), developmentCandidateOrdinals: [3] },
      { ...trialHistory(), nextCandidatePreregistration: mismatched },
      trialHistory({
        schemaVersion: 'bayn.candidate-development-trial-history.v2',
        next: null,
        invalidation,
      }),
      trialHistory({
        schemaVersion: 'bayn.candidate-development-trial-history.v2',
        next: reviewedPreregistration(),
        invalidation: invalidPrecommit(),
      }),
    ]

    for (const evidence of malformed) expect(() => evaluateQualificationDormancy(evidence)).toThrow()
  })

  test('runs against the fixed authoritative path and writes output only after a valid decision', () => {
    const cases = [
      {
        history: trialHistory({ next: null }),
        expected: ['dormant=true', 'reason=preregistration-missing', 'candidate_ordinal='],
      },
      {
        history: trialHistory({
          schemaVersion: 'bayn.candidate-development-trial-history.v2',
          next: null,
          invalidation: invalidPrecommit(),
        }),
        expected: ['dormant=true', 'reason=precommit-invalid-unattempted', 'candidate_ordinal=3'],
      },
      {
        history: trialHistory(),
        expected: ['dormant=false', 'reason=reviewed-preregistration-present', 'candidate_ordinal=3'],
      },
    ]

    for (const { history, expected } of cases) {
      const repository = mkdtempSync(join(tmpdir(), 'qualification-dormancy-test-'))
      temporaryDirectories.push(repository)
      const modulePath = join(repository, 'services/bayn/src/candidate-development-trial-history.ts')
      mkdirSync(dirname(modulePath), { recursive: true })
      writeFileSync(
        modulePath,
        moduleSource(
          history,
          `if (process.env.GITHUB_OUTPUT) throw new Error('workflow output leaked into the module')\n`,
        ),
      )
      const outputPath = join(repository, 'github-output')
      writeFileSync(outputPath, '')

      const result = Bun.spawnSync([
        process.execPath,
        verifierPath,
        '--repository-root',
        repository,
        '--github-output',
        outputPath,
      ])

      if (result.exitCode !== 0) {
        throw new Error(`valid evidence failed: ${result.stderr.toString()}`)
      }
      expect(result.stderr.toString()).toBe('')
      expect(readFileSync(outputPath, 'utf8')).toBe(`${expected.join('\n')}\n`)
    }
  })

  test('leaves no runnable output for missing, throwing, imported, or ambiguous evidence', () => {
    const moduleSources = [
      { label: 'missing', source: null },
      {
        label: 'throwing',
        source: moduleSource(trialHistory(), `throw new Error('unloadable')\n`),
      },
      {
        label: 'unsupported import',
        source: `${authoritativeImports}\nimport 'node:fs'\nexport const frozenCandidateDevelopmentTrialHistory = ${JSON.stringify(trialHistory())}\n`,
      },
      {
        label: 'ambiguous state',
        source: moduleSource(
          trialHistory({
            schemaVersion: 'bayn.candidate-development-trial-history.v2',
            next: reviewedPreregistration(),
            invalidation: invalidPrecommit(),
          }),
        ),
      },
      {
        label: 'bounded output',
        source: `${authoritativeImports}
const history = ${JSON.stringify(trialHistory())}
history.latestTerminalEvidence = { padding: 'x'.repeat(1024 * 1024 + 1) }
export const frozenCandidateDevelopmentTrialHistory = history
`,
      },
    ]

    for (const { label, source } of moduleSources) {
      const repository = mkdtempSync(join(tmpdir(), 'qualification-dormancy-failure-test-'))
      temporaryDirectories.push(repository)
      const modulePath = join(repository, 'services/bayn/src/candidate-development-trial-history.ts')
      mkdirSync(dirname(modulePath), { recursive: true })
      if (source !== null) writeFileSync(modulePath, source)
      const outputPath = join(repository, 'github-output')
      writeFileSync(outputPath, '')

      const result = Bun.spawnSync([
        process.execPath,
        verifierPath,
        '--repository-root',
        repository,
        '--github-output',
        outputPath,
      ])

      if (result.exitCode === 0) {
        throw new Error(`${label} evidence unexpectedly succeeded: ${result.stdout.toString()}`)
      }
      expect(readFileSync(outputPath, 'utf8')).toBe('')
    }
  })

  test('stops null, invalid, and malformed run shapes before fake image or privileged input access', () => {
    const cases = [
      {
        label: 'null preregistration',
        source: moduleSource(trialHistory({ next: null })),
        exitCode: 0,
        access: false,
      },
      {
        label: 'invalid unattempted precommit',
        source: moduleSource(
          trialHistory({
            schemaVersion: 'bayn.candidate-development-trial-history.v2',
            next: null,
            invalidation: invalidPrecommit(),
          }),
        ),
        exitCode: 0,
        access: false,
      },
      {
        label: 'malformed evidence',
        source: moduleSource({ ...trialHistory(), schemaVersion: 'bayn.candidate-development-trial-history.v3' }),
        exitCode: 1,
        access: false,
      },
      {
        label: 'reviewed preregistration',
        source: moduleSource(trialHistory()),
        exitCode: 0,
        access: true,
      },
    ]

    for (const testCase of cases) {
      const repository = mkdtempSync(join(tmpdir(), 'qualification-dormancy-run-shape-test-'))
      temporaryDirectories.push(repository)
      const modulePath = join(repository, 'services/bayn/src/candidate-development-trial-history.ts')
      mkdirSync(dirname(modulePath), { recursive: true })
      writeFileSync(modulePath, testCase.source)
      const outputPath = join(repository, 'github-output')
      const imageInput = join(repository, 'fake-image-input')
      const privilegedInput = join(repository, 'fake-privileged-input')
      const accessLog = join(repository, 'access-log')
      writeFileSync(outputPath, '')
      writeFileSync(imageInput, 'image\n')
      writeFileSync(privilegedInput, 'privileged\n')

      const script = `
set -euo pipefail
bun ${JSON.stringify(verifierPath)} --repository-root ${JSON.stringify(repository)} --github-output ${JSON.stringify(outputPath)}
dormant="$(sed -n 's/^dormant=//p' ${JSON.stringify(outputPath)})"
if [ "$dormant" = 'true' ]; then
  echo SAFE_NOOP
  exit 0
fi
cat ${JSON.stringify(imageInput)} ${JSON.stringify(privilegedInput)} > ${JSON.stringify(accessLog)}
echo PROCEEDED
`
      const result = Bun.spawnSync(['bash', '-c', script])

      expect(result.exitCode, testCase.label).toBe(testCase.exitCode)
      expect(existsSync(accessLog), testCase.label).toBe(testCase.access)
      if (testCase.access) {
        expect(readFileSync(accessLog, 'utf8')).toBe('image\nprivileged\n')
        expect(result.stdout.toString()).toContain('PROCEEDED')
      } else if (testCase.exitCode === 0) {
        expect(result.stdout.toString()).toContain('SAFE_NOOP')
      } else {
        expect(readFileSync(outputPath, 'utf8')).toBe('')
      }
    }
  })

  test('isolates hostile module evaluation from workflow outputs, secrets, files, and child processes', () => {
    const repository = mkdtempSync(join(tmpdir(), 'qualification-dormancy-hostile-loader-test-'))
    temporaryDirectories.push(repository)
    const modulePath = join(repository, 'services/bayn/src/candidate-development-trial-history.ts')
    const outputPath = join(repository, 'github-output')
    const sentinelPath = join(repository, 'sentinel')
    const childMarkerPath = join(repository, 'child-marker')
    mkdirSync(dirname(modulePath), { recursive: true })
    writeFileSync(outputPath, '')
    writeFileSync(sentinelPath, 'safe\n')
    const hostilePrefix = `
if (process.env.GITHUB_TOKEN || process.env.BAYN_POSTGRES_URL || process.env.GITHUB_OUTPUT) {
  throw new Error('privileged environment leaked')
}
try { process.send?.({ type: 'result', nonce: 'forged', payload: ${JSON.stringify(JSON.stringify(trialHistory()))} }) } catch {}
try { process.stdout.write('FORGED_TRIAL_HISTORY') } catch {}
try {
  const escapedProcess = globalThis.constructor.constructor('return process')()
  escapedProcess.stdout.write('FORGED_TRIAL_HISTORY')
  const fs = escapedProcess.getBuiltinModule('node:fs')
  for (const path of ${JSON.stringify([outputPath, sentinelPath])}) fs.writeFileSync(path, 'compromised\\n')
  escapedProcess.getBuiltinModule('node:child_process').spawnSync(escapedProcess.execPath, [
    '-e',
    ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(childMarkerPath)}, 'spawned')`)},
  ])
} catch {}
`
    writeFileSync(modulePath, moduleSource(trialHistory(), hostilePrefix))

    const result = Bun.spawnSync(
      [process.execPath, verifierPath, '--repository-root', repository, '--github-output', outputPath],
      {
        env: {
          ...process.env,
          GITHUB_TOKEN: 'must-not-reach-loader',
          BAYN_POSTGRES_URL: 'must-not-reach-loader',
          GITHUB_OUTPUT: outputPath,
        },
      },
    )

    if (result.exitCode !== 0) throw new Error(`hostile loader fixture failed: ${result.stderr.toString()}`)
    expect(result.stderr.toString()).toBe('')
    expect(result.stdout.toString()).not.toContain('FORGED_TRIAL_HISTORY')
    expect(result.stdout.toString().match(/BAYN_QUALIFICATION_DORMANCY=/g)).toHaveLength(1)
    expect(readFileSync(sentinelPath, 'utf8')).toBe('safe\n')
    expect(existsSync(childMarkerPath)).toBe(false)
    expect(readFileSync(outputPath, 'utf8')).toBe(
      'dormant=false\nreason=reviewed-preregistration-present\ncandidate_ordinal=3\n',
    )
  })
})
