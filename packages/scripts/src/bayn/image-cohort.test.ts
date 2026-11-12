import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

import { expect, test } from 'bun:test'
import YAML from 'yaml'

const source = '1'.repeat(40)
const runId = '123456'
const workflow = YAML.parse(
  readFileSync(new URL('../../../../.github/workflows/bayn-build-push.yml', import.meta.url), 'utf8'),
)
const steps = workflow.jobs['publish-cohort'].steps
const verify = steps.find((step: { name?: string }) => step.name?.startsWith('Verify every immutable image')).run
const publish = steps.find((step: { name?: string }) => step.name === 'Publish the verified cohort for Kargo').run
const digests = {
  bayn: `sha256:${'a'.repeat(64)}`,
  'bayn-research': `sha256:${'b'.repeat(64)}`,
  'bayn-broker-feed': `sha256:${'c'.repeat(64)}`,
}

const runStep = (script: string, directory: string, overrides: Record<string, string> = {}) =>
  Bun.spawnSync(
    [
      'bash',
      '-c',
      `
      bun() { printf '%s\\n' "$*" >> "$CI_CALLS"; }
      crane() {
        local revision="$GITHUB_SHA"
        if [[ "$2" = *"bayn-broker-feed@"* && -n "\${BROKER_SOURCE_OVERRIDE:-}" ]]; then
          revision="$BROKER_SOURCE_OVERRIDE"
        fi
        jq -n --arg source "$revision" --arg run "$GITHUB_RUN_ID" \
          '{annotations: {"org.opencontainers.image.revision": $source, "org.opencontainers.image.source": "https://github.com/proompteng/lab", "ai.proompteng.github-actions-run-id": $run, "ai.proompteng.github-actions-build-conclusion": "success"}}'
      }
      ${script}`,
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        GITHUB_SHA: source,
        GITHUB_RUN_ID: runId,
        BAYN_DIGEST: digests.bayn,
        RESEARCH_DIGEST: digests['bayn-research'],
        BROKER_FEED_DIGEST: digests['bayn-broker-feed'],
        KARGO_TAG: `kargo-sha-${source}-run-${runId}`,
        CI_CALLS: join(directory, 'calls'),
        ...overrides,
      },
    },
  )

test('verifies every source-bound cohort artifact before recording or publishing any discovery alias', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bayn-cohort-'))
  try {
    expect(runStep(verify, directory).exitCode).toBe(0)
    expect(JSON.parse(readFileSync(join(directory, 'bayn-image-cohort.json'), 'utf8'))).toEqual({
      sourceRevision: source,
      runId,
      tradingDigest: digests.bayn,
      researchDigest: digests['bayn-research'],
      brokerFeedDigest: digests['bayn-broker-feed'],
    })
    const checked = readFileSync(join(directory, 'calls'), 'utf8').trim().split('\n')
    expect(checked).toHaveLength(3)
    expect(checked.every((call) => call.includes('oci.ts assert '))).toBe(true)
    expect(checked.every((call) => call.includes('--platform linux/amd64 --platform linux/arm64'))).toBe(true)
    expect(runStep(publish, directory).exitCode).toBe(0)
    const published = readFileSync(join(directory, 'calls'), 'utf8').trim().split('\n').slice(3)
    expect(published).toHaveLength(3)
    for (const [member, digest] of Object.entries(digests)) {
      expect(published).toContain(
        `run packages/scripts/src/shared/oci.ts publish-kargo-tag --image registry.ide-newton.ts.net/lab/${member} --reference registry.ide-newton.ts.net/lab/${member}@${digest} --kargo-tag kargo-sha-${source}-run-${runId}`,
      )
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a mismatched broker-feed source fails verification without recording the cohort', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bayn-cohort-'))
  try {
    expect(runStep(verify, directory, { BROKER_SOURCE_OVERRIDE: '2'.repeat(40) }).exitCode).not.toBe(0)
    expect(existsSync(join(directory, 'bayn-image-cohort.json'))).toBe(false)
    expect(readFileSync(join(directory, 'calls'), 'utf8')).not.toContain('publish-kargo-tag')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Kargo rejects a collector from a different source, run, publisher or failed build', () => {
  const warehouse = YAML.parseAllDocuments(
    readFileSync(new URL('../../../../argocd/applications/kargo/warehouses.yaml', import.meta.url), 'utf8'),
  )
    .find((document) => document.getIn(['metadata', 'name']) === 'bayn')
    ?.toJSON()
  const images = Object.fromEntries(
    Object.keys(digests).map((member) => [
      `registry.ide-newton.ts.net/lab/${member}`,
      {
        Tag: `kargo-sha-${source}-run-${runId}`,
        Annotations: {
          'org.opencontainers.image.revision': source,
          'org.opencontainers.image.source': 'https://github.com/proompteng/lab',
          'ai.proompteng.github-actions-run-id': runId,
          'ai.proompteng.github-actions-build-conclusion': 'success',
        },
      },
    ]),
  )
  const collector = 'registry.ide-newton.ts.net/lab/bayn-broker-feed'
  const evaluate = (annotations: Record<string, string> = {}, tag = images[collector].Tag) =>
    runInNewContext(
      warehouse.spec.freightCreationCriteria.expression,
      {
        nil: null,
        imageFrom: (repo: string) =>
          repo === collector
            ? { Tag: tag, Annotations: { ...images[repo].Annotations, ...annotations } }
            : images[repo],
      },
      { timeout: 100 },
    )
  expect(evaluate()).toBe(true)
  const rejectedAnnotations: Record<string, string>[] = [
    { 'org.opencontainers.image.revision': '2'.repeat(40) },
    { 'org.opencontainers.image.source': 'https://github.com/other/publisher' },
    { 'ai.proompteng.github-actions-run-id': '123457' },
    { 'ai.proompteng.github-actions-build-conclusion': 'failure' },
  ]
  for (const annotations of rejectedAnnotations) {
    expect(evaluate(annotations)).toBe(false)
  }
  expect(evaluate({}, `kargo-sha-${source}-run-123457`)).toBe(false)
})
