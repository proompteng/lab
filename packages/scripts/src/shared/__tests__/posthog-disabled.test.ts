import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'bun:test'
import YAML from 'yaml'

const repoRoot = new URL('../../../../../', import.meta.url)
const readRepoFile = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8')

describe('removed PostHog integration', () => {
  it('removes the PostHog application source and ApplicationSet entry', () => {
    const productApplicationSet = readRepoFile('argocd/applicationsets/product.yaml')

    expect(existsSync(new URL('argocd/applications/posthog/kustomization.yaml', repoRoot))).toBe(false)
    expect(productApplicationSet).not.toContain('name: posthog')
    expect(productApplicationSet).not.toContain('argocd/applications/posthog')
  })

  it('removes PostHog Kafka resources from the Kafka application', () => {
    const kustomization = YAML.parse(readRepoFile('argocd/applications/kafka/kustomization.yaml')) as {
      resources: string[]
    }

    expect(kustomization.resources).not.toContain('posthog-kafkauser.yaml')
    expect(kustomization.resources).not.toContain('posthog-topics.yaml')
  })

  it('removes Symphony PostHog configuration and credentials', () => {
    const baseDeployment = readRepoFile('argocd/applications/symphony-base/deployment.yaml')
    const symphonyKustomization = readRepoFile('argocd/applications/symphony/kustomization.yaml')
    const torghutKustomization = readRepoFile('argocd/applications/symphony-torghut/kustomization.yaml')
    const torghutPatch = readRepoFile('argocd/applications/symphony-torghut/deployment.patch.yaml')

    expect(baseDeployment).not.toContain('POSTHOG_')
    expect(symphonyKustomization).not.toContain('posthog-sealedsecret.yaml')
    expect(torghutKustomization).not.toContain('posthog-sealedsecret.yaml')
    expect(torghutPatch).not.toContain('POSTHOG_API_KEY')
    expect(torghutPatch).not.toContain('POSTHOG_PROJECT_ID')
  })

  it('removes Torghut PostHog configuration and runtime wiring', () => {
    const runtime = readRepoFile('services/torghut/app/trading/scheduler/runtime.py')
    const submissionPolicy = readRepoFile('services/torghut/app/trading/scheduler/pipeline/submission_policy.py')
    const featureFlags = readRepoFile('argocd/applications/feature-flags/gitops/default/features.yaml')
    const manifests = [
      'argocd/applications/torghut/knative-service.yaml',
      'argocd/applications/torghut/knative-service-sim.yaml',
      'argocd/applications/torghut/scheduler-deployment.yaml',
    ].map(readRepoFile)

    expect(existsSync(new URL('services/torghut/app/observability/posthog.py', repoRoot))).toBe(false)
    expect(runtime.toLowerCase()).not.toContain('posthog')
    expect(submissionPolicy.toLowerCase()).not.toContain('posthog')
    expect(featureFlags).not.toContain('torghut_posthog_enabled')
    for (const manifest of manifests) expect(manifest).not.toContain('POSTHOG_')
  })
})
