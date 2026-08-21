import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import YAML from 'yaml'

import { repoRoot } from '../../shared/cli'

type ArgoConfigMap = {
  readonly data?: Readonly<Record<string, string>>
}

type HealthStatus = {
  readonly message: string
  readonly status: string
}

const argoConfigMap = YAML.parse(
  readFileSync(join(repoRoot, 'argocd/applications/argocd/overlays/argocd-cm.yaml'), 'utf8'),
) as ArgoConfigMap
const restateDeploymentHealth =
  argoConfigMap.data?.['resource.customizations.health.restate.dev_RestateDeployment'] ?? ''

const evaluateRestateDeploymentHealth = (objectLiteral: string): HealthStatus => {
  const program = [
    'local function evaluate(obj)',
    restateDeploymentHealth,
    'end',
    `local health = evaluate(${objectLiteral})`,
    'io.write(health.status, "\\n", health.message)',
  ].join('\n')
  const result = spawnSync('lua', ['-'], { encoding: 'utf8', input: program })

  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')

  const [status, ...messageParts] = result.stdout.trimEnd().split('\n')
  return { message: messageParts.join('\n'), status: status ?? '' }
}

describe('RestateDeployment Argo CD health customization', () => {
  test('enables the standard Lua string library used by retryable-prefix matching', () => {
    expect(argoConfigMap.data?.['resource.customizations.useOpenLibs.restate.dev_RestateDeployment']).toBe('true')
  })

  test('waits until the operator observes the current generation', () => {
    expect(
      evaluateRestateDeploymentHealth(`{
        metadata = { generation = 3 },
        status = {
          observedGeneration = 2,
          deploymentId = "dp_old",
          desiredReplicas = 1,
          readyReplicas = 1,
          conditions = { { type = "Ready", status = "True" } },
        },
      }`),
    ).toEqual({
      message: 'Waiting for the Restate operator to observe the current generation.',
      status: 'Progressing',
    })
  })

  test('waits for registration even if a ready condition appears early', () => {
    expect(
      evaluateRestateDeploymentHealth(`{
        metadata = { generation = 3 },
        status = {
          observedGeneration = 3,
          desiredReplicas = 1,
          readyReplicas = 1,
          conditions = { { type = "Ready", status = "True" } },
        },
      }`),
    ).toEqual({
      message: 'Waiting for the Restate deployment registration and replicas to become ready.',
      status: 'Progressing',
    })
  })

  test('keeps an observed deployment progressing while its replicas or registration converge', () => {
    expect(
      evaluateRestateDeploymentHealth(`{
        metadata = { generation = 3 },
        status = {
          observedGeneration = 3,
          conditions = { { type = "Ready", status = "False", reason = "ReplicaSetScaling", message = "waiting for replicas" } },
        },
      }`),
    ).toEqual({ message: 'waiting for replicas', status: 'Progressing' })
  })

  test.each([
    'Kube Error: API temporarily unavailable',
    'The RestateCloudEnvironment staging does not exist',
    'The Secret key token in restate-auth does not exist',
  ])('keeps retryable indeterminate operator failures progressing: %s', (message) => {
    expect(
      evaluateRestateDeploymentHealth(`{
        metadata = { generation = 3 },
        status = {
          observedGeneration = 3,
          conditions = { { type = "Ready", status = "Unknown", reason = "FailedReconcile", message = "${message}" } },
        },
      }`),
    ).toEqual({ message, status: 'Progressing' })
  })

  test('degrades terminal reconciliation failures that require a configuration change', () => {
    expect(
      evaluateRestateDeploymentHealth(`{
        metadata = { generation = 3 },
        status = {
          observedGeneration = 3,
          conditions = { { type = "Ready", status = "Unknown", reason = "FailedReconcile", message = "Invalid Restate configuration: unsupported tunnel mode" } },
        },
      }`),
    ).toEqual({ message: 'Invalid Restate configuration: unsupported tunnel mode', status: 'Degraded' })
  })

  test('becomes healthy only for the registered current generation with all replicas ready', () => {
    expect(
      evaluateRestateDeploymentHealth(`{
        metadata = { generation = 3 },
        status = {
          observedGeneration = 3,
          deploymentId = "dp_current",
          desiredReplicas = 1,
          readyReplicas = 1,
          conditions = { { type = "Ready", status = "True" } },
        },
      }`),
    ).toEqual({
      message: 'The Restate operator registered the current deployment generation.',
      status: 'Healthy',
    })
  })

  test('accepts an intentionally scaled-to-zero deployment after registration', () => {
    expect(
      evaluateRestateDeploymentHealth(`{
        metadata = { generation = 3 },
        status = {
          observedGeneration = 3,
          deploymentId = "dp_current",
          desiredReplicas = 0,
          readyReplicas = 0,
          conditions = { { type = "Ready", status = "True" } },
        },
      }`),
    ).toEqual({
      message: 'The Restate operator registered the current deployment generation.',
      status: 'Healthy',
    })
  })
})
