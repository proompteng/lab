import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'

import { canonicalHashV1OrThrow as hash, sha256 } from '../hash'
import { checkProperty } from '../testing/property-test-support'
import { sixBarResearchDefinition } from './six-bar-features'
import {
  decodeSixBarRidgeArtifact,
  scoreSixBarRidge,
  SixBarRidgePartition,
  sixBarRidgeRecipe,
  type SixBarRidgeArtifact,
} from './six-bar-ridge'
import { fitSixBarRidge, SixBarRidgeLabelStatus } from './six-bar-ridge-fit'

const zeros: [number, number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0, 0]
const definitionHash = hash(sixBarResearchDefinition)
const row = (values: number[], targetBps: number, status = SixBarRidgeLabelStatus.Resolved) => ({
  values,
  pnlMicros: String(Math.round(targetBps * 2_000_000)),
  status,
})
type Row = ReturnType<typeof row>
const feature = (values: number[], date = '2026-09-04', index = 0, symbol = 'AAPL') => ({
  sessionDate: date,
  symbol,
  featureDefinitionHash: definitionHash,
  sourceManifestHash: sha256('synthetic-source'),
  calendarHash: sha256('synthetic-calendar'),
  featureEvidenceHash: sha256(`synthetic-${date}-${index}-${symbol}`),
  availableAt: `${date}T13:${String(30 + index).padStart(2, '0')}:58.000Z`,
  decisionAt: `${date}T13:${String(31 + index).padStart(2, '0')}:00.000Z`,
  values,
})
const input = (
  days: { date: `${number}-${number}-${number}`; rows: Row[] }[] = [
    {
      date: '2026-09-01',
      rows: [row([-1, -1, 0, 0, 0, 0, 0], -3), row([1, 1, 0, 0, 0, 0, 0], 9)],
    },
  ],
) => {
  const rows = days.flatMap((day) =>
    day.rows.map((entry, index) => ({
      features: feature(entry.values, day.date, index),
      label: {
        status: entry.status,
        netExecutionPnlMicros: entry.pnlMicros,
        completeAt: `${day.date}T14:00:00.000Z`,
        evidenceHash: sha256(`synthetic-label-${day.date}-${index}`),
      },
    })),
  )
  const session = (date: `${number}-${number}-${number}`, partition: SixBarRidgePartition) => ({
    date,
    partition,
    openAt: `${date}T13:30:00.000Z`,
    closeAt: `${date}T20:00:00.000Z`,
    firstDecisionAt: `${date}T13:31:00.000Z`,
    requiredTrainingRowHashes: rows
      .filter((entry) => entry.features.sessionDate === date)
      .map((entry) => hash(entry))
      .sort(),
  })
  return {
    manifest: {
      schemaVersion: 'bayn.six-bar-ridge-training-manifest.v2',
      featureDefinitionHash: definitionHash,
      recipeHash: hash(sixBarRidgeRecipe),
      provenance: {
        sourceRevision: '1'.repeat(40),
        sourceManifestHash: sha256('synthetic-source'),
        labelDefinitionHash: sha256('synthetic-fixed-budget-labels'),
        calendarHash: sha256('synthetic-calendar'),
      },
      allocationBudgetMicros: '20000000000',
      fitCutoffAt: '2026-09-04T00:00:00.000Z',
      sessions: [
        ...days.map((day) => session(day.date, SixBarRidgePartition.Training)),
        session('2026-09-04', SixBarRidgePartition.Validation),
        session('2026-09-08', SixBarRidgePartition.Holdout),
      ],
    },
    rows,
  }
}
type Input = ReturnType<typeof input>
const fit = ({ manifest, rows }: Input) => fitSixBarRidge(manifest, rows, hash(manifest))
const fitted = (data = input()) => Result.getOrThrow(fit(data))
const binding = (artifact: SixBarRidgeArtifact) => ({
  artifactHash: artifact.artifactHash,
  manifestHash: artifact.manifestHash,
  sourceRevision: artifact.provenance.sourceRevision,
})
const scoringBinding = (artifact: SixBarRidgeArtifact, candidates = [feature(zeros)], date = '2026-09-04') => ({
  artifact: binding(artifact),
  evaluation: {
    sourceManifestHash: sha256('synthetic-source'),
    calendarHash: sha256('synthetic-calendar'),
    requiredFeatureRowHashes: candidates.map((candidate) => hash(candidate)).sort(),
    sessionDate: date,
    partition: date === '2026-09-08' ? SixBarRidgePartition.Holdout : SixBarRidgePartition.Validation,
    decisionAt: `${date}T13:31:00.000Z`,
  },
})
const score = (artifact: SixBarRidgeArtifact, values: number[], symbol = 'AAPL') => {
  const candidates = [feature(values, '2026-09-04', 0, symbol)]
  return Result.getOrThrow(scoreSixBarRidge(artifact, candidates, scoringBinding(artifact, candidates)))
}
const rebindRows = (data: Input) => {
  for (const session of data.manifest.sessions)
    session.requiredTrainingRowHashes = data.rows
      .filter((entry) => entry.features.sessionDate === session.date)
      .map((entry) => hash(entry))
      .sort()
  return data
}
const rehashArtifact = (artifact: SixBarRidgeArtifact) => {
  const { artifactHash: _, ...payload } = artifact
  return { ...payload, artifactHash: hash(payload) }
}

describe('offline six-bar ridge numeric oracles', () => {
  test('fits all seven orthogonal columns with normalized lambda and an unpenalized intercept', () => {
    const values = [
      [1, 1, 1, 1, 1, 1, 1],
      [-1, 1, -1, 1, -1, 1, -1],
      [1, -1, -1, 1, 1, -1, -1],
      [-1, -1, 1, 1, -1, -1, 1],
      [1, 1, 1, -1, -1, -1, -1],
      [-1, 1, -1, -1, 1, -1, 1],
      [1, -1, -1, -1, -1, 1, 1],
      [-1, -1, 1, -1, 1, 1, -1],
    ]
    const targets = [61, -3, -11, 5, -27, 5, 5, 5]
    const artifact = fitted(input([{ date: '2026-09-01', rows: values.map((value, i) => row(value, targets[i]!)) }]))
    expect(artifact.trainingTargetMeanBps).toBeCloseTo(5, 12)
    expect(artifact.intercept).toBeCloseTo(5, 12)
    expect(artifact.means).toEqual(zeros)
    expect(artifact.scales).toEqual([1, 1, 1, 1, 1, 1, 1])
    artifact.coefficients.forEach((coefficient, index) => expect(coefficient).toBeCloseTo(index + 1, 12))
    expect(score(artifact, [1, 1, 1, 1, 1, 1, 1]).scores[0]!.scoreBps).toBeCloseTo(33, 12)
    expect(score(artifact, [-1, -1, -1, -1, -1, -1, -1]).selectedSymbol).toBeNull()
    expect(artifact.qualification).toBe('UNQUALIFIED')
    expect(artifact.controllerCoverage).toBe('UNKNOWN')
  })

  test('solves collinear features without a pseudoinverse', () => {
    const artifact = fitted()
    artifact.coefficients.forEach((value, index) => expect(value).toBeCloseTo(index < 2 ? 2 : 0, 13))
    expect(artifact.intercept).toBe(3)
    expect(score(artifact, [1, 1, 0, 0, 0, 0, 0]).scores).toEqual([{ symbol: 'AAPL', scoreBps: 7 }])
  })

  test.each([
    [1, 1 + Number.EPSILON, Number.EPSILON / 2],
    [1e16, 1e16 + 2, 1],
  ])('uses population variance when the mean of %p and %p is not representable', (left, right, scale) => {
    const artifact = fitted(
      input([{ date: '2026-09-01', rows: [row([left, 0, 0, 0, 0, 0, 0], -1), row([right, 0, 0, 0, 0, 0, 0], 1)] }]),
    )
    expect(artifact.trainingTargetMeanBps).toBe(0)
    expect(artifact.intercept).toBeCloseTo(-0.5, 14)
    expect(artifact.scales[0]).toBe(scale)
    expect(artifact.coefficients[0]).toBeCloseTo(0.5, 14)
    expect(score(artifact, [left, 0, 0, 0, 0, 0, 0]).scores[0]!.scoreBps).toBeCloseTo(-0.5, 14)
    expect(score(artifact, [right, 0, 0, 0, 0, 0, 0]).scores[0]!.scoreBps).toBeCloseTo(0.5, 14)
  })

  test('weights nonempty days equally and retains empty days without fabricated rows', () => {
    const artifact = fitted(
      input([
        { date: '2026-09-01', rows: [row([-1, 0, 0, 0, 0, 0, 0], 2), row([1, 0, 0, 0, 0, 0, 0], 4)] },
        { date: '2026-09-02', rows: [] },
        { date: '2026-09-03', rows: [row([3, 0, 0, 0, 0, 0, 0], 10)] },
      ]),
    )
    expect(artifact.means[0]).toBe(1.5)
    expect(artifact.scales[0]).toBeCloseTo(1.65831239517769992455746636833534334, 13)
    expect(artifact.coefficients[0]).toBeCloseTo(1.73369023132214083021916938507785895, 13)
    expect(artifact.trainingTargetMeanBps).toBeCloseTo(6.5, 13)
    expect(artifact.intercept).toBeCloseTo(6.5, 13)
    expect(artifact.nonemptyTrainingDays).toBe(2)
    expect(artifact.trainingRows).toBe(3)
    expect(artifact.trainingSessions).toEqual([
      { date: '2026-09-01', rowCount: 2 },
      { date: '2026-09-02', rowCount: 0 },
      { date: '2026-09-03', rowCount: 1 },
    ])
    expect(score(artifact, zeros).scores[0]!.scoreBps).toBeCloseTo(4.93181818181818181818181818181818182, 13)
    expect(score(artifact, [3, 0, 0, 0, 0, 0, 0]).scores[0]!.scoreBps).toBeCloseTo(
      8.06818181818181818181818181818181818,
      13,
    )
  })

  test('uses the fixed allocation for partial fills and zero for no entry fill', () => {
    const data = input([
      {
        date: '2026-09-01',
        rows: [
          row([1, 2, 3, 4, 5, 6, 7], 25),
          row([1, 2, 3, 4, 5, 6, 7], 50),
          row([1, 2, 3, 4, 5, 6, 7], 0, SixBarRidgeLabelStatus.NoEntryFill),
        ],
      },
    ])
    expect(data.rows.map((entry) => entry.label.netExecutionPnlMicros)).toEqual(['50000000', '100000000', '0'])
    const artifact = fitted(data)
    expect(artifact.intercept).toBeCloseTo(25, 13)
    expect(artifact.scales).toEqual(zeros)
    expect(artifact.coefficients).toEqual(zeros)
    expect(score(artifact, [9, 8, 7, 6, 5, 4, 3]).scores[0]!.scoreBps).toBeCloseTo(25, 13)
    const doubled = fitted({ ...data, manifest: { ...data.manifest, allocationBudgetMicros: '40000000000' } })
    expect(doubled.intercept).toBeCloseTo(12.5, 13)
  })

  test('property: row permutations reproduce coefficients and every artifact byte', () => {
    checkProperty(
      'six-bar-ridge-row-permutation',
      fc.property(fc.shuffledSubarray([0, 1, 2, 3, 4, 5, 6, 7], { minLength: 8, maxLength: 8 }), (order) => {
        const data = input([
          {
            date: '2026-09-01',
            rows: Array.from({ length: 8 }, (_, index) => row([index - 4, 0, 0, 0, 0, 0, 0], index * 3)),
          },
        ])
        const first = fitted(data)
        const second = fitted({ ...data, rows: order.map((index) => data.rows[index]!) })
        expect(second).toEqual(first)
      }),
    )
  })

  test('property: training-day row replication preserves the normalized fit', () => {
    checkProperty(
      'six-bar-ridge-day-replication',
      fc.property(fc.integer({ min: 1, max: 8 }), (copies) => {
        const rows = Array.from({ length: copies }, () => [
          row([-1, 0, 0, 0, 0, 0, 0], 2),
          row([1, 0, 0, 0, 0, 0, 0], 4),
        ]).flat()
        const artifact = fitted(
          input([
            { date: '2026-09-01', rows },
            { date: '2026-09-03', rows: [row([3, 0, 0, 0, 0, 0, 0], 10)] },
          ]),
        )
        expect(artifact.coefficients[0]).toBeCloseTo(1.73369023132214083021916938507785895, 12)
        expect(artifact.intercept).toBeCloseTo(6.5, 12)
      }),
    )
  })
})

describe('offline six-bar ridge training boundaries', () => {
  test('rejects a changed manifest under the original pin', () => {
    const data = input(),
      pinned = hash(data.manifest)
    data.manifest.allocationBudgetMicros = '10000000000'
    expect(Result.isFailure(fitSixBarRidge(data.manifest, data.rows, pinned))).toBe(true)
  })

  test.each(['missing', 'duplicate', 'extra', 'tampered'] as const)('rejects %s required training rows', (mutation) => {
    const data = input()
    if (mutation === 'missing') data.rows.pop()
    if (mutation === 'duplicate') data.rows[1] = data.rows[0]!
    if (mutation === 'extra') data.rows.push(data.rows[0]!)
    if (mutation === 'tampered') data.rows[0]!.features.values[0] = 9
    expect(Result.isFailure(fit(data))).toBe(true)
  })

  test.each([null, 'UNRESOLVED', 'INCOMPLETE'])('rejects an unknown label %p', (status) => {
    const data = input()
    const rows = [{ ...data.rows[0], label: { ...data.rows[0]!.label, status } }, data.rows[1]]
    expect(Result.isFailure(fitSixBarRidge(data.manifest, rows, hash(data.manifest)))).toBe(true)
  })

  test('rejects null P&L and nonzero no-fill P&L', () => {
    const data = input()
    data.rows[0]!.label.status = SixBarRidgeLabelStatus.NoEntryFill
    expect(Result.isFailure(fit(data))).toBe(true)
    expect(
      Result.isFailure(
        fitSixBarRidge(
          data.manifest,
          [{ ...data.rows[0], label: { ...data.rows[0]!.label, netExecutionPnlMicros: null } }, data.rows[1]],
          hash(data.manifest),
        ),
      ),
    ).toBe(true)
  })

  test.each([
    'availability',
    'outcome-before-decision',
    'cutoff-equality',
    'evaluation-overlap',
    'outside-session',
  ] as const)('rejects %s', (mutation) => {
    const data = input(),
      first = data.rows[0]!
    if (mutation === 'availability') first.features.availableAt = '2026-09-01T13:32:00.000Z'
    if (mutation === 'outcome-before-decision') first.label.completeAt = '2026-09-01T13:30:00.000Z'
    if (mutation === 'cutoff-equality') first.label.completeAt = data.manifest.fitCutoffAt
    if (mutation === 'evaluation-overlap') first.label.completeAt = '2026-09-04T13:31:00.000Z'
    if (mutation === 'outside-session') first.features.decisionAt = '2026-09-01T20:00:00.000Z'
    expect(Result.isFailure(fit(rebindRows(data)))).toBe(true)
  })

  test('rejects validation or holdout rows and interleaved day partitions', () => {
    for (const partition of [SixBarRidgePartition.Validation, SixBarRidgePartition.Holdout]) {
      const data = input()
      data.manifest.sessions[0]!.partition = partition
      expect(Result.isFailure(fit(data))).toBe(true)
    }
    const data = input()
    data.manifest.sessions.reverse()
    expect(Result.isFailure(fit(data))).toBe(true)
  })

  test('has no holdout values or labels in the fitting interface', () => {
    const data = input(),
      artifact = fitted(data)
    const changed = structuredClone(data)
    changed.manifest.sessions[2]!.date = '2026-09-09'
    changed.manifest.sessions[2]!.openAt = '2026-09-09T13:30:00.000Z'
    changed.manifest.sessions[2]!.closeAt = '2026-09-09T20:00:00.000Z'
    changed.manifest.sessions[2]!.firstDecisionAt = '2026-09-09T13:31:00.000Z'
    const other = fitted(changed)
    expect(other.coefficients).toEqual(artifact.coefficients)
    expect(other.means).toEqual(artifact.means)
    expect(other.scales).toEqual(artifact.scales)
    expect(other.trainingDataHash).toBe(artifact.trainingDataHash)
    expect(other.manifestHash).not.toBe(artifact.manifestHash)
    expect(
      Result.isFailure(fitSixBarRidge({ ...data.manifest, holdoutLabels: [1] }, data.rows, hash(data.manifest))),
    ).toBe(true)
  })

  test.each(['sourceManifestHash', 'calendarHash'] as const)('rejects a training row from another %s', (field) => {
    const data = input()
    data.rows[0]!.features[field] = sha256('other-source-or-calendar')
    expect(Result.isFailure(fit(rebindRows(data)))).toBe(true)
  })

  test('rejects empty fitting mass, duplicate observations and foreign definitions', () => {
    expect(Result.isFailure(fit(input([{ date: '2026-09-01', rows: [] }])))).toBe(true)
    const duplicate = input()
    duplicate.rows[1]!.features.decisionAt = duplicate.rows[0]!.features.decisionAt
    duplicate.rows[1]!.features.availableAt = duplicate.rows[0]!.features.availableAt
    expect(Result.isFailure(fit(rebindRows(duplicate)))).toBe(true)
    const foreign = input()
    foreign.rows[0]!.features.featureDefinitionHash = sha256('different-feature-order')
    expect(Result.isFailure(fit(rebindRows(foreign)))).toBe(true)
  })

  test.each([NaN, Infinity, -Infinity])('rejects nonfinite training feature %p', (value) => {
    const data = input()
    data.rows[0]!.features.values[0] = value
    expect(Result.isFailure(fit(data))).toBe(true)
  })

  test.each([Number.MAX_VALUE, Number.MIN_VALUE, 1e-200])(
    'fails closed on unsafe nonconstant magnitude %p',
    (magnitude) => {
      const data = input([
        { date: '2026-09-01', rows: [row([-magnitude, 0, 0, 0, 0, 0, 0], -1), row([magnitude, 0, 0, 0, 0, 0, 0], 1)] },
      ])
      expect(Result.isFailure(fit(data))).toBe(true)
    },
  )

  test('retains exactly constant subnormal features and rejects inexact financial integers', () => {
    const artifact = fitted(input([{ date: '2026-09-01', rows: [row([Number.MIN_VALUE, 0, 0, 0, 0, 0, 0], 7)] }]))
    expect(artifact.means[0]).toBe(Number.MIN_VALUE)
    expect(artifact.scales).toEqual(zeros)
    expect(artifact.intercept).toBe(7)
    const data = input()
    data.rows[0]!.label.netExecutionPnlMicros = '9007199254740993'
    expect(Result.isFailure(fit(data))).toBe(true)
  })
})

describe('offline six-bar ridge artifact and scoring boundaries', () => {
  test('round-trips the artifact and pins independent expected identities', () => {
    const artifact = fitted()
    expect(
      Result.getOrThrow(decodeSixBarRidgeArtifact(JSON.parse(JSON.stringify(artifact)), binding(artifact))),
    ).toEqual(artifact)
    for (const field of ['artifactHash', 'manifestHash', 'sourceRevision'] as const) {
      expect(
        Result.isFailure(
          decodeSixBarRidgeArtifact(artifact, {
            ...binding(artifact),
            [field]: '0'.repeat(field === 'sourceRevision' ? 40 : 64),
          }),
        ),
      ).toBe(true)
    }
  })

  test.each([
    'version',
    'order',
    'scale',
    'constant-coefficient',
    'count',
    'recipe',
    'unknown-key',
    'nonfinite',
  ] as const)('rejects invalid artifact %s', (mutation) => {
    const artifact = fitted()
    const changed = structuredClone(artifact) as unknown as Record<string, unknown>
    if (mutation === 'version') changed['schemaVersion'] = 'bayn.six-bar-ridge-artifact.v1'
    if (mutation === 'order') changed['featureOrder'] = [...artifact.featureOrder].reverse()
    if (mutation === 'scale') changed['scales'] = [-1, ...artifact.scales.slice(1)]
    if (mutation === 'constant-coefficient') changed['coefficients'] = [2, 2, 1, 0, 0, 0, 0]
    if (mutation === 'count') changed['trainingRows'] = 9
    if (mutation === 'recipe') changed['recipeHash'] = sha256('lambda-two')
    if (mutation === 'unknown-key') changed['hidden'] = true
    if (mutation === 'nonfinite') changed['intercept'] = NaN
    if (mutation !== 'nonfinite') {
      delete changed['artifactHash']
      changed['artifactHash'] = hash(changed)
    }
    const expected = { ...binding(artifact), artifactHash: changed['artifactHash'] }
    expect(Result.isFailure(decodeSixBarRidgeArtifact(changed, expected))).toBe(true)
  })

  test('changed coefficients cannot pass the original artifact pin even after rehashing', () => {
    const artifact = fitted(),
      changed = rehashArtifact({ ...artifact, intercept: 999 })
    expect(Result.isFailure(scoreSixBarRidge(changed, [feature(zeros)], scoringBinding(artifact)))).toBe(true)
  })

  test('selects only strictly positive scores and breaks exact ties by ascending symbol', () => {
    const artifact = fitted()
    const values = [1, 1, 0, 0, 0, 0, 0]
    const candidates = [feature(values, '2026-09-04', 0, 'MSFT'), feature(values, '2026-09-04', 0, 'AAPL')]
    expect(
      Result.getOrThrow(scoreSixBarRidge(artifact, candidates, scoringBinding(artifact, candidates))).selectedSymbol,
    ).toBe('AAPL')
    expect(Result.getOrThrow(scoreSixBarRidge(artifact, [], scoringBinding(artifact, []))).selectedSymbol).toBeNull()
    expect(score(artifact, [-1, -1, 0, 0, 0, 0, 0]).selectedSymbol).toBeNull()
    const zero = fitted(input([{ date: '2026-09-01', rows: [row(zeros, 0)] }]))
    expect(score(zero, zeros).selectedSymbol).toBeNull()
    expect(score(artifact, values).selectedSymbol).toBe('AAPL')
  })

  test('rejects duplicate, future, premature, mismatched and nonfinite candidates', () => {
    const artifact = fitted(),
      valid = feature(zeros)
    const mutations = [
      [valid, valid],
      [{ ...valid, symbol: 'SPY' }],
      [{ ...valid, availableAt: '2026-09-04T13:32:00.000Z' }],
      [feature(zeros, '2026-09-01')],
      [valid, feature(zeros, '2026-09-04', 1, 'MSFT')],
      [{ ...valid, featureDefinitionHash: sha256('wrong') }],
      [{ ...valid, values: [NaN, 0, 0, 0, 0, 0, 0] }],
      [{ ...valid, values: [Number.MAX_VALUE, Number.MAX_VALUE, 0, 0, 0, 0, 0] }],
    ]
    for (const candidates of mutations)
      expect(Result.isFailure(scoreSixBarRidge(artifact, candidates, scoringBinding(artifact)))).toBe(true)
  })

  test('rejects the cutoff-to-evaluation gap and a false scoring session date', () => {
    const artifact = fitted(),
      valid = feature(zeros)
    expect(score(artifact, zeros).selectedSymbol).toBe('AAPL')
    const beforeEvaluation = { ...valid, decisionAt: '2026-09-04T13:30:59.999Z' }
    expect(Result.isFailure(scoreSixBarRidge(artifact, [beforeEvaluation], scoringBinding(artifact)))).toBe(true)
    const falseDate = { ...valid, sessionDate: '2026-09-08' }
    expect(Result.isFailure(scoreSixBarRidge(artifact, [falseDate], scoringBinding(artifact)))).toBe(true)
  })
})

describe('offline six-bar ridge declared evaluation binding', () => {
  test('retains evaluation sessions and accepts an independently pinned later capture', () => {
    const data = input(),
      artifact = fitted(data)
    expect(artifact.evaluationSessions).toEqual(
      data.manifest.sessions.slice(1).map(({ requiredTrainingRowHashes: _, ...session }) => session),
    )
    const candidate = { ...feature(zeros, '2026-09-08'), sourceManifestHash: sha256('later-holdout-capture') }
    const expected = scoringBinding(artifact, [candidate], '2026-09-08')
    expected.evaluation.sourceManifestHash = candidate.sourceManifestHash
    expect(candidate.sourceManifestHash).not.toBe(artifact.provenance.sourceManifestHash)
    expect(Result.getOrThrow(scoreSixBarRidge(artifact, [candidate], expected)).selectedSymbol).toBe('AAPL')
  })

  test.each(['sourceManifestHash', 'calendarHash'] as const)('rejects swapped candidate %s', (field) => {
    const artifact = fitted(),
      candidate = { ...feature(zeros), [field]: sha256('foreign') }
    expect(Result.isFailure(scoreSixBarRidge(artifact, [candidate], scoringBinding(artifact, [candidate])))).toBe(true)
  })

  test('rejects a foreign calendar even when every candidate agrees with it', () => {
    const artifact = fitted(),
      expected = scoringBinding(artifact)
    expected.evaluation.calendarHash = sha256('foreign-calendar')
    const candidate = { ...feature(zeros), calendarHash: expected.evaluation.calendarHash }
    for (const candidates of [[candidate], []]) {
      expected.evaluation.requiredFeatureRowHashes = candidates.map((entry) => hash(entry))
      expect(Result.isFailure(scoreSixBarRidge(artifact, candidates, expected))).toBe(true)
    }
  })

  test.each(['partition', 'training', 'undeclared', 'false-date', 'before-first', 'at-close', 'after-close'] as const)(
    'rejects %s evaluation context, including an empty candidate set',
    (mutation) => {
      const artifact = fitted(),
        expected = scoringBinding(artifact)
      if (mutation === 'partition') expected.evaluation.partition = SixBarRidgePartition.Holdout
      if (mutation === 'training') expected.evaluation.partition = SixBarRidgePartition.Training
      if (mutation === 'undeclared') {
        expected.evaluation.sessionDate = '2026-09-09'
        expected.evaluation.decisionAt = '2026-09-09T13:31:00.000Z'
      }
      if (mutation === 'false-date') expected.evaluation.decisionAt = '2026-09-08T13:31:00.000Z'
      if (mutation === 'before-first') expected.evaluation.decisionAt = '2026-09-04T13:30:59.999Z'
      if (mutation === 'at-close') expected.evaluation.decisionAt = '2026-09-04T20:00:00.000Z'
      if (mutation === 'after-close') expected.evaluation.decisionAt = '2026-09-04T20:00:00.001Z'
      const candidate = {
        ...feature(zeros),
        sessionDate: expected.evaluation.sessionDate,
        decisionAt: expected.evaluation.decisionAt,
      }
      for (const candidates of [[candidate], []]) {
        expected.evaluation.requiredFeatureRowHashes = candidates.map((entry) => hash(entry))
        expect(Result.isFailure(scoreSixBarRidge(artifact, candidates, expected))).toBe(true)
      }
    },
  )

  test('accepts the first decision and final instant before close but rejects pre-open features', () => {
    const artifact = fitted(),
      expected = scoringBinding(artifact)
    expect(Result.isSuccess(scoreSixBarRidge(artifact, [feature(zeros)], expected))).toBe(true)
    expected.evaluation.decisionAt = '2026-09-04T19:59:59.999Z'
    const candidate = { ...feature(zeros), decisionAt: expected.evaluation.decisionAt }
    expected.evaluation.requiredFeatureRowHashes = [hash(candidate)]
    expect(Result.isSuccess(scoreSixBarRidge(artifact, [candidate], expected))).toBe(true)
    expected.evaluation.requiredFeatureRowHashes = []
    expect(Result.isSuccess(scoreSixBarRidge(artifact, [], expected))).toBe(true)
    candidate.availableAt = '2026-09-04T13:29:59.999Z'
    expected.evaluation.requiredFeatureRowHashes = [hash(candidate)]
    expect(Result.isFailure(scoreSixBarRidge(artifact, [candidate], expected))).toBe(true)
  })

  test('rejects a mixed validation and holdout candidate batch', () => {
    const artifact = fitted()
    expect(
      Result.isFailure(
        scoreSixBarRidge(artifact, [feature(zeros), feature(zeros, '2026-09-08', 0, 'MSFT')], scoringBinding(artifact)),
      ),
    ).toBe(true)
  })

  test.each([
    'empty',
    'training',
    'partition-order',
    'reversed',
    'duplicate',
    'open',
    'close',
    'first-before-open',
    'first-at-close',
    'date',
    'first-evaluation',
    'training-overlap',
  ] as const)('rejects rehashed artifact with invalid evaluation %s', (mutation) => {
    const artifact = fitted()
    const changed = structuredClone(artifact) as unknown as Record<string, unknown>
    const sessions = structuredClone(artifact.evaluationSessions).map((session) => ({ ...session }))
    if (mutation === 'empty') sessions.length = 0
    if (mutation === 'training') sessions[0]!.partition = SixBarRidgePartition.Training
    if (mutation === 'partition-order') {
      sessions[0]!.partition = SixBarRidgePartition.Holdout
      sessions[1]!.partition = SixBarRidgePartition.Validation
    }
    if (mutation === 'reversed') sessions.reverse()
    if (mutation === 'duplicate') sessions[1] = sessions[0]!
    if (mutation === 'open') sessions[0]!.openAt = sessions[0]!.closeAt
    if (mutation === 'close') sessions[0]!.closeAt = sessions[0]!.firstDecisionAt
    if (mutation === 'first-before-open') sessions[0]!.firstDecisionAt = '2026-09-04T13:29:00.000Z'
    if (mutation === 'first-at-close') sessions[0]!.firstDecisionAt = sessions[0]!.closeAt
    if (mutation === 'date') sessions[0]!.date = '2026-09-05'
    if (mutation === 'first-evaluation') changed['firstEvaluationDecisionAt'] = '2026-09-04T13:32:00.000Z'
    if (mutation === 'training-overlap') changed['trainingSessions'] = [{ date: '2026-09-04', rowCount: 2 }]
    changed['evaluationSessions'] = sessions
    delete changed['artifactHash']
    changed['artifactHash'] = hash(changed)
    expect(
      Result.isFailure(
        decodeSixBarRidgeArtifact(changed, { ...binding(artifact), artifactHash: changed['artifactHash'] }),
      ),
    ).toBe(true)
  })
})

describe('offline six-bar ridge content pins', () => {
  test.each(['pnl', 'status', 'completeAt', 'evidenceHash'] as const)(
    'rejects changed label %s under the original complete training manifest pin',
    (mutation) => {
      const data = input([{ date: '2026-09-01', rows: [row(zeros, 0), row([1, 0, 0, 0, 0, 0, 0], 9)] }])
      const pinned = hash(data.manifest),
        originalFeatureHashes = data.rows.map((entry) => hash(entry.features))
      const label = data.rows[0]!.label
      if (mutation === 'pnl') label.netExecutionPnlMicros = '70000000'
      if (mutation === 'status') label.status = SixBarRidgeLabelStatus.NoEntryFill
      if (mutation === 'completeAt') label.completeAt = '2026-09-01T14:01:00.000Z'
      if (mutation === 'evidenceHash') label.evidenceHash = sha256('different-label-evidence')
      expect(data.rows.map((entry) => hash(entry.features))).toEqual(originalFeatureHashes)
      expect(Result.isFailure(fitSixBarRidge(data.manifest, data.rows, pinned))).toBe(true)
    },
  )

  test('rejects changed values even with a newly asserted evidence hash', () => {
    const artifact = fitted(),
      expected = scoringBinding(artifact)
    const candidate = feature([10, 10, 0, 0, 0, 0, 0])
    candidate.featureEvidenceHash = hash(candidate.values)
    expect(Result.isFailure(scoreSixBarRidge(artifact, [candidate], expected))).toBe(true)
  })
})

describe('offline six-bar ridge exact candidate sets', () => {
  test('rejects changed values under unchanged source, calendar, and evidence IDs', () => {
    const artifact = fitted(),
      original = feature(zeros),
      expected = scoringBinding(artifact, [original])
    expect(Result.isSuccess(scoreSixBarRidge(artifact, [original], expected))).toBe(true)
    const changed = { ...original, values: [7, 7, 0, 0, 0, 0, 0] }
    expect(Result.isFailure(scoreSixBarRidge(artifact, [changed], expected))).toBe(true)
  })

  test('accepts candidate permutation but rejects missing, extra, duplicate, or substituted rows', () => {
    const artifact = fitted(),
      first = feature(zeros),
      second = feature(zeros, '2026-09-04', 0, 'MSFT')
    const expected = scoringBinding(artifact, [first, second])
    expect(Result.getOrThrow(scoreSixBarRidge(artifact, [first, second], expected))).toEqual(
      Result.getOrThrow(scoreSixBarRidge(artifact, [second, first], expected)),
    )
    const extra = feature(zeros, '2026-09-04', 0, 'GOOG')
    for (const candidates of [[], [first], [first, second, extra], [first, first], [first, extra]])
      expect(Result.isFailure(scoreSixBarRidge(artifact, candidates, expected))).toBe(true)
  })

  test('requires an independent unique expected set, including explicit empty pins for cash', () => {
    const artifact = fitted(),
      candidate = feature(zeros),
      expected = scoringBinding(artifact, [candidate])
    const { requiredFeatureRowHashes: _, ...withoutPins } = expected.evaluation
    expect(Result.isFailure(scoreSixBarRidge(artifact, [candidate], { ...expected, evaluation: withoutPins }))).toBe(
      true,
    )
    expected.evaluation.requiredFeatureRowHashes = [hash(candidate), hash(candidate)]
    expect(Result.isFailure(scoreSixBarRidge(artifact, [candidate, candidate], expected))).toBe(true)
    expected.evaluation.requiredFeatureRowHashes = [sha256('different-complete-row')]
    expect(Result.isFailure(scoreSixBarRidge(artifact, [candidate], expected))).toBe(true)
    expect(Result.isFailure(scoreSixBarRidge(artifact, [], expected))).toBe(true)
    expected.evaluation.requiredFeatureRowHashes = []
    expect(Result.getOrThrow(scoreSixBarRidge(artifact, [], expected)).selectedSymbol).toBeNull()
  })

  test('still rejects scoring overflow after independently pinned content validation', () => {
    const artifact = fitted(),
      candidate = feature([Number.MAX_VALUE, Number.MAX_VALUE, 0, 0, 0, 0, 0])
    expect(Result.isFailure(scoreSixBarRidge(artifact, [candidate], scoringBinding(artifact, [candidate])))).toBe(true)
  })

  test('rejects the weaker unpublished manifest and artifact versions', () => {
    const data = input()
    const legacyManifest = { ...data.manifest, schemaVersion: 'bayn.six-bar-ridge-training-manifest.v1' }
    expect(Result.isFailure(fitSixBarRidge(legacyManifest, data.rows, hash(legacyManifest)))).toBe(true)
    const artifact = fitted()
    expect(artifact.schemaVersion).toBe('bayn.six-bar-ridge-artifact.v2')
    expect(
      Result.isFailure(
        decodeSixBarRidgeArtifact({ ...artifact, schemaVersion: 'bayn.six-bar-ridge-artifact.v1' }, binding(artifact)),
      ),
    ).toBe(true)
    const { trainingTargetMeanBps: _, ...withoutMean } = artifact
    expect(Result.isFailure(decodeSixBarRidgeArtifact(withoutMean, binding(artifact)))).toBe(true)
    expect(
      Result.isFailure(decodeSixBarRidgeArtifact({ ...artifact, trainingTargetMeanBps: Infinity }, binding(artifact))),
    ).toBe(true)
  })
})
