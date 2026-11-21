import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'

import { repoRoot } from '../cli'

test('Temporal static library workflow preserves artifact permissions', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/temporal-static-libraries.yml'), 'utf8')
  const permissions = workflow.match(/\npermissions:\n([\s\S]*?)\n\njobs:/)?.[1]

  expect(permissions).toContain('actions: write')
  expect(permissions).toContain('contents: write')
  expect(workflow).toContain('actions/upload-artifact@v5')
  expect(workflow).toContain('actions/download-artifact@v6')
})

test('Temporal package release skips label updates when no release PR is found', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/temporal-bun-sdk.yml'), 'utf8')

  expect(workflow).toContain('select(.mergeCommit.oid == \\"$PUBLISHED_SHA\\") | .number')
  expect(workflow).toContain('if [[ -n "$pr_number" ]]; then')
})

test('Temporal release jobs queue without cancelling pending publications or overlapping cluster cleanup', () => {
  const workflow = YAML.parse(readFileSync(join(repoRoot, '.github/workflows/temporal-bun-sdk.yml'), 'utf8'))
  expect(workflow.concurrency['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}")
  expect(workflow.concurrency.group).toContain('github.run_id')
  expect(workflow.jobs.integration.concurrency).toEqual({
    group: 'temporal-bun-sdk-shared-cluster',
    'cancel-in-progress': false,
    queue: 'max',
  })
  expect(workflow.jobs['publish-release'].concurrency).toEqual({
    group: 'temporal-bun-sdk-publish',
    'cancel-in-progress': false,
    queue: 'max',
  })
  const publish = workflow.jobs['publish-release'].steps.find(
    (step: { name: string }) => step.name === 'Publish package to npm',
  ).run
  expect(publish.indexOf('assertPublishTag(')).toBeLessThan(publish.indexOf('npm publish --tag'))
})

test('Temporal Bun SDK keeps PR validation fast and reserves remote load gates for main and releases', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/temporal-bun-sdk.yml'), 'utf8')
  const action = './.github/actions/test-temporal-bun-sdk'
  const integrationAction = './.github/actions/test-temporal-bun-sdk-integration'
  const testAction = readFileSync(join(repoRoot, action, 'action.yml'), 'utf8')
  const integrationCommand = readFileSync(join(repoRoot, integrationAction, 'action.yml'), 'utf8')
  const queue = YAML.parse(readFileSync(join(repoRoot, '.github/workflows/queue-service-validation.yml'), 'utf8'))
  const testJob = workflow.match(/\n  test:\n([\s\S]*?)\n  integration:/)?.[1]
  const integrationJob = workflow.match(/\n  integration:\n([\s\S]*?)\n  prepare-release:/)?.[1]

  expect(testJob).toContain('runs-on: ubuntu-latest')
  expect(testJob).toContain(`uses: ${action}`)
  expect(queue.jobs['temporal-bun-sdk']).toMatchObject({
    'runs-on': 'ubuntu-latest',
    env: { TEMPORAL_TEST_TIMEOUT: '30000', TEMPORAL_INTEGRATION_TESTS: '0' },
    steps: [{ uses: 'actions/checkout@v5' }, { uses: action }],
  })
  expect(testAction).toContain("! -path 'tests/integration/*'")
  expect(testAction).toContain('No Temporal Bun SDK non-integration tests were discovered.')
  expect(testAction).not.toContain('Install Temporal CLI')
  expect(testAction).not.toContain('test:load')
  expect(integrationJob).toContain("if: github.event_name != 'pull_request'")
  expect(integrationJob).toContain('runs-on: arc-arm64')
  expect(integrationJob).toContain('TEMPORAL_ADDRESS: temporal-grpc:7233')
  expect(integrationJob).toContain(`uses: ${integrationAction}`)
  expect(integrationCommand).toContain("! -path 'tests/integration/worker-load.test.ts'")
  expect(integrationCommand).toContain('bun test "${integration_files[@]}" --timeout=30000 --max-concurrency=1')
  expect(integrationCommand).toContain(
    'bun test tests/integration/worker-load.test.ts --timeout=30000 --max-concurrency=1',
  )
  expect(integrationCommand).not.toContain('test:load')
  expect(integrationCommand.match(/cleanup-integration-workflows\.ts --verify/g)).toHaveLength(2)
  expect(workflow).toContain('needs:\n      - test\n      - integration')
  expect(workflow.match(/- '\.github\/workflows\/temporal-bun-sdk\.yml'/g)).toHaveLength(2)
})

test('the SDK merge-group integration gate starts isolated pinned server and visibility databases', () => {
  const queue = YAML.parse(readFileSync(join(repoRoot, '.github/workflows/queue-service-validation.yml'), 'utf8'))
  const job = queue.jobs['temporal-bun-sdk-integration']
  expect(job.needs).toBeUndefined()
  expect(job.secrets).toBeUndefined()
  expect(job['runs-on']).toBe('ubuntu-24.04')
  expect(job.env).toMatchObject({
    TEMPORAL_TEST_SERVER: '1',
    TEMPORAL_INTEGRATION_TESTS: '1',
    TEMPORAL_BUN_RELEASE_GATE: '1',
    TEMPORAL_CLI_COMMAND_MAX_ATTEMPTS: '1',
  })
  const compose = YAML.parse(readFileSync(join(repoRoot, job.env.COMPOSE_FILE), 'utf8'))
  expect(compose.networks.default.internal).toBe(true)
  expect(compose.services.temporal.ports).toBeUndefined()
  expect(compose.services.temporal.depends_on.schema.condition).toBe('service_completed_successfully')
  expect(compose.services.temporal.image).toContain('temporalio/server:1.32.2@sha256:')
  expect(compose.services.schema.command[0]).toContain('temporal temporal_visibility')
  const commands = job.steps.map((step: { run?: string }) => step.run ?? '').join('\n')
  expect(commands).not.toContain('--terminate')
  expect(commands).not.toContain('temporal-grpc')
  expect(job.steps).toContainEqual({ uses: './.github/actions/test-temporal-bun-sdk-integration' })
  expect(job.steps.at(-1)).toMatchObject({ if: 'always()', run: 'docker compose down --volumes' })
})
