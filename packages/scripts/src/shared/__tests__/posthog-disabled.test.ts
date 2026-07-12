import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'bun:test'
import YAML from 'yaml'

const repoRoot = new URL('../../../../../', import.meta.url)
const readRepoFile = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8')

describe('disabled PostHog integration', () => {
  it('removes PostHog Kafka resources from the Kafka application', () => {
    const kustomization = YAML.parse(readRepoFile('argocd/applications/kafka/kustomization.yaml')) as {
      resources: string[]
    }

    expect(kustomization.resources).not.toContain('posthog-kafkauser.yaml')
    expect(kustomization.resources).not.toContain('posthog-topics.yaml')
  })

  it('disables Symphony emission and removes PostHog credentials', () => {
    const baseDeployment = readRepoFile('argocd/applications/symphony-base/deployment.yaml')
    const symphonyKustomization = readRepoFile('argocd/applications/symphony/kustomization.yaml')
    const torghutKustomization = readRepoFile('argocd/applications/symphony-torghut/kustomization.yaml')
    const torghutPatch = readRepoFile('argocd/applications/symphony-torghut/deployment.patch.yaml')

    expect(baseDeployment).toContain('name: POSTHOG_ENABLED\n              value: "false"')
    expect(baseDeployment).not.toContain('name: POSTHOG_HOST')
    expect(baseDeployment).not.toContain('name: POSTHOG_API_KEY')
    expect(baseDeployment).not.toContain('name: POSTHOG_PROJECT_ID')
    expect(symphonyKustomization).not.toContain('posthog-sealedsecret.yaml')
    expect(torghutKustomization).not.toContain('posthog-sealedsecret.yaml')
    expect(torghutPatch).not.toContain('POSTHOG_API_KEY')
    expect(torghutPatch).not.toContain('POSTHOG_PROJECT_ID')
  })
})
