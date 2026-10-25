import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(__dirname, '../../../..')

const readRepoFile = async (relativePath: string): Promise<string> => {
  const absolutePath = resolve(repoRoot, relativePath)
  return readFile(absolutePath, 'utf8')
}

describe('Codex Argo manifests', () => {
  it('does not ship legacy Codex WorkflowTemplates from the Froussard app', async () => {
    const kustomization = await readRepoFile('argocd/applications/froussard/kustomization.yaml')

    expect(kustomization).not.toContain('github-codex-implementation-workflow-template.yaml')
    expect(kustomization).not.toContain('codex-run-workflow-template-jangar.yaml')
    expect(kustomization).not.toContain('codex-autonomous-workflow-template.yaml')
    expect(kustomization).not.toContain('github-codex-post-deploy-workflow-template.yaml')
  })

  it('does not own generic Argo workflow completion ingestion', async () => {
    const kustomization = await readRepoFile('argocd/applications/froussard/kustomization.yaml')

    expect(kustomization).not.toContain('event-bus.yaml')
    expect(kustomization).not.toContain('workflow-completions')
    expect(kustomization).not.toContain('argo-workflows-completions-topic.yaml')
  })

  it('does not ship the retired Codex judge Kafka topic after Agents owns projections', async () => {
    const kustomization = await readRepoFile('argocd/applications/froussard/kustomization.yaml')
    const service = await readRepoFile('argocd/applications/froussard/knative-service.yaml')

    expect(kustomization).not.toContain('github-webhook-codex-judge-topic.yaml')
    expect(service).not.toContain('KAFKA_CODEX_JUDGE_TOPIC')
    expect(service).not.toContain('github.webhook.codex.judge')
  })

  it('stages Linear intake independently without activating credentials before rollout', async () => {
    const kustomization = await readRepoFile('argocd/applications/froussard/kustomization.yaml')
    const service = await readRepoFile('argocd/applications/froussard/knative-service.yaml')
    const topic = await readRepoFile('argocd/applications/froussard/linear-webhook-topic.yaml')

    expect(kustomization).toContain('linear-webhook-topic.yaml')
    expect(kustomization).not.toContain('linear-secrets.yaml')
    expect(service).toContain('name: LINEAR_WEBHOOK_ENABLED')
    expect(service).toContain('value: "false"')
    expect(service).not.toContain('name: LINEAR_WEBHOOK_SECRET')
    expect(service).not.toContain('name: linear-webhook-secret')
    expect(topic).toContain('topicName: linear.webhook.events')
  })
})
