import { describe, expect, test } from 'bun:test'

import {
  baynPromotionAutomergeRequiredChecks,
  decideBaynPromotionAutomerge,
  parseBaynPromotionAutomergeArguments,
  parseBaynPromotionAutomergeSnapshot,
  type BaynPromotionAutomergeSnapshot,
} from './verify-promotion-automerge'

const repository = 'proompteng/lab'
const headSha = 'a'.repeat(40)
const baseSha = 'b'.repeat(40)
const pullNumber = 13_411

const check = (workflow: string, name: string, state = 'SUCCESS') => ({
  workflow,
  name,
  state,
  link: `https://github.com/${repository}/actions/runs/123456/job/789012`,
})

const snapshot = (): BaynPromotionAutomergeSnapshot => ({
  repository,
  defaultBranchSha: baseSha,
  pullRequest: {
    number: pullNumber,
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    headRefName: 'codex/bayn-release-current',
    headRefOid: headSha,
    headRepository: repository,
    baseRefName: 'main',
    baseRefOid: baseSha,
    autoMergeEnabled: false,
    labels: [],
    files: [
      { path: 'argocd/applications/bayn/deployment.yaml', status: 'MODIFIED' },
      { path: 'argocd/applications/bayn/kustomization.yaml', status: 'MODIFIED' },
    ],
  },
  checks: [
    ...baynPromotionAutomergeRequiredChecks.map(({ workflow, name }) => check(workflow, name)),
    check('CI', 'Agents CI', 'SKIPPED'),
    check('bayn', 'image', 'SKIPPED'),
    check('bayn-promotion-eligibility', 'Refresh eligible promotion gate', 'SKIPPED'),
    check('bayn-promotion-automerge', 'Merge verified Bayn promotion', 'IN_PROGRESS'),
  ],
})

const expected = { repository, pullNumber, headSha, defaultBranchSha: baseSha }

const decisionCode = (value: BaynPromotionAutomergeSnapshot): string => {
  const decision = decideBaynPromotionAutomerge(expected, value)
  return decision.status === 'hold' ? decision.code : 'eligible'
}

describe('Bayn promotion auto-merge decision', () => {
  test('accepts the exact current-base reviewed promotion and ignores only its own in-flight check', () => {
    expect(decideBaynPromotionAutomerge(expected, snapshot())).toEqual({
      status: 'eligible',
      prNumber: pullNumber,
      headSha,
      baseSha,
    })
  })

  test('rejects changed heads, stale bases, forks, drafts, and non-clean merge state', () => {
    const cases: readonly [BaynPromotionAutomergeSnapshot, string][] = [
      [
        {
          ...snapshot(),
          pullRequest: { ...snapshot().pullRequest, headRefOid: '1'.repeat(40) },
        },
        'pull-request-head-mismatch',
      ],
      [
        {
          ...snapshot(),
          pullRequest: { ...snapshot().pullRequest, baseRefOid: '2'.repeat(40) },
        },
        'pull-request-base-mismatch',
      ],
      [
        {
          ...snapshot(),
          pullRequest: { ...snapshot().pullRequest, headRepository: 'attacker/lab' },
        },
        'pull-request-shape-mismatch',
      ],
      [
        {
          ...snapshot(),
          pullRequest: { ...snapshot().pullRequest, isDraft: true },
        },
        'pull-request-draft',
      ],
      [
        {
          ...snapshot(),
          pullRequest: { ...snapshot().pullRequest, mergeStateStatus: 'BEHIND' },
        },
        'pull-request-not-mergeable',
      ],
    ]

    for (const [input, code] of cases) expect(decisionCode(input)).toBe(code)
  })

  test('rejects competing auto-merge state and the explicit opt-out label', () => {
    expect(
      decisionCode({
        ...snapshot(),
        pullRequest: { ...snapshot().pullRequest, autoMergeEnabled: true },
      }),
    ).toBe('automerge-already-enabled')
    expect(
      decisionCode({
        ...snapshot(),
        pullRequest: { ...snapshot().pullRequest, labels: ['do-not-automerge'] },
      }),
    ).toBe('automerge-opted-out')
  })

  test('requires all release-owned manifests and permits only the optional ApplicationSet update', () => {
    const missing = snapshot()
    const extra = snapshot()
    const renamed = snapshot()

    expect(
      decisionCode({
        ...missing,
        pullRequest: { ...missing.pullRequest, files: missing.pullRequest.files.slice(0, 1) },
      }),
    ).toBe('promotion-paths-mismatch')
    const enabled = snapshot()
    expect(
      decisionCode({
        ...enabled,
        pullRequest: {
          ...enabled.pullRequest,
          files: [...enabled.pullRequest.files, { path: 'argocd/applicationsets/product.yaml', status: 'MODIFIED' }],
        },
      }),
    ).toBe('eligible')
    expect(
      decisionCode({
        ...extra,
        pullRequest: {
          ...extra.pullRequest,
          files: [...extra.pullRequest.files, { path: 'services/bayn/src/index.ts', status: 'MODIFIED' }],
        },
      }),
    ).toBe('promotion-paths-mismatch')
    expect(
      decisionCode({
        ...renamed,
        pullRequest: {
          ...renamed.pullRequest,
          files: [{ ...renamed.pullRequest.files[0], status: 'RENAMED' }, renamed.pullRequest.files[1]],
        },
      }),
    ).toBe('promotion-paths-mismatch')
  })

  test('rejects missing, duplicate, pending, failed, or skipped required checks', () => {
    const required = baynPromotionAutomergeRequiredChecks[0]
    const requiredKey = `${required.workflow}/${required.name}`
    const withoutRequired = snapshot()
    const requiredIndex = withoutRequired.checks.findIndex(
      ({ workflow, name }) => `${workflow}/${name}` === requiredKey,
    )
    const missingChecks = withoutRequired.checks.filter((_, index) => index !== requiredIndex)
    expect(decisionCode({ ...withoutRequired, checks: missingChecks })).toBe('required-check-missing')

    for (const state of ['IN_PROGRESS', 'FAILURE', 'SKIPPED']) {
      const value = snapshot()
      const checks = value.checks.map((item) =>
        `${item.workflow}/${item.name}` === requiredKey ? { ...item, state } : item,
      )
      expect(decisionCode({ ...value, checks })).toBe('required-check-not-successful')
    }

    const duplicate = snapshot()
    expect(
      decisionCode({
        ...duplicate,
        checks: [...duplicate.checks, check(required.workflow, required.name)],
      }),
    ).toBe('check-evidence-ambiguous')
  })

  test('rejects untrusted check links and non-successful non-allowlisted checks', () => {
    const untrusted = snapshot()
    expect(
      decisionCode({
        ...untrusted,
        checks: untrusted.checks.map((item, index) =>
          index === 0 ? { ...item, link: 'https://attacker.invalid/check/1' } : item,
        ),
      }),
    ).toBe('check-evidence-untrusted')

    const failedOptional = snapshot()
    expect(
      decisionCode({
        ...failedOptional,
        checks: [...failedOptional.checks, check('Security', 'Scan', 'FAILURE')],
      }),
    ).toBe('unexpected-check-not-successful')
  })

  test('parses only complete snapshots and exact CLI bindings', () => {
    expect(parseBaynPromotionAutomergeSnapshot(snapshot())).toEqual(snapshot())
    expect(() => parseBaynPromotionAutomergeSnapshot({ ...snapshot(), checks: [{}] })).toThrow(
      'snapshot.checks[0].workflow must be a string',
    )
    expect(
      parseBaynPromotionAutomergeArguments([
        '--repository',
        repository,
        '--pull-number',
        String(pullNumber),
        '--head-sha',
        headSha,
        '--default-branch-sha',
        baseSha,
        '--snapshot-path',
        '/tmp/snapshot.json',
      ]),
    ).toEqual({
      repository,
      pullNumber,
      headSha,
      defaultBranchSha: baseSha,
      snapshotPath: '/tmp/snapshot.json',
    })
    expect(() =>
      parseBaynPromotionAutomergeArguments([
        '--repository',
        repository,
        '--pull-number',
        String(pullNumber),
        '--head-sha',
        'main',
        '--default-branch-sha',
        baseSha,
        '--snapshot-path',
        '/tmp/snapshot.json',
      ]),
    ).toThrow('--head-sha must be a lowercase 40-character commit SHA')
  })
})
