import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse, parseAllDocuments } from 'yaml'

const root = resolve(import.meta.dir, '../../../../..')

test('Bilig delivery deadlines outlast replica shutdown and initialization', () => {
  const deployment = parse(readFileSync(resolve(root, 'argocd/applications/bilig/zero-deployment.yaml'), 'utf8'))
  const pod = deployment.spec.template.spec
  const zero = pod.containers.find((container: { name: string }) => container.name === 'bilig-zero')
  const initialization = zero.startupProbe.periodSeconds * zero.startupProbe.failureThreshold
  const progressDeadline = deployment.spec.progressDeadlineSeconds ?? 600
  expect(progressDeadline).toBeGreaterThan(pod.terminationGracePeriodSeconds + initialization)

  const stages = parseAllDocuments(readFileSync(resolve(root, 'argocd/applications/kargo/stages.yaml'), 'utf8'))
  const stage = stages.map((document) => document.toJSON()).find((resource) => resource.metadata.name === 'bilig')
  const deploy = stage.spec.promotionTemplate.spec.steps.find((step: { uses: string }) => step.uses === 'argocd-update')
  const timeout = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(deploy.retry.timeout)
  expect(timeout).not.toBeNull()
  const seconds = Number(timeout?.[1] ?? 0) * 3600 + Number(timeout?.[2] ?? 0) * 60 + Number(timeout?.[3] ?? 0)
  expect(seconds).toBeGreaterThan(progressDeadline)
})
