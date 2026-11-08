import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import YAML from 'yaml'

import { repoRoot } from '../../shared/cli'

type EnvEntry = {
  readonly name?: string
  readonly value?: string
}

describe('froussard release metadata', () => {
  it('promotes the public server and durable approval owner to one image and source', () => {
    const stage = YAML.parseAllDocuments(
      readFileSync(join(repoRoot, 'argocd/applications/kargo/stages.yaml'), 'utf8'),
    ).find((document) => document.getIn(['metadata', 'name']) === 'froussard')
    const steps = stage?.getIn(['spec', 'promotionTemplate', 'spec', 'steps'])
    if (!YAML.isSeq(steps)) throw new Error('Missing Froussard promotion')
    const source = 'b'.repeat(40)
    const digest = `sha256:${'c'.repeat(64)}`
    const image = { Tag: `kargo-sha-${source}`, Digest: digest }
    for (const file of ['knative-service.yaml', 'approval-worker.yaml']) {
      const document = YAML.parseDocument(readFileSync(join(repoRoot, 'argocd/applications/froussard', file), 'utf8'))
      const update = steps.items.find(
        (step) =>
          YAML.isMap(step) &&
          step.get('uses') === 'yaml-update' &&
          step.getIn(['config', 'path']) === `./out/argocd/applications/froussard/${file}`,
      )
      const updates = YAML.isMap(update) ? update.getIn(['config', 'updates']) : undefined
      if (!YAML.isSeq(updates)) throw new Error(`Missing promotion updates for ${file}`)
      for (const item of updates.items) {
        if (!YAML.isMap(item)) throw new Error('Invalid promotion update')
        const key = item.get('key')
        const value = item.get('value')
        if (typeof key !== 'string' || typeof value !== 'string') throw new Error('Invalid promotion value')
        const resolved = value.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expression: string) =>
          runInNewContext(expression, {
            vars: { imageRepo: 'registry.ide-newton.ts.net/lab/froussard' },
            imageFrom: () => image,
            trimPrefix: (value: string, prefix: string) =>
              value.startsWith(prefix) ? value.slice(prefix.length) : value,
          }),
        )
        document.setIn(
          key.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part)),
          resolved,
        )
      }
      expect(document.getIn(['spec', 'template', 'spec', 'containers', 0, 'image'])).toBe(
        `registry.ide-newton.ts.net/lab/froussard@${digest}`,
      )
      const env = document.getIn(['spec', 'template', 'spec', 'containers', 0, 'env'])
      if (!YAML.isSeq(env)) throw new Error('Missing release metadata')
      const values = new Map(
        env.items.map((entry) => (YAML.isMap(entry) ? [entry.get('name'), entry.get('value')] : [])),
      )
      expect(values.get('FROUSSARD_COMMIT')).toBe(source)
      expect(values.get('FROUSSARD_VERSION')).toBe(image.Tag)
    }
  })
  it('keeps the checked-in version aligned with the promoted source commit', () => {
    const manifest = YAML.parse(
      readFileSync(join(repoRoot, 'argocd/applications/froussard/knative-service.yaml'), 'utf8'),
    )
    const env = manifest.spec.template.spec.containers[0].env as EnvEntry[]
    const commit = env.find((entry) => entry.name === 'FROUSSARD_COMMIT')?.value
    const version = env.find((entry) => entry.name === 'FROUSSARD_VERSION')?.value

    expect(commit).toMatch(/^[0-9a-f]{40}$/)
    const described = version?.match(/^v\d+\.\d+\.\d+-\d+-g([0-9a-f]{7,40})$/)
    expect(described).not.toBeNull()
    expect(commit?.startsWith(described?.[1] ?? '')).toBe(true)
  })
})
