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
  const appRoot = resolve(root, 'argocd/applications/bilig')
  const application = parse(readFileSync(resolve(appRoot, 'kustomization.yaml'), 'utf8'))
  const hookWaves = new Map<number, number>()
  for (const path of application.resources as string[]) {
    for (const document of parseAllDocuments(readFileSync(resolve(appRoot, path), 'utf8'))) {
      const resource = document.toJSON()
      const annotations = resource?.metadata?.annotations ?? {}
      if (
        !String(annotations['argocd.argoproj.io/hook'] ?? '')
          .split(',')
          .includes('PreSync')
      )
        continue
      expect(resource.kind).toBe('Job')
      const deadline = Number(resource.spec.activeDeadlineSeconds)
      expect(Number.isFinite(deadline) && deadline > 0).toBe(true)
      const wave = Number(annotations['argocd.argoproj.io/sync-wave'] ?? 0)
      hookWaves.set(wave, Math.max(hookWaves.get(wave) ?? 0, deadline))
    }
  }
  const preparation = [...hookWaves.values()].reduce((total, deadline) => total + deadline, 0)
  expect(seconds).toBeGreaterThanOrEqual(preparation + progressDeadline + 300)
})
