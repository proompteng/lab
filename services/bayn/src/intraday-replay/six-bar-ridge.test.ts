import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'

import { canonicalHashV1OrThrow as hash, sha256 } from '../hash'
import { checkProperty } from '../testing/property-test-support'
import { sixBarResearchDefinition } from './six-bar-features'
import {
  decodeSixBarRidgeArtifact,
  scoreSixBarRidge,
  sixBarRidgeRecipe,
  type SixBarRidgeArtifact,
} from './six-bar-ridge'
import { fitSixBarRidge, SixBarRidgeLabelStatus, SixBarRidgePartition } from './six-bar-ridge-fit'

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
  featureEvidenceHash: sha256(`synthetic-${date}-${index}-${symbol}`),
  availableAt: `${date}T13:${String(30 + index).padStart(2, '0')}:58.000Z`,
  decisionAt: `${date}T13:${String(31 + index).padStart(2, '0')}:00.000Z`,
  values,
})
const input = (
  days: { date: string; rows: Row[] }[] = [
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
  const session = (date: string, partition: SixBarRidgePartition) => ({
    date,
    partition,
    openAt: `${date}T13:30:00.000Z`,
    closeAt: `${date}T20:00:00.000Z`,
    firstDecisionAt: `${date}T13:31:00.000Z`,
    requiredFeatureRowHashes: rows
      .filter((entry) => entry.features.sessionDate === date)
      .map((entry) => hash(entry.features))
      .sort(),
  })
  return {
    manifest: {
      schemaVersion: 'bayn.six-bar-ridge-training-manifest.v1',
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
const score = (artifact: SixBarRidgeArtifact, values: number[], symbol = 'AAPL') =>
  Result.getOrThrow(scoreSixBarRidge(artifact, [feature(values, '2026-09-04', 0, symbol)], binding(artifact)))
const rebindRows = (data: Input) => {
  for (const session of data.manifest.sessions)
    session.requiredFeatureRowHashes = data.rows
      .filter((entry) => entry.features.sessionDate === session.date)
      .map((entry) => hash(entry.features))
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
      fc.property(fc.boolean(), (reverse) => {
        const data = input()
        const first = fitted(data)
        const second = fitted({ ...data, rows: reverse ? [...data.rows].reverse() : [...data.rows] })
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
    if (mutation === 'version') changed['schemaVersion'] = 'bayn.six-bar-ridge-artifact.v2'
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
    expect(Result.isFailure(scoreSixBarRidge(changed, [feature(zeros)], binding(artifact)))).toBe(true)
  })

  test('selects only strictly positive scores and breaks exact ties by ascending symbol', () => {
    const artifact = fitted()
    const values = [1, 1, 0, 0, 0, 0, 0]
    const candidates = [feature(values, '2026-09-04', 0, 'MSFT'), feature(values, '2026-09-04', 0, 'AAPL')]
    expect(Result.getOrThrow(scoreSixBarRidge(artifact, candidates, binding(artifact))).selectedSymbol).toBe('AAPL')
    expect(Result.getOrThrow(scoreSixBarRidge(artifact, [], binding(artifact))).selectedSymbol).toBeNull()
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
      expect(Result.isFailure(scoreSixBarRidge(artifact, candidates, binding(artifact)))).toBe(true)
  })
})
