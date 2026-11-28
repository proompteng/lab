import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'
import YAML from 'yaml'

const root = new URL('../../../../../', import.meta.url)
const read = (path: string): Record<string, any>[] =>
  YAML.parseAllDocuments(readFileSync(new URL(path, root), 'utf8')).map((doc) => doc.toJSON())
const templates = read('argocd/applications/kargo/smoke-verification.yaml')
const stages = read('argocd/applications/kargo/stages.yaml')
const credentials = read('argocd/applications/kargo/git-credentials.yaml')
const access = read('argocd/applications/kargo/smoke-access.yaml')

describe('Kargo release smoke verification', () => {
  it('resolves every Stage verification and isolates credentials by Project', () => {
    const projectNames = new Set(read('argocd/applications/kargo/project.yaml').map((p) => p.metadata.name))
    expect(projectNames.size).toBe(25)
    expect(credentials).toHaveLength(projectNames.size)
    for (const credential of credentials) {
      expect(projectNames.has(credential.metadata.namespace)).toBe(true)
      expect(credential.spec.template.metadata.namespace).toBe(credential.metadata.namespace)
      expect(credential.spec.encryptedData).toHaveProperty('sshPrivateKey')
    }
    for (const stage of stages) {
      const verification = stage.spec.verification
      const template = templates.find((t) => t.metadata.name === verification.analysisTemplates[0].name)
      expect(template, stage.metadata.name).toBeDefined()
      expect(verification.analysisTemplates[0].kind).toBe('ClusterAnalysisTemplate')
      for (const arg of verification.args) expect(arg.value, `${stage.metadata.name}/${arg.name}`).not.toBe('')
      expect(verification.args.map((a: any) => a.name).sort()).toEqual(
        template!.spec.args.map((a: any) => a.name).sort(),
      )
      expect(projectNames.has(stage.metadata.namespace)).toBe(true)
      for (const request of stage.spec.requestedFreight) {
        for (const upstream of request.sources.stages ?? []) {
          expect(stages.find((s) => s.metadata.name === upstream)?.metadata.namespace).toBe(stage.metadata.namespace)
        }
      }
    }
  })

  it('opens each protected endpoint only to its matching release smoke Pods', () => {
    for (const policy of access.filter((p) => p.kind === 'NetworkPolicy')) {
      expect(policy.spec.policyTypes).toEqual(['Ingress'])
      expect(policy.spec.ingress).toHaveLength(1)
      const rule = policy.spec.ingress[0]
      const stage = stages.find((s) => policy.metadata.name === `kargo-smoke-${s.metadata.name}`)!
      expect(rule.from).toEqual([
        {
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': stage.metadata.namespace } },
          podSelector: { matchLabels: { 'app.kubernetes.io/name': 'kargo-smoke' } },
        },
      ])
      expect(rule.ports).toHaveLength(1)
      expect(rule.ports[0].protocol).toBe('TCP')
    }
  })

  it('waits for connectivity, rejects bad HTTP responses, and accepts a valid empty 204', async () => {
    const container = templates.find((t) => t.metadata.name === 'kargo-http-smoke')!.spec.metrics[0].provider.job.spec
      .template.spec.containers[0]
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        switch (new URL(request.url).pathname) {
          case '/ready':
            return new Response('ready')
          case '/wrong':
            return new Response('not initialized')
          case '/empty':
            return new Response(null, { status: 204 })
          default:
            return new Response('ready', { status: 503 })
        }
      },
    })
    try {
      const run = async (path: string, pattern: string) => {
        const child = Bun.spawn(container.command, {
          env: { ...process.env, SMOKE_URL: new URL(path, server.url).href, SMOKE_PATTERN: pattern },
          stdout: 'ignore',
          stderr: 'ignore',
        })
        return await child.exited
      }
      expect(await run('/ready', '^ready$')).toBe(0)
      expect(await run('/wrong', '^ready$')).not.toBe(0)
      expect(await run('/failed', '^ready$')).not.toBe(0)
      expect(await run('/empty', 'HTTP_STATUS_ONLY')).toBe(0)
      expect(await run('/empty', '^ready$')).not.toBe(0)
      const reservation = Bun.serve({ port: 0, fetch: () => new Response('ready') })
      const delayedPort = reservation.port
      reservation.stop(true)
      let delayed: ReturnType<typeof Bun.serve> | undefined
      const timer = setTimeout(() => {
        delayed = Bun.serve({ port: delayedPort, fetch: () => new Response('ready') })
      }, 250)
      try {
        const child = Bun.spawn(container.command, {
          env: { ...process.env, SMOKE_URL: `http://127.0.0.1:${delayedPort}/`, SMOKE_PATTERN: '^ready$' },
          stdout: 'ignore',
          stderr: 'ignore',
        })
        expect(await child.exited).toBe(0)
      } finally {
        clearTimeout(timer)
        delayed?.stop(true)
      }
    } finally {
      server.stop(true)
    }
  }, 30_000)
})
