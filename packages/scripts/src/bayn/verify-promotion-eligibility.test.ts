import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'
import { parse } from 'yaml'

import {
  baynPromotionCodexBotLogin,
  baynPromotionCodexReviewer,
  baynPromotionManifestPaths,
  baynReleaseSearchRange,
  baynWorkflowRunsUrl,
  createGitHubPromotionEligibilityLoader,
  createRefreshableBaynPromotionProvenanceLoader,
  evaluateBaynPromotionCurrentBaseRefresh,
  evaluateBaynPromotionEligibility,
  extractReleasePromotionEvidenceFromZip,
  extractReleaseContractFromZip,
  GitHubPromotionEligibilityError,
  isBaynPromotionBuildRunCandidate,
  isBaynPromotionCliFailure,
  isBaynPromotionSourceAffectingPath,
  parseBaynPromotionPins,
  parseVerifyPromotionArguments,
  pollBaynPromotionEligibility,
  resolveBaynPromotionReleaseRun,
  type BaynPromotionEligibilitySnapshot,
  type BaynPromotionCurrentBaseRefreshSnapshot,
  type BaynPromotionManifestContents,
  type BaynPromotionProvenance,
  type BaynPromotionPullRequest,
  type BaynPromotionReview,
  type BaynReleasePromotionEvidence,
} from './verify-promotion-eligibility'

const oldSourceSha = 'a'.repeat(40)
const sourceSha = 'b'.repeat(40)
const headSha = 'c'.repeat(40)
const staleHeadSha = 'd'.repeat(40)
const baseSha = 'e'.repeat(40)
const nextBaseSha = 'f'.repeat(40)
const oldDigest = `sha256:${'1'.repeat(64)}`
const digest = `sha256:${'2'.repeat(64)}`
const repository = 'proompteng/lab'
const pullNumber = 13400
const evaluationNowMs = Date.parse('2026-07-30T10:02:00Z')
const currentMainSha = '1'.repeat(40)

const buildWorkflowPath = new URL('../../../../.github/workflows/bayn-build-push.yml', import.meta.url)
const buildWorkflow = parse(readFileSync(buildWorkflowPath, 'utf8')) as {
  readonly on: { readonly push: { readonly paths?: readonly string[] } }
}

const representativeBuildTriggerPath = (pattern: string): string => {
  if (pattern === '**/package.json') return 'packages/fixture/package.json'
  if (pattern.endsWith('/**')) return `${pattern.slice(0, -3)}/fixture`
  if (pattern.includes('*')) return pattern.replace('*', 'fixture')
  return pattern
}

interface ManifestPins {
  readonly sourceSha: string
  readonly digest: string
  readonly tag: string
  readonly rolloutTimestamp: string
}

const deployment = (pins: ManifestPins): string => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: bayn
spec:
  template:
    metadata:
      annotations:
        kubectl.kubernetes.io/restartedAt: ${JSON.stringify(pins.rolloutTimestamp)}
    spec:
      enableServiceLinks: false
      containers:
        - name: bayn
          image: bayn-main
          env:
            - name: BAYN_CODE_REVISION
              value: ${pins.sourceSha}
            - name: BAYN_IMAGE_REPOSITORY
              value: registry.ide-newton.ts.net/lab/bayn
            - name: BAYN_IMAGE_DIGEST
              value: ${pins.digest}
            - name: BAYN_STRATEGY_BEHAVIOR_HASH
              value: "${'3'.repeat(64)}"
            - name: BAYN_STRATEGY_PARAMETER_HASH
              value: "${'4'.repeat(64)}"
            - name: BAYN_QUALIFICATION_RUN_ID
              value: "${'5'.repeat(64)}"
            - name: BAYN_SIGNAL_SNAPSHOT_ID
              value: "${'6'.repeat(64)}"
            - name: BAYN_SIGNAL_PUBLICATION_ASOF
              value: "2026-07-27"
            - name: BAYN_SIGNAL_CALENDAR_VERSION
              value: "alpaca-us-equity-calendar-v1"
            - name: BAYN_SIGNAL_DATA_START
              value: "2016-01-04"
            - name: BAYN_SIGNAL_DATA_END
              value: "2026-07-27"
            - name: BAYN_SIGNAL_LOOKBACK_START
              value: "2016-01-04"
            - name: BAYN_SIGNAL_EVALUATION_START
              value: "2017-01-03"
            - name: BAYN_SIGNAL_EVALUATION_END
              value: "2026-07-27"
            - name: BAYN_TIGERBEETLE_CLUSTER_ID
              value: "122731676035874920802382025803517750735"
            - name: BAYN_TIGERBEETLE_ADDRESSES
              value: "ledger-0:3000,ledger-1:3000,ledger-2:3000"
            - name: BAYN_TIGERBEETLE_LEDGER
              value: "7001"
`

const kustomization = (pins: ManifestPins): string => `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: bayn
resources:
  - deployment.yaml
images:
  - name: bayn-main
    newName: registry.ide-newton.ts.net/lab/bayn
    newTag: ${JSON.stringify(pins.tag)}
    digest: ${pins.digest}
`

const applicationSet = (enabled = true): string => `apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
spec:
  generators:
    - list:
        elements:
              - name: bayn
                path: argocd/applications/bayn
                namespace: bayn
                enabled: ${JSON.stringify(String(enabled))}
              - name: next-service
                enabled: "true"
`

const manifests = (pins: ManifestPins, enabled = true): BaynPromotionManifestContents => ({
  deployment: deployment(pins),
  kustomization: kustomization(pins),
  applicationSet: applicationSet(enabled),
})

const basePins: ManifestPins = {
  sourceSha: oldSourceSha,
  tag: `sha-${oldSourceSha}`,
  digest: oldDigest,
  rolloutTimestamp: '2026-07-30T09:00:00Z',
}

const headPins: ManifestPins = {
  sourceSha,
  tag: `sha-${sourceSha}`,
  digest,
  rolloutTimestamp: '2026-07-30T10:00:00Z',
}

const pullRequest = (overrides: Partial<BaynPromotionPullRequest> = {}): BaynPromotionPullRequest => ({
  number: pullNumber,
  title: `chore(bayn): promote image sha-${sourceSha}`,
  state: 'open',
  baseRefName: 'main',
  headRefName: 'codex/bayn-release-current',
  baseSha,
  headSha,
  headRepository: repository,
  createdAt: '2026-07-30T09:59:00Z',
  headCommittedAt: '2026-07-30T10:00:00Z',
  commitCount: 1,
  headForcePushes: [],
  files: [
    {
      path: 'argocd/applications/bayn/deployment.yaml',
      status: 'modified',
      previousPath: null,
    },
    {
      path: 'argocd/applications/bayn/kustomization.yaml',
      status: 'modified',
      previousPath: null,
    },
  ],
  ...overrides,
})

const review = (overrides: Partial<BaynPromotionReview> = {}): BaynPromotionReview => ({
  authorLogin: baynPromotionCodexReviewer,
  commitSha: headSha,
  submittedAt: '2026-07-30T10:01:00Z',
  state: 'COMMENTED',
  ...overrides,
})

const contract = () => ({
  service: 'bayn',
  image: 'registry.ide-newton.ts.net/lab/bayn',
  tag: `sha-${sourceSha}`,
  digest,
  reference: `registry.ide-newton.ts.net/lab/bayn@${digest}`,
  sourceSha,
  packageAttr: 'bayn-image',
  platforms: ['linux/amd64', 'linux/arm64'],
})

const provenance = (
  overrides: Partial<Extract<BaynPromotionProvenance, { status: 'resolved' }>> = {},
): BaynPromotionProvenance => ({
  status: 'resolved',
  buildRunId: 30532902039,
  releaseRunId: 30533142309,
  promotionPullNumber: pullNumber,
  promotionHeadSha: headSha,
  contract: contract(),
  ...overrides,
})

const promotionEvidence = (overrides: Partial<BaynReleasePromotionEvidence> = {}): BaynReleasePromotionEvidence => ({
  sourceSha,
  pullNumber,
  headSha,
  branch: 'codex/bayn-release-current',
  baseRefName: 'main',
  repository,
  operation: 'created',
  ...overrides,
})

const snapshot = (overrides: Partial<BaynPromotionEligibilitySnapshot> = {}): BaynPromotionEligibilitySnapshot => ({
  repository,
  pullRequest: pullRequest(),
  baseManifests: manifests(basePins),
  headManifests: manifests(headPins),
  reviews: [review()],
  threads: [],
  issueComments: [],
  reactions: [],
  sourceFreshness: { status: 'fresh' },
  provenance: provenance(),
  ...overrides,
})

const evaluate = (value: BaynPromotionEligibilitySnapshot) =>
  evaluateBaynPromotionEligibility({
    expectedRepository: repository,
    expectedPullNumber: pullNumber,
    expectedHeadSha: headSha,
    snapshot: value,
    nowMs: evaluationNowMs,
  })

const currentBaseRefreshSnapshot = (
  overrides: Partial<BaynPromotionCurrentBaseRefreshSnapshot> = {},
): BaynPromotionCurrentBaseRefreshSnapshot => ({
  promotion: snapshot(),
  repositoryDefaultBranch: 'main',
  currentDefaultBranchSha: currentMainSha,
  currentSourceFreshness: { status: 'fresh' },
  baseAdvance: {
    status: 'ahead',
    baseSha,
    headSha: currentMainSha,
    mergeBaseSha: baseSha,
    aheadBy: 1,
    totalCommits: 1,
    commitShas: [currentMainSha],
    changedPaths: ['packages/scripts/src/bayn/verify-promotion-eligibility.ts'],
  },
  currentManifests: manifests(basePins),
  releaseRun: {
    id: 30533142309,
    runAttempt: 2,
    headSha: sourceSha,
    headBranch: 'main',
    event: 'workflow_run',
    status: 'completed',
    conclusion: 'success',
  },
  ...overrides,
})

const evaluateCurrentBaseRefresh = (value: BaynPromotionCurrentBaseRefreshSnapshot) =>
  evaluateBaynPromotionCurrentBaseRefresh({
    expectedRepository: repository,
    expectedPullNumber: pullNumber,
    expectedHeadSha: headSha,
    expectedDefaultBranchSha: currentMainSha,
    snapshot: value,
    nowMs: evaluationNowMs,
  })

describe('Bayn promotion eligibility', () => {
  test('parses the checked-in native Bayn promotion manifests', () => {
    const parsed = parseBaynPromotionPins({
      deployment: readFileSync(
        new URL('../../../../argocd/applications/bayn/deployment.yaml', import.meta.url),
        'utf8',
      ),
      kustomization: readFileSync(
        new URL('../../../../argocd/applications/bayn/kustomization.yaml', import.meta.url),
        'utf8',
      ),
      applicationSet: readFileSync(new URL('../../../../argocd/applicationsets/product.yaml', import.meta.url), 'utf8'),
    })

    expect(parsed.sourceSha).toBe('cade68a194e7398200180bb9a45d8c4f3b6bbfc4')
  })

  test('rejects reintroduction of retired lifecycle runtime inputs', () => {
    const native = manifests(headPins)
    expect(() =>
      parseBaynPromotionPins({
        ...native,
        deployment: native.deployment.replace(
          '          env:\n',
          '          ports:\n            - name: lifecycle-cmd\n              containerPort: 8081\n              protocol: TCP\n          env:\n',
        ),
      }),
    ).toThrow('Bayn deployment must not expose the retired lifecycle command port')
    expect(() =>
      parseBaynPromotionPins({
        ...native,
        deployment: native.deployment.replace(
          `            - name: BAYN_CODE_REVISION\n              value: ${sourceSha}\n`,
          `            - name: BAYN_CODE_REVISION\n              value: ${sourceSha}\n            - name: BAYN_LIFECYCLE_OWNER\n              value: RESTATE\n`,
        ),
      }),
    ).toThrow('Bayn deployment must not retain retired lifecycle environment inputs')
  })

  test('accepts a valid current promotion with exact-head review and immutable release provenance', () => {
    expect(evaluate(snapshot())).toMatchObject({
      status: 'eligible',
      prNumber: pullNumber,
      headSha,
      sourceSha,
      tag: `sha-${sourceSha}`,
      digest,
      buildRunId: 30532902039,
      releaseRunId: 30533142309,
    })
  })

  test('leaves non-promotion Bayn pull requests unchanged', () => {
    expect(
      evaluate(
        snapshot({
          pullRequest: pullRequest({ headRefName: 'codex/bayn-runtime-fix' }),
          reviews: [],
          provenance: { status: 'missing', reason: 'not loaded' },
        }),
      ),
    ).toEqual({ status: 'not-applicable', prNumber: pullNumber, headSha })
  })

  test('makes non-applicable PRs fail only when the exact gate requires applicability', () => {
    const notApplicable = evaluate(
      snapshot({
        pullRequest: pullRequest({ headRefName: 'codex/bayn-runtime-fix' }),
        reviews: [],
        provenance: { status: 'missing', reason: 'not loaded' },
      }),
    )
    expect(isBaynPromotionCliFailure(notApplicable, false)).toBeFalse()
    expect(isBaynPromotionCliFailure(notApplicable, true)).toBeTrue()
    expect(isBaynPromotionCliFailure(evaluate(snapshot()), true)).toBeFalse()
    expect(isBaynPromotionCliFailure(evaluate(snapshot({ reviews: [] })), true)).toBeTrue()
  })

  test('parses the exact-gate applicability requirement strictly', () => {
    const arguments_ = [
      '--repository',
      repository,
      '--pull-number',
      String(pullNumber),
      '--head-sha',
      headSha,
      '--require-applicable',
      'true',
    ]
    expect(parseVerifyPromotionArguments(arguments_)).toMatchObject({ requireApplicable: true })
    expect(() => parseVerifyPromotionArguments([...arguments_.slice(0, -1), 'yes'])).toThrow(
      '--require-applicable must be true or false',
    )
  })

  test('fails closed when the exact-head Codex review is missing', () => {
    expect(evaluate(snapshot({ reviews: [] }))).toMatchObject({
      status: 'hold',
      code: 'exact-head-review-missing',
      retryable: true,
    })
  })

  test('fails closed when the Codex review belongs to a stale head', () => {
    expect(evaluate(snapshot({ reviews: [review({ commitSha: staleHeadSha })] }))).toMatchObject({
      status: 'hold',
      code: 'exact-head-review-stale',
      retryable: true,
    })
  })

  test('accepts an immutable clean connector comment bound to the exact head', () => {
    expect(
      evaluate(
        snapshot({
          reviews: [],
          issueComments: [
            {
              authorLogin: baynPromotionCodexBotLogin,
              body: `Codex Review: Didn't find any issues.\n\n**Reviewed commit:** \`${headSha}\`\n`,
              createdAt: '2026-07-30T10:01:00Z',
              updatedAt: '2026-07-30T10:01:00Z',
            },
          ],
        }),
      ),
    ).toMatchObject({ status: 'eligible', reviewSubmittedAt: '2026-07-30T10:01:00Z' })
  })

  test('rejects an edited or stale clean connector comment', () => {
    expect(
      evaluate(
        snapshot({
          reviews: [],
          issueComments: [
            {
              authorLogin: baynPromotionCodexBotLogin,
              body: `Codex Review: Didn't find any issues.\n\n**Reviewed commit:** \`${staleHeadSha}\`\n`,
              createdAt: '2026-07-30T10:01:00Z',
              updatedAt: '2026-07-30T10:01:01Z',
            },
          ],
        }),
      ),
    ).toMatchObject({ status: 'hold', code: 'exact-head-review-missing' })
  })

  test('accepts a clean connector reaction for a single immutable head without force-push history', () => {
    const reactions = [
      {
        userLogin: baynPromotionCodexBotLogin,
        content: '+1',
        createdAt: '2026-07-30T10:01:00Z',
      },
    ]
    expect(evaluate(snapshot({ reviews: [], reactions }))).toMatchObject({ status: 'eligible' })
  })

  test('accepts the #13410 one-force-push-then-clean-reaction sequence for the exact current head', () => {
    const realPullNumber = 13410
    const priorHeadSha = 'caee18e8b951700d75161f00a9d88a4696c2c323'
    const realHeadSha = '94ecab66c681e1044c7a7e9f62982892ddac81ae'
    const result = evaluateBaynPromotionEligibility({
      expectedRepository: repository,
      expectedPullNumber: realPullNumber,
      expectedHeadSha: realHeadSha,
      nowMs: Date.parse('2026-07-30T23:00:00Z'),
      snapshot: snapshot({
        pullRequest: pullRequest({
          number: realPullNumber,
          baseSha: '7cb3d25454e39f3dea04f4f60f1ec068c5a79807',
          headSha: realHeadSha,
          createdAt: '2026-07-30T22:57:10Z',
          headCommittedAt: '2026-07-30T22:57:06Z',
          headForcePushes: [
            {
              beforeSha: priorHeadSha,
              afterSha: realHeadSha,
              createdAt: '2026-07-30T22:57:11Z',
            },
          ],
        }),
        reviews: [],
        reactions: [
          {
            userLogin: baynPromotionCodexBotLogin,
            content: '+1',
            createdAt: '2026-07-30T22:58:50Z',
          },
        ],
        provenance: provenance({
          promotionPullNumber: realPullNumber,
          promotionHeadSha: realHeadSha,
        }),
      }),
    })

    expect(result).toMatchObject({
      status: 'eligible',
      prNumber: realPullNumber,
      headSha: realHeadSha,
      reviewSubmittedAt: '2026-07-30T22:58:50Z',
    })
  })

  test.each([
    ['before the latest-head force-push', '2026-07-30T22:57:10Z', baynPromotionCodexBotLogin],
    ['at the same second as the latest-head force-push', '2026-07-30T22:57:11Z', baynPromotionCodexBotLogin],
    ['from a spoofed actor', '2026-07-30T22:58:50Z', 'spoofed-codex[bot]'],
  ] as const)('rejects a connector reaction %s', (_name, reactionCreatedAt, userLogin) => {
    expect(
      evaluate(
        snapshot({
          reviews: [],
          pullRequest: pullRequest({
            createdAt: '2026-07-30T22:57:10Z',
            headCommittedAt: '2026-07-30T22:57:06Z',
            headForcePushes: [
              {
                beforeSha: staleHeadSha,
                afterSha: headSha,
                createdAt: '2026-07-30T22:57:11Z',
              },
            ],
          }),
          reactions: [{ userLogin, content: '+1', createdAt: reactionCreatedAt }],
        }),
      ),
    ).toMatchObject({ status: 'hold', code: 'exact-head-review-missing' })
  })

  test('rejects a reaction invalidated by a later force-push to the current head', () => {
    expect(
      evaluate(
        snapshot({
          reviews: [],
          pullRequest: pullRequest({
            createdAt: '2026-07-30T22:57:10Z',
            headCommittedAt: '2026-07-30T22:57:06Z',
            headForcePushes: [
              {
                beforeSha: oldSourceSha,
                afterSha: staleHeadSha,
                createdAt: '2026-07-30T22:57:11Z',
              },
              {
                beforeSha: staleHeadSha,
                afterSha: headSha,
                createdAt: '2026-07-30T22:59:00Z',
              },
            ],
          }),
          reactions: [
            {
              userLogin: baynPromotionCodexBotLogin,
              content: '+1',
              createdAt: '2026-07-30T22:58:50Z',
            },
          ],
        }),
      ),
    ).toMatchObject({ status: 'hold', code: 'exact-head-review-missing' })
  })

  test('rejects stale or ambiguous force-push history instead of guessing a reaction binding', () => {
    const reaction = {
      userLogin: baynPromotionCodexBotLogin,
      content: '+1',
      createdAt: '2026-07-30T22:58:50Z',
    }
    expect(
      evaluate(
        snapshot({
          reviews: [],
          reactions: [reaction],
          pullRequest: pullRequest({
            createdAt: '2026-07-30T22:57:10Z',
            headCommittedAt: '2026-07-30T22:57:06Z',
            headForcePushes: [
              {
                beforeSha: oldSourceSha,
                afterSha: staleHeadSha,
                createdAt: '2026-07-30T22:57:11Z',
              },
            ],
          }),
        }),
      ),
    ).toMatchObject({ status: 'hold', code: 'exact-head-review-missing' })

    expect(
      evaluate(
        snapshot({
          reviews: [],
          reactions: [reaction],
          pullRequest: pullRequest({
            createdAt: '2026-07-30T22:57:10Z',
            headCommittedAt: '2026-07-30T22:57:06Z',
            headForcePushes: [
              {
                beforeSha: oldSourceSha,
                afterSha: staleHeadSha,
                createdAt: '2026-07-30T22:57:11Z',
              },
              {
                beforeSha: sourceSha,
                afterSha: headSha,
                createdAt: '2026-07-30T22:57:12Z',
              },
            ],
          }),
        }),
      ),
    ).toMatchObject({ status: 'hold', code: 'exact-head-review-missing' })
  })

  test('rejects multiple clean fallback attestations as ambiguous', () => {
    const reaction = {
      userLogin: baynPromotionCodexBotLogin,
      content: '+1',
      createdAt: '2026-07-30T10:01:00Z',
    }
    expect(
      evaluate(
        snapshot({
          reviews: [],
          reactions: [reaction, { ...reaction, createdAt: '2026-07-30T10:01:01Z' }],
        }),
      ),
    ).toMatchObject({ status: 'hold', code: 'exact-head-review-missing' })

    expect(
      evaluate(
        snapshot({
          reviews: [],
          reactions: [reaction],
          issueComments: [
            {
              authorLogin: baynPromotionCodexBotLogin,
              body: `Codex Review: Didn't find any issues.\n\n**Reviewed commit:** \`${headSha}\`\n`,
              createdAt: '2026-07-30T10:01:02Z',
              updatedAt: '2026-07-30T10:01:02Z',
            },
          ],
        }),
      ),
    ).toMatchObject({ status: 'hold', code: 'exact-head-review-missing' })
  })

  test('keeps an actionable exact-head review dominant over a clean reaction', () => {
    expect(
      evaluate(
        snapshot({
          reviews: [review({ state: 'CHANGES_REQUESTED' })],
          reactions: [
            {
              userLogin: baynPromotionCodexBotLogin,
              content: '+1',
              createdAt: '2026-07-30T10:01:00Z',
            },
          ],
        }),
      ),
    ).toMatchObject({ status: 'hold', code: 'exact-head-review-changes-requested' })
  })

  test('fails closed on an actionable unresolved review thread', () => {
    expect(
      evaluate(
        snapshot({
          threads: [
            {
              id: 'thread-1',
              isResolved: false,
              isOutdated: false,
              path: 'argocd/applications/bayn/deployment.yaml',
              url: 'https://github.com/proompteng/lab/pull/13400#discussion_r1',
            },
          ],
        }),
      ),
    ).toMatchObject({
      status: 'hold',
      code: 'active-unresolved-review-threads',
    })
  })

  test('ignores an outdated unresolved thread because it is no longer actionable', () => {
    expect(
      evaluate(
        snapshot({
          threads: [
            {
              id: 'thread-1',
              isResolved: false,
              isOutdated: true,
              path: 'argocd/applications/bayn/deployment.yaml',
              url: 'https://github.com/proompteng/lab/pull/13400#discussion_r1',
            },
          ],
        }),
      ),
    ).toMatchObject({ status: 'eligible' })
  })

  test.each([
    ['source revision', { ...headPins, sourceSha: staleHeadSha }, 'promotion-pin-inconsistent'],
    ['image tag', { ...headPins, tag: `sha-${staleHeadSha}` }, 'promotion-pin-inconsistent'],
    ['image digest', { ...headPins, digest: `sha256:${'9'.repeat(64)}` }, 'release-contract-mismatch'],
  ] as const)('rejects an altered %s', (_name, alteredPins, expectedCode) => {
    const valid = manifests(headPins)
    const altered =
      _name === 'source revision'
        ? { ...valid, deployment: valid.deployment.replace(sourceSha, staleHeadSha) }
        : _name === 'image tag'
          ? { ...valid, kustomization: valid.kustomization.replace(headPins.tag, alteredPins.tag) }
          : manifests(alteredPins)
    expect(evaluate(snapshot({ headManifests: altered }))).toMatchObject({
      status: 'hold',
      code: expectedCode,
    })
  })

  test('rejects changes outside the generated promotion manifest shape', () => {
    const valid = manifests(headPins)
    expect(
      evaluate(
        snapshot({
          headManifests: {
            ...valid,
            deployment: `${valid.deployment}          securityContext:\n            privileged: true\n`,
          },
        }),
      ),
    ).toMatchObject({
      status: 'hold',
      code: 'promotion-manifest-shape-mismatch',
    })
  })

  test('allows a release-owned transition from a disabled base to an enabled promotion', () => {
    expect(
      evaluate(
        snapshot({
          baseManifests: manifests(basePins, false),
          headManifests: manifests(headPins, true),
        }),
      ),
    ).toMatchObject({ status: 'eligible' })
  })

  test('rejects a promotion whose head leaves Bayn disabled', () => {
    expect(
      evaluate(
        snapshot({
          headManifests: manifests(headPins, false),
        }),
      ),
    ).toMatchObject({
      status: 'hold',
      code: 'promotion-pin-inconsistent',
      message: 'head manifests are inconsistent: Bayn ApplicationSet entry must be enabled after promotion',
    })
  })

  test('rejects a non-permitted promotion path', () => {
    expect(
      evaluate(
        snapshot({
          pullRequest: pullRequest({
            files: [
              ...pullRequest().files,
              { path: 'services/bayn/src/runtime.ts', status: 'modified', previousPath: null },
            ],
          }),
        }),
      ),
    ).toMatchObject({
      status: 'hold',
      code: 'promotion-paths-not-permitted',
    })
  })

  test('rejects a reviewed image when the promotion base contains newer Bayn build inputs', () => {
    expect(
      evaluate(
        snapshot({
          sourceFreshness: {
            status: 'stale',
            reason: `promotion base ${baseSha.slice(0, 12)} contains newer Bayn build input(s) after source ${sourceSha.slice(0, 12)}: services/bayn/src/forward-performance.ts`,
          },
        }),
      ),
    ).toMatchObject({
      status: 'hold',
      code: 'promotion-source-stale',
      retryable: false,
    })
  })

  test('matches the release lane Bayn build-input freshness boundary', () => {
    expect(buildWorkflow.on.push.paths).toBeUndefined()
    for (const pattern of buildWorkflow.on.push.paths ?? []) {
      const path = representativeBuildTriggerPath(pattern)
      expect(isBaynPromotionSourceAffectingPath(path)).toBeTrue()
    }
    for (const path of [
      'packages/scripts/src/bayn/native-runtime-manifest.ts',
      'packages/scripts/src/bayn/update-manifests.ts',
      'nix/images/bayn.nix',
    ]) {
      expect(isBaynPromotionSourceAffectingPath(path)).toBeTrue()
    }
    for (const path of [
      'packages/scripts/src/bayn/verify-promotion-eligibility.ts',
      'argocd/applications/bayn/deployment.yaml',
      'README.md',
    ]) {
      expect(isBaynPromotionSourceAffectingPath(path)).toBeFalse()
    }
  })

  test('accepts only exact-source main pushes for later contract binding', () => {
    const run = {
      headSha: sourceSha,
      headBranch: 'main',
      status: 'completed',
      conclusion: 'success',
    } as const
    expect(isBaynPromotionBuildRunCandidate({ ...run, event: 'push' }, sourceSha)).toBeTrue()
    expect(isBaynPromotionBuildRunCandidate({ ...run, event: 'workflow_dispatch' }, sourceSha)).toBeFalse()
    expect(isBaynPromotionBuildRunCandidate({ ...run, event: 'issue_comment' }, sourceSha)).toBeFalse()
    expect(isBaynPromotionBuildRunCandidate({ ...run, event: 'push' }, staleHeadSha)).toBeFalse()
    expect(isBaynPromotionBuildRunCandidate({ ...run, event: 'workflow_dispatch' }, staleHeadSha)).toBeFalse()
    expect(
      isBaynPromotionBuildRunCandidate(
        { ...run, event: 'workflow_dispatch', headBranch: 'release-candidate' },
        sourceSha,
      ),
    ).toBeFalse()
  })

  test('lists exact-source push and release runs without assuming the source SHA', () => {
    const push = new URL(
      baynWorkflowRunsUrl({
        repository,
        workflow: 'bayn-build-push.yml',
        page: 1,
        headSha: sourceSha,
        event: 'push',
        status: 'success',
      }),
    )
    expect(push.searchParams.get('head_sha')).toBe(sourceSha)
    expect(push.searchParams.get('event')).toBe('push')

    const releaseRange = baynReleaseSearchRange('2026-07-29T10:00:00.000Z')
    expect(releaseRange).toEqual({
      createdAfter: '2026-07-29T09:55:00.000Z',
      createdBefore: '2026-07-30T10:00:00.000Z',
    })
    const release = new URL(
      baynWorkflowRunsUrl({
        repository,
        workflow: 'bayn-release.yml',
        page: 1,
        event: 'workflow_run',
        ...releaseRange,
      }),
    )
    expect(release.searchParams.has('head_sha')).toBeFalse()
    expect(release.searchParams.get('event')).toBe('workflow_run')
    expect(release.searchParams.get('created')).toBe('2026-07-29T09:55:00.000Z..2026-07-30T10:00:00.000Z')
  })

  test('keeps a delayed release rerun discoverable through its original causal build window', () => {
    const range = baynReleaseSearchRange('2026-07-01T10:00:00.000Z')
    const originalReleaseCreatedAt = Date.parse('2026-07-01T10:01:00.000Z')
    const delayedRerunUpdatedAt = Date.parse('2026-07-30T10:00:00.000Z')

    expect(Date.parse(range.createdAfter)).toBeLessThanOrEqual(originalReleaseCreatedAt)
    expect(originalReleaseCreatedAt).toBeLessThanOrEqual(Date.parse(range.createdBefore))
    expect(delayedRerunUpdatedAt).toBeGreaterThan(Date.parse(range.createdBefore))
  })

  test.each([
    ['missing', { status: 'missing', reason: 'no matching reviewed build' }],
    ['stale', { status: 'stale', reason: 'release contract artifact expired' }],
    ['ambiguous', { status: 'ambiguous', reason: 'two matching release contracts' }],
  ] as const)('fails closed on %s release provenance', (_name, value) => {
    expect(evaluate(snapshot({ provenance: value }))).toMatchObject({
      status: 'hold',
      code: `release-provenance-${value.status}`,
    })
  })

  test('rejects release contract source, tag, or digest drift', () => {
    expect(
      evaluate(
        snapshot({
          provenance: provenance({ contract: { ...contract(), digest: `sha256:${'8'.repeat(64)}` } }),
        }),
      ),
    ).toMatchObject({
      status: 'hold',
      code: 'release-contract-mismatch',
    })
  })

  test('rejects provenance from a release run that generated a different exact head', () => {
    expect(
      evaluate(
        snapshot({
          provenance: provenance({ promotionHeadSha: staleHeadSha }),
        }),
      ),
    ).toMatchObject({
      status: 'hold',
      code: 'release-provenance-stale',
      retryable: false,
    })
  })

  test('rejects the historical rebased #13396 promotion despite its current exact-head review', () => {
    const historicalPullNumber = 13396
    const generatedHead = '24e4f5f4bf540ef56954916dadf948df29d7a643'
    const rebasedHead = '469af423936357968b8d83340697675db61a72fd'
    const historicalSource = '06c0aa285354e6c628f7a1e0936365b1057920e0'
    const historicalDigest = `sha256:${'a'.repeat(64)}`
    const result = evaluateBaynPromotionEligibility({
      expectedRepository: repository,
      expectedPullNumber: historicalPullNumber,
      expectedHeadSha: rebasedHead,
      nowMs: evaluationNowMs,
      snapshot: {
        repository,
        pullRequest: pullRequest({
          number: historicalPullNumber,
          title: `chore(bayn): promote image sha-${historicalSource}`,
          headSha: rebasedHead,
        }),
        baseManifests: manifests(basePins),
        headManifests: manifests({
          sourceSha: historicalSource,
          tag: `sha-${historicalSource}`,
          digest: historicalDigest,
          rolloutTimestamp: '2026-07-30T10:03:59Z',
        }),
        reviews: [review({ commitSha: rebasedHead })],
        threads: [],
        issueComments: [],
        reactions: [],
        sourceFreshness: { status: 'fresh' },
        provenance: {
          status: 'resolved',
          buildRunId: 30532902039,
          releaseRunId: 30533142309,
          promotionPullNumber: historicalPullNumber,
          promotionHeadSha: generatedHead,
          contract: {
            ...contract(),
            sourceSha: historicalSource,
            tag: `sha-${historicalSource}`,
            digest: historicalDigest,
            reference: `registry.ide-newton.ts.net/lab/bayn@${historicalDigest}`,
          },
        },
      },
    })

    expect(result).toMatchObject({
      status: 'hold',
      code: 'release-provenance-stale',
      retryable: false,
    })
  })
})

describe('Bayn promotion current-base refresh', () => {
  test('refreshes the #13411 causal release when main 20180624 is only a non-source verifier advance', () => {
    const realPullNumber = 13411
    const realSourceSha = '7cb3d25454e39f3dea04f4f60f1ec068c5a79807'
    const realHeadSha = 'f48a42ec4c5b9a791167ded543690d47f16ae5d9'
    const realMainSha = '20180624f495df3a025cacef846a250952fb45ef'
    const realDigest = 'sha256:1620f4667bddf517704e5fa83f22bd2315f39e215a592aec0dd20d142672ad48'
    const realHeadPins: ManifestPins = {
      sourceSha: realSourceSha,
      tag: `sha-${realSourceSha}`,
      digest: realDigest,
      rolloutTimestamp: '2026-07-30T23:07:30Z',
    }
    const realPromotion = snapshot({
      pullRequest: pullRequest({
        number: realPullNumber,
        title: `chore(bayn): promote image sha-${realSourceSha}`,
        baseSha: realSourceSha,
        headSha: realHeadSha,
        createdAt: '2026-07-30T23:07:30Z',
        headCommittedAt: '2026-07-30T23:07:27Z',
        headForcePushes: [],
      }),
      baseManifests: manifests(basePins),
      headManifests: manifests(realHeadPins),
      reviews: [],
      reactions: [
        {
          userLogin: baynPromotionCodexBotLogin,
          content: '+1',
          createdAt: '2026-07-30T23:09:20Z',
        },
      ],
      provenance: {
        status: 'resolved',
        buildRunId: 30588630482,
        releaseRunId: 30588836007,
        promotionPullNumber: realPullNumber,
        promotionHeadSha: realHeadSha,
        contract: {
          ...contract(),
          sourceSha: realSourceSha,
          tag: `sha-${realSourceSha}`,
          digest: realDigest,
          reference: `registry.ide-newton.ts.net/lab/bayn@${realDigest}`,
        },
      },
    })

    expect(
      evaluateBaynPromotionCurrentBaseRefresh({
        expectedRepository: repository,
        expectedPullNumber: realPullNumber,
        expectedHeadSha: realHeadSha,
        expectedDefaultBranchSha: realMainSha,
        nowMs: Date.parse('2026-07-31T00:00:00Z'),
        snapshot: {
          promotion: realPromotion,
          repositoryDefaultBranch: 'main',
          currentDefaultBranchSha: realMainSha,
          currentSourceFreshness: { status: 'fresh' },
          baseAdvance: {
            status: 'ahead',
            baseSha: realSourceSha,
            headSha: realMainSha,
            mergeBaseSha: realSourceSha,
            aheadBy: 1,
            totalCommits: 1,
            commitShas: [realMainSha],
            changedPaths: [
              'packages/scripts/src/bayn/verify-promotion-eligibility.ts',
              'packages/scripts/src/bayn/verify-promotion-eligibility.test.ts',
            ],
          },
          currentManifests: manifests(basePins),
          releaseRun: {
            id: 30588836007,
            runAttempt: 2,
            headSha: realSourceSha,
            headBranch: 'main',
            event: 'workflow_run',
            status: 'completed',
            conclusion: 'success',
          },
        },
      }),
    ).toEqual({
      status: 'refresh',
      prNumber: realPullNumber,
      headSha: realHeadSha,
      sourceSha: realSourceSha,
      digest: realDigest,
      buildRunId: 30588630482,
      releaseRunId: 30588836007,
      releaseRunAttempt: 2,
      currentBaseSha: realSourceSha,
      targetBaseSha: realMainSha,
    })
  })

  test('rejects a source-affecting main advance', () => {
    expect(
      evaluateCurrentBaseRefresh(
        currentBaseRefreshSnapshot({
          baseAdvance: {
            ...currentBaseRefreshSnapshot().baseAdvance!,
            changedPaths: ['services/bayn/src/runtime.ts'],
          },
        }),
      ),
    ).toMatchObject({ status: 'hold', code: 'newer-bayn-source-exists' })
  })

  test('rejects a newer source or a current-manifest downgrade', () => {
    expect(
      evaluateCurrentBaseRefresh(
        currentBaseRefreshSnapshot({
          currentSourceFreshness: {
            status: 'stale',
            reason: `promotion base ${currentMainSha.slice(0, 12)} contains newer Bayn build input(s)`,
          },
        }),
      ),
    ).toMatchObject({ status: 'hold', code: 'newer-bayn-source-exists' })

    expect(
      evaluateCurrentBaseRefresh(currentBaseRefreshSnapshot({ currentManifests: manifests(headPins) })),
    ).toMatchObject({ status: 'hold', code: 'promotion-would-downgrade-current-manifests' })
  })

  test('rejects a newer or mismatched causal release identity', () => {
    expect(
      evaluateCurrentBaseRefresh(
        currentBaseRefreshSnapshot({
          releaseRun: {
            ...currentBaseRefreshSnapshot().releaseRun!,
            headSha: staleHeadSha,
          },
        }),
      ),
    ).toMatchObject({ status: 'hold', code: 'release-run-identity-mismatch' })
  })

  test('suppresses a duplicate while the causal release refresh is queued or running', () => {
    for (const status of ['queued', 'in_progress']) {
      expect(
        evaluateCurrentBaseRefresh(
          currentBaseRefreshSnapshot({
            releaseRun: { ...currentBaseRefreshSnapshot().releaseRun!, status, conclusion: null },
          }),
        ),
      ).toMatchObject({ status: 'noop', code: 'refresh-in-flight' })
    }
  })

  test('rejects a stale promotion head and missing or ambiguous provenance', () => {
    expect(
      evaluateCurrentBaseRefresh(
        currentBaseRefreshSnapshot({
          promotion: snapshot({ pullRequest: pullRequest({ headSha: staleHeadSha }) }),
        }),
      ),
    ).toMatchObject({ status: 'hold', code: 'promotion-pr-metadata-mismatch' })

    for (const provenance of [
      { status: 'missing' as const, reason: 'release evidence has not settled' },
      { status: 'ambiguous' as const, reason: 'two release contracts match' },
    ]) {
      expect(
        evaluateCurrentBaseRefresh(currentBaseRefreshSnapshot({ promotion: snapshot({ provenance }) })),
      ).toMatchObject({
        status: 'hold',
        code: provenance.status === 'missing' ? 'release-provenance-missing' : 'release-provenance-ambiguous',
      })
    }
  })

  test('does nothing when the promotion already targets current main', () => {
    expect(
      evaluateBaynPromotionCurrentBaseRefresh({
        expectedRepository: repository,
        expectedPullNumber: pullNumber,
        expectedHeadSha: headSha,
        expectedDefaultBranchSha: baseSha,
        nowMs: evaluationNowMs,
        snapshot: currentBaseRefreshSnapshot({
          currentDefaultBranchSha: baseSha,
          baseAdvance: null,
        }),
      }),
    ).toMatchObject({ status: 'noop', code: 'already-current' })
  })
})

describe('bounded GitHub failure handling', () => {
  test('reloads the PR base and source freshness on every polling attempt', async () => {
    let pullReadCount = 0
    let commitReadCount = 0
    const comparedBases: string[] = []
    const headManifestReads: string[] = []
    const manifestByPath = new Map([
      ['argocd/applications/bayn/deployment.yaml', manifests(headPins).deployment],
      ['argocd/applications/bayn/kustomization.yaml', manifests(headPins).kustomization],
      ['argocd/applicationsets/product.yaml', manifests(headPins).applicationSet],
    ])
    const baseManifestByPath = new Map([
      ['argocd/applications/bayn/deployment.yaml', manifests(basePins).deployment],
      ['argocd/applications/bayn/kustomization.yaml', manifests(basePins).kustomization],
      ['argocd/applicationsets/product.yaml', manifests(basePins).applicationSet],
    ])
    const emptyConnection = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
    const forcePushConnection = {
      nodes: [
        {
          __typename: 'HeadRefForcePushedEvent',
          createdAt: '2026-07-30T10:00:01Z',
          beforeCommit: { oid: staleHeadSha },
          afterCommit: { oid: headSha },
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: 'force-push-cursor' },
    }

    const fetchFn = (async (input, init) => {
      const url = String(input)
      if (url === 'https://api.github.com/graphql') {
        const body = JSON.parse(String(init?.body)) as { readonly query: string }
        if (body.query.includes('BaynPromotionHeadForcePushes')) {
          return Response.json({
            data: { repository: { pullRequest: { timelineItems: forcePushConnection } } },
          })
        }
        if (body.query.includes('BaynPromotionReviews')) {
          return Response.json({ data: { repository: { pullRequest: { reviews: emptyConnection } } } })
        }
        if (body.query.includes('BaynPromotionThreads')) {
          return Response.json({
            data: { repository: { pullRequest: { reviewThreads: emptyConnection } } },
          })
        }
        throw new Error('unexpected GraphQL query')
      }
      if (url.endsWith(`/pulls/${pullNumber}`)) {
        const currentBaseSha = pullReadCount++ === 0 ? baseSha : nextBaseSha
        return Response.json({
          number: pullNumber,
          title: `chore(bayn): promote image sha-${sourceSha}`,
          state: 'open',
          created_at: '2026-07-30T10:00:00Z',
          commits: 1,
          base: { ref: 'main', sha: currentBaseSha },
          head: {
            ref: 'codex/bayn-release-current',
            sha: headSha,
            repo: { full_name: repository },
          },
        })
      }
      if (url.includes(`/pulls/${pullNumber}/files?`)) {
        return Response.json(baynPromotionManifestPaths.map((path) => ({ filename: path, status: 'modified' })))
      }
      if (url.endsWith(`/commits/${headSha}`)) {
        commitReadCount += 1
        return Response.json({ commit: { committer: { date: '2026-07-30T10:00:00Z' } } })
      }
      if (url.includes('/contents/')) {
        const parsed = new URL(url)
        const path = decodeURIComponent(parsed.pathname.split('/contents/')[1] ?? '')
        const ref = parsed.searchParams.get('ref')
        const content = ref === headSha ? manifestByPath.get(path) : baseManifestByPath.get(path)
        if (content === undefined) throw new Error(`unexpected manifest ${path}`)
        if (ref === headSha) headManifestReads.push(path)
        return Response.json({
          type: 'file',
          encoding: 'base64',
          content: Buffer.from(content).toString('base64'),
        })
      }
      if (url.includes(`/compare/${sourceSha}...`)) {
        const parsed = new URL(url)
        const comparedBase = decodeURIComponent(parsed.pathname.split('...')[1] ?? '')
        comparedBases.push(comparedBase)
        return Response.json({
          status: 'diverged',
          base_commit: { sha: sourceSha },
          merge_base_commit: { sha: oldSourceSha },
          ahead_by: 0,
          total_commits: 0,
          commits: [],
          files: [],
        })
      }
      if (url.includes(`/issues/${pullNumber}/comments?`) || url.includes(`/issues/${pullNumber}/reactions?`)) {
        return Response.json([])
      }
      throw new Error(`unexpected URL ${url}`)
    }) as typeof fetch

    const loader = createGitHubPromotionEligibilityLoader({
      repository,
      token: 'test-token',
      pullNumber,
      headSha,
      requestTimeoutMs: 100,
      fetchFn,
    })
    const first = await loader()
    const second = await loader()

    expect(first.pullRequest.baseSha).toBe(baseSha)
    expect(second.pullRequest.baseSha).toBe(nextBaseSha)
    expect(comparedBases).toEqual([baseSha, nextBaseSha])
    expect(headManifestReads).toEqual([...baynPromotionManifestPaths])
    expect(commitReadCount).toBe(1)
    expect(first.pullRequest.headForcePushes).toEqual([
      {
        beforeSha: staleHeadSha,
        afterSha: headSha,
        createdAt: '2026-07-30T10:00:01Z',
      },
    ])
    expect(second.pullRequest.headForcePushes).toEqual(first.pullRequest.headForcePushes)
  })

  test.each([
    ['not indexed', []],
    [
      'still running',
      [{ runId: 10, status: 'in_progress', conclusion: null, promotionStatus: 'settling', evidence: null }],
    ],
    [
      'completed before job and log indexing settles',
      [{ runId: 10, status: 'completed', conclusion: 'success', promotionStatus: 'settling', evidence: null }],
    ],
  ] as const)('keeps creating release provenance retryable while the run is %s', (_name, runs) => {
    expect(resolveBaynPromotionReleaseRun({ repository, sourceSha, pullNumber, headSha, runs })).toMatchObject({
      status: 'missing',
    })
  })

  test('resolves the exact promotion only after immutable successful release evidence appears', () => {
    expect(
      resolveBaynPromotionReleaseRun({
        repository,
        sourceSha,
        pullNumber,
        headSha,
        runs: [
          {
            runId: 10,
            status: 'completed',
            conclusion: 'success',
            promotionStatus: 'created',
            evidence: promotionEvidence(),
          },
        ],
      }),
    ).toEqual({ status: 'resolved', runId: 10, evidence: promotionEvidence() })
  })

  test('resolves one exact release despite another unbound run still settling', () => {
    expect(
      resolveBaynPromotionReleaseRun({
        repository,
        sourceSha,
        pullNumber,
        headSha,
        runs: [
          {
            runId: 10,
            status: 'completed',
            conclusion: 'success',
            promotionStatus: 'created',
            evidence: promotionEvidence(),
          },
          {
            runId: 11,
            status: 'in_progress',
            conclusion: null,
            promotionStatus: 'settling',
            evidence: null,
          },
        ],
      }),
    ).toEqual({ status: 'resolved', runId: 10, evidence: promotionEvidence() })
  })

  test('rejects the exact promotion head when release logs bind a different triggering source', () => {
    expect(
      resolveBaynPromotionReleaseRun({
        repository,
        sourceSha,
        pullNumber,
        headSha,
        runs: [
          {
            runId: 10,
            status: 'completed',
            conclusion: 'success',
            promotionStatus: 'created',
            evidence: promotionEvidence({ sourceSha: oldSourceSha }),
          },
        ],
      }),
    ).toMatchObject({ status: 'stale' })
  })

  test('classifies settled conflicting release evidence as stale and duplicate exact evidence as ambiguous', () => {
    expect(
      resolveBaynPromotionReleaseRun({
        repository,
        sourceSha,
        pullNumber,
        headSha,
        runs: [
          {
            runId: 10,
            status: 'completed',
            conclusion: 'success',
            promotionStatus: 'created',
            evidence: promotionEvidence({ headSha: staleHeadSha }),
          },
        ],
      }),
    ).toMatchObject({ status: 'stale' })
    expect(
      resolveBaynPromotionReleaseRun({
        repository,
        sourceSha,
        pullNumber,
        headSha,
        runs: [
          {
            runId: 10,
            status: 'completed',
            conclusion: 'success',
            promotionStatus: 'created',
            evidence: promotionEvidence(),
          },
          {
            runId: 11,
            status: 'completed',
            conclusion: 'success',
            promotionStatus: 'created',
            evidence: promotionEvidence(),
          },
        ],
      }),
    ).toMatchObject({ status: 'ambiguous' })
  })

  test('ignores an earlier completed held release when a later run creates the exact promotion', () => {
    expect(
      resolveBaynPromotionReleaseRun({
        repository,
        sourceSha,
        pullNumber,
        headSha,
        runs: [
          {
            runId: 9,
            status: 'completed',
            conclusion: 'success',
            promotionStatus: 'held',
            evidence: null,
          },
          {
            runId: 10,
            status: 'completed',
            conclusion: 'success',
            promotionStatus: 'created',
            evidence: promotionEvidence(),
          },
        ],
      }),
    ).toEqual({ status: 'resolved', runId: 10, evidence: promotionEvidence() })
  })

  test('ignores a superseded created head when one unique run binds the current promotion head', () => {
    expect(
      resolveBaynPromotionReleaseRun({
        repository,
        sourceSha,
        pullNumber,
        headSha,
        runs: [
          {
            runId: 9,
            status: 'completed',
            conclusion: 'success',
            promotionStatus: 'created',
            evidence: promotionEvidence({ headSha: staleHeadSha }),
          },
          {
            runId: 10,
            status: 'completed',
            conclusion: 'success',
            promotionStatus: 'created',
            evidence: promotionEvidence(),
          },
        ],
      }),
    ).toEqual({ status: 'resolved', runId: 10, evidence: promotionEvidence() })
  })

  test('reloads retryable missing provenance and caches the first settled result', async () => {
    let calls = 0
    const load = createRefreshableBaynPromotionProvenanceLoader(async () => {
      calls += 1
      return calls === 1
        ? { status: 'missing', reason: 'release run is still indexing' }
        : provenance({ buildRunId: 200, releaseRunId: 201 })
    })

    expect(await load()).toEqual({ status: 'missing', reason: 'release run is still indexing' })
    expect(await load()).toMatchObject({ status: 'resolved', buildRunId: 200, releaseRunId: 201 })
    expect(await load()).toMatchObject({ status: 'resolved', buildRunId: 200, releaseRunId: 201 })
    expect(calls).toBe(2)
  })

  test('does not cache a failed provenance request', async () => {
    let calls = 0
    const load = createRefreshableBaynPromotionProvenanceLoader(async () => {
      calls += 1
      if (calls === 1) throw new GitHubPromotionEligibilityError('github-api-timeout', 'load provenance')
      return provenance()
    })

    await expect(load()).rejects.toMatchObject({ code: 'github-api-timeout' })
    await expect(load()).resolves.toMatchObject({ status: 'resolved' })
    expect(calls).toBe(2)
  })

  test.each([
    ['github-api-timeout', 'read promotion PR'],
    ['github-api-error', 'read promotion PR'],
    ['github-api-pagination-limit', 'read promotion PR files'],
  ] as const)('maps %s to a fail-closed retryable result', async (code, operation) => {
    const result = await pollBaynPromotionEligibility({
      expectedRepository: repository,
      expectedPullNumber: pullNumber,
      expectedHeadSha: headSha,
      maxAttempts: 1,
      pollIntervalMs: 1,
      loadSnapshot: () => Promise.reject(new GitHubPromotionEligibilityError(code, operation)),
    })
    expect(result).toMatchObject({
      status: 'hold',
      code,
      retryable: true,
      attempts: 1,
      timedOut: true,
    })
  })

  test('bounds REST pagination instead of accepting an incomplete file list', async () => {
    const fetchFn = (async (input) => {
      const url = String(input)
      if (url.endsWith(`/pulls/${pullNumber}`)) {
        return Response.json({
          number: pullNumber,
          title: 'ordinary PR',
          state: 'open',
          created_at: '2026-07-30T10:00:00Z',
          commits: 1,
          base: { ref: 'main', sha: baseSha },
          head: {
            ref: 'codex/ordinary-pr',
            sha: headSha,
            repo: { full_name: repository },
          },
        })
      }
      if (url.includes(`/pulls/${pullNumber}/files?`)) {
        return Response.json([], {
          headers: { link: '<https://api.github.com/next>; rel="next"' },
        })
      }
      throw new Error(`unexpected URL ${url}`)
    }) as typeof fetch
    const loader = createGitHubPromotionEligibilityLoader({
      repository,
      token: 'test-token',
      pullNumber,
      headSha,
      requestTimeoutMs: 100,
      fetchFn,
    })
    await expect(loader()).rejects.toMatchObject({ code: 'github-api-pagination-limit' })
  })

  test('classifies a request timeout from the bounded loader', async () => {
    const fetchFn = (async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })) as typeof fetch
    const loader = createGitHubPromotionEligibilityLoader({
      repository,
      token: 'test-token',
      pullNumber,
      headSha,
      requestTimeoutMs: 1,
      fetchFn,
    })
    await expect(loader()).rejects.toMatchObject({ code: 'github-api-timeout' })
  })

  test('classifies a GitHub API failure from the bounded loader', async () => {
    const loader = createGitHubPromotionEligibilityLoader({
      repository,
      token: 'test-token',
      pullNumber,
      headSha,
      requestTimeoutMs: 100,
      fetchFn: (async () => new Response('unavailable', { status: 503 })) as unknown as typeof fetch,
    })
    await expect(loader()).rejects.toMatchObject({ code: 'github-api-error', status: 503 })
  })
})

const littleEndian16 = (value: number): Buffer => {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16LE(value)
  return buffer
}

const littleEndian32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value)
  return buffer
}

const storedZipEntries = (entries: readonly { readonly name: string; readonly content: string }[]): Uint8Array => {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name)
    const contentBytes = Buffer.from(entry.content)
    const local = Buffer.concat([
      littleEndian32(0x04034b50),
      littleEndian16(20),
      littleEndian16(0),
      littleEndian16(0),
      Buffer.alloc(4),
      littleEndian32(0),
      littleEndian32(contentBytes.length),
      littleEndian32(contentBytes.length),
      littleEndian16(nameBytes.length),
      littleEndian16(0),
      nameBytes,
      contentBytes,
    ])
    localParts.push(local)
    centralParts.push(
      Buffer.concat([
        littleEndian32(0x02014b50),
        littleEndian16(20),
        littleEndian16(20),
        littleEndian16(0),
        littleEndian16(0),
        Buffer.alloc(4),
        littleEndian32(0),
        littleEndian32(contentBytes.length),
        littleEndian32(contentBytes.length),
        littleEndian16(nameBytes.length),
        littleEndian16(0),
        littleEndian16(0),
        littleEndian16(0),
        littleEndian16(0),
        littleEndian32(0),
        littleEndian32(localOffset),
        nameBytes,
      ]),
    )
    localOffset += local.length
  }
  const local = Buffer.concat(localParts)
  const central = Buffer.concat(centralParts)
  const end = Buffer.concat([
    littleEndian32(0x06054b50),
    littleEndian16(0),
    littleEndian16(0),
    littleEndian16(entries.length),
    littleEndian16(entries.length),
    littleEndian32(central.length),
    littleEndian32(local.length),
    littleEndian16(0),
  ])
  return new Uint8Array(Buffer.concat([local, central, end]))
}

const storedZip = (name: string, content: string): Uint8Array => storedZipEntries([{ name, content }])

describe('release contract artifact parsing', () => {
  test('extracts the bounded immutable release contract from its ZIP artifact', () => {
    const content = JSON.stringify(contract())
    expect(extractReleaseContractFromZip(storedZip('release-contract.json', content))).toBe(content)
  })

  test('rejects an artifact without the named release contract', () => {
    expect(() => extractReleaseContractFromZip(storedZip('other.json', '{}'))).toThrow(
      'release-contract.json is missing',
    )
  })
})

describe('release promotion log parsing', () => {
  const validateContractLog = (exactSourceSha = sourceSha): string =>
    `2026-07-30T10:03:25.0461388Z   WORKFLOW_SHA: ${exactSourceSha}\n`

  const releaseLog = (overrides: { readonly headSha?: string; readonly pullNumber?: number } = {}): string => {
    const exactHead = overrides.headSha ?? headSha
    const exactPullNumber = overrides.pullNumber ?? pullNumber
    return `2026-07-30T10:03:59.9370830Z   branch: codex/bayn-release-current
2026-07-30T10:03:59.9371866Z   base: main
2026-07-30T10:04:06.0334593Z pull-request-branch = codex/bayn-release-current
2026-07-30T10:04:06.0337038Z pull-request-operation = created
2026-07-30T10:04:06.0338486Z pull-request-head-sha = ${exactHead}
2026-07-30T10:04:06.0340055Z pull-request-number = ${exactPullNumber}
2026-07-30T10:04:06.0341475Z pull-request-url = https://github.com/proompteng/lab/pull/${exactPullNumber}
`
  }

  test('binds the successful release run to the exact generated promotion PR head', () => {
    expect(
      extractReleasePromotionEvidenceFromZip(
        storedZipEntries([
          { name: 'promote/4_Validate release contract.txt', content: validateContractLog() },
          { name: 'promote/8_Create deploy pull request.txt', content: releaseLog() },
        ]),
      ),
    ).toEqual({
      sourceSha,
      pullNumber,
      headSha,
      branch: 'codex/bayn-release-current',
      baseRefName: 'main',
      repository,
      operation: 'created',
    })
  })

  test('binds rerun evidence from one attempt-specific combined promote log', () => {
    expect(
      extractReleasePromotionEvidenceFromZip(
        storedZipEntries([
          { name: '0_promote.txt', content: `${validateContractLog()}${releaseLog()}` },
          { name: 'promote/system.txt', content: 'runner metadata only\n' },
        ]),
      ),
    ).toMatchObject({ sourceSha, pullNumber, headSha, operation: 'created' })
  })

  test('rejects inconsistent release-run pull-request URL evidence', () => {
    const inconsistent = releaseLog().replace(`/pull/${pullNumber}`, `/pull/${pullNumber + 1}`)
    expect(() =>
      extractReleasePromotionEvidenceFromZip(
        storedZipEntries([
          { name: 'promote/4_Validate release contract.txt', content: validateContractLog() },
          { name: 'promote/8_Create deploy pull request.txt', content: inconsistent },
        ]),
      ),
    ).toThrow('pull-request-url output is inconsistent')
  })

  test('rejects missing or duplicated exact-head output evidence', () => {
    const duplicated = `${releaseLog()}2026-07-30T10:04:06.0345000Z pull-request-head-sha = ${headSha}\n`
    expect(() =>
      extractReleasePromotionEvidenceFromZip(
        storedZipEntries([
          { name: 'promote/4_Validate release contract.txt', content: validateContractLog() },
          { name: 'promote/8_Create deploy pull request.txt', content: duplicated },
        ]),
      ),
    ).toThrow('exactly one pull-request-head-sha output')
  })

  test('binds the triggering workflow SHA independently of the release run head', () => {
    expect(
      extractReleasePromotionEvidenceFromZip(
        storedZipEntries([
          { name: 'promote/4_Validate release contract.txt', content: validateContractLog(oldSourceSha) },
          { name: 'promote/8_Create deploy pull request.txt', content: releaseLog() },
        ]),
      ),
    ).toMatchObject({ sourceSha: oldSourceSha, headSha })
  })

  test('rejects release logs without one trusted triggering workflow SHA', () => {
    expect(() =>
      extractReleasePromotionEvidenceFromZip(
        storedZipEntries([{ name: 'promote/8_Create deploy pull request.txt', content: releaseLog() }]),
      ),
    ).toThrow('exactly one Validate release contract step')
  })
})

describe('real release provenance discovery regression', () => {
  test('discovers build 30551086384 through release 30551402124 for promotion #13406', async () => {
    const realSourceSha = '0d12c15e04f165533d43b879c87ca931d3fce3b9'
    const realPromotionHeadSha = '04026f41afb6965b243473573681a4bb2f11b735'
    const realDigest = 'sha256:162b72a8b614de232b1aebb7e23b62070ccfa31f7f90cfb240e6e46159d9c471'
    const realPullNumber = 13406
    const realBuildRunId = 30551086384
    const realReleaseRunId = 30551402124
    const realContract = {
      service: 'bayn',
      image: 'registry.ide-newton.ts.net/lab/bayn',
      tag: `sha-${realSourceSha}`,
      digest: realDigest,
      reference: `registry.ide-newton.ts.net/lab/bayn@${realDigest}`,
      sourceSha: realSourceSha,
      packageAttr: 'bayn-image',
      platforms: ['linux/amd64', 'linux/arm64'],
    }
    const realHeadPins: ManifestPins = {
      sourceSha: realSourceSha,
      tag: realContract.tag,
      digest: realDigest,
      rolloutTimestamp: '2026-07-30T14:24:02Z',
    }
    const emptyConnection = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
    const workflowQueries: URL[] = []

    const fetchFn = (async (input, init) => {
      const url = String(input)
      if (url === 'https://api.github.com/graphql') {
        const body = JSON.parse(String(init?.body)) as { readonly query: string }
        if (body.query.includes('BaynPromotionHeadForcePushes')) {
          return Response.json({
            data: { repository: { pullRequest: { timelineItems: emptyConnection } } },
          })
        }
        if (body.query.includes('BaynPromotionReviews')) {
          return Response.json({ data: { repository: { pullRequest: { reviews: emptyConnection } } } })
        }
        if (body.query.includes('BaynPromotionThreads')) {
          return Response.json({
            data: { repository: { pullRequest: { reviewThreads: emptyConnection } } },
          })
        }
        throw new Error('unexpected GraphQL query')
      }
      if (url.endsWith(`/pulls/${realPullNumber}`)) {
        return Response.json({
          number: realPullNumber,
          title: `chore(bayn): promote image sha-${realSourceSha}`,
          state: 'open',
          created_at: '2026-07-30T14:24:02Z',
          commits: 1,
          base: { ref: 'main', sha: realSourceSha },
          head: {
            ref: 'codex/bayn-release-current',
            sha: realPromotionHeadSha,
            repo: { full_name: repository },
          },
        })
      }
      if (url.includes(`/pulls/${realPullNumber}/files?`)) {
        return Response.json(baynPromotionManifestPaths.map((path) => ({ filename: path, status: 'modified' })))
      }
      if (url.endsWith(`/commits/${realPromotionHeadSha}`)) {
        return Response.json({ commit: { committer: { date: '2026-07-30T14:24:02Z' } } })
      }
      if (url.includes('/contents/')) {
        const parsed = new URL(url)
        const path = decodeURIComponent(parsed.pathname.split('/contents/')[1] ?? '')
        const ref = parsed.searchParams.get('ref')
        const pins = ref === realPromotionHeadSha ? realHeadPins : basePins
        const pinManifests = manifests(pins)
        const content = new Map([
          ['argocd/applications/bayn/deployment.yaml', pinManifests.deployment],
          ['argocd/applications/bayn/kustomization.yaml', pinManifests.kustomization],
          ['argocd/applicationsets/product.yaml', pinManifests.applicationSet],
        ]).get(path)
        if (content === undefined) throw new Error(`unexpected manifest ${path}`)
        return Response.json({
          type: 'file',
          encoding: 'base64',
          content: Buffer.from(content).toString('base64'),
        })
      }
      if (url.includes(`/issues/${realPullNumber}/comments?`) || url.includes(`/issues/${realPullNumber}/reactions?`)) {
        return Response.json([])
      }
      if (url.includes('/actions/workflows/')) {
        const parsed = new URL(url)
        workflowQueries.push(parsed)
        if (parsed.pathname.endsWith('/bayn-build-push.yml/runs')) {
          return Response.json({
            workflow_runs: [
              {
                id: realBuildRunId,
                run_number: 503,
                run_attempt: 1,
                head_sha: realSourceSha,
                head_branch: 'main',
                event: 'push',
                status: 'completed',
                conclusion: 'success',
                created_at: '2026-07-30T14:18:55Z',
                updated_at: '2026-07-30T14:22:43Z',
              },
            ],
          })
        }
        if (parsed.pathname.endsWith('/bayn-release.yml/runs')) {
          return Response.json({
            workflow_runs: [
              {
                id: realReleaseRunId,
                run_number: 171,
                run_attempt: 1,
                head_sha: realSourceSha,
                head_branch: 'main',
                event: 'workflow_run',
                status: 'completed',
                conclusion: 'success',
                created_at: '2026-07-30T14:22:48Z',
                updated_at: '2026-07-30T14:24:23Z',
              },
            ],
          })
        }
      }
      if (url.endsWith(`/actions/runs/${realBuildRunId}/artifacts?per_page=100&page=1`)) {
        return Response.json({
          artifacts: [{ id: 9001, name: 'bayn-release-contract', expired: false }],
        })
      }
      if (url.endsWith('/actions/artifacts/9001/zip')) {
        return new Response(Uint8Array.from(storedZip('release-contract.json', JSON.stringify(realContract))).buffer)
      }
      if (url.endsWith(`/actions/runs/${realReleaseRunId}/attempts/1/jobs?per_page=100&page=1`)) {
        return Response.json({
          jobs: [
            {
              name: 'promote',
              conclusion: 'success',
              steps: [
                { name: 'Create deploy pull request', conclusion: 'success' },
                { name: 'Record held candidate', conclusion: 'skipped' },
              ],
            },
          ],
        })
      }
      if (url.endsWith(`/actions/runs/${realReleaseRunId}/attempts/1/logs`)) {
        return new Response(
          Uint8Array.from(
            storedZipEntries([
              {
                name: 'promote/4_Validate release contract.txt',
                content: `2026-07-30T14:23:25.0000000Z   WORKFLOW_SHA: ${realSourceSha}\n`,
              },
              {
                name: 'promote/8_Create deploy pull request.txt',
                content: `2026-07-30T14:24:00.0000000Z   branch: codex/bayn-release-current
2026-07-30T14:24:00.0000000Z   base: main
2026-07-30T14:24:06.0000000Z pull-request-branch = codex/bayn-release-current
2026-07-30T14:24:06.0000000Z pull-request-operation = created
2026-07-30T14:24:06.0000000Z pull-request-head-sha = ${realPromotionHeadSha}
2026-07-30T14:24:06.0000000Z pull-request-number = ${realPullNumber}
2026-07-30T14:24:06.0000000Z pull-request-url = https://github.com/proompteng/lab/pull/${realPullNumber}
`,
              },
            ]),
          ).buffer,
        )
      }
      throw new Error(`unexpected URL ${url}`)
    }) as typeof fetch

    const snapshot = await createGitHubPromotionEligibilityLoader({
      repository,
      token: 'test-token',
      pullNumber: realPullNumber,
      headSha: realPromotionHeadSha,
      requestTimeoutMs: 100,
      fetchFn,
    })()

    expect(snapshot.provenance).toEqual({
      status: 'resolved',
      buildRunId: realBuildRunId,
      releaseRunId: realReleaseRunId,
      promotionPullNumber: realPullNumber,
      promotionHeadSha: realPromotionHeadSha,
      contract: realContract,
    })
    const releaseQuery = workflowQueries.find((query) => query.pathname.endsWith('/bayn-release.yml/runs'))
    expect(workflowQueries.filter((query) => query.pathname.endsWith('/bayn-build-push.yml/runs'))).toHaveLength(1)
    expect(workflowQueries[0]?.searchParams.get('event')).toBe('push')
    expect(workflowQueries[0]?.searchParams.get('head_sha')).toBe(realSourceSha)
    expect(releaseQuery?.searchParams.has('head_sha')).toBeFalse()
    expect(releaseQuery?.searchParams.get('created')).toBe('2026-07-30T14:17:43.000Z..2026-07-31T14:22:43.000Z')
  })
})
