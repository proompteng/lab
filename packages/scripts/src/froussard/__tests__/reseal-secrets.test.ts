import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __private } from '../reseal-secrets'

describe('froussard reseal-secrets helpers', () => {
  it('passes secret values through stdin instead of process arguments', () => {
    const manifest = __private.buildSecretManifest({
      name: 'linear-webhook-secret',
      namespace: 'froussard',
      literals: [['webhook-secret', 'do-not-expose']],
      controllerName: 'sealed-secrets',
      controllerNamespace: 'sealed-secrets',
    })

    expect(manifest).not.toContain('do-not-expose')
    expect(JSON.parse(manifest)).toMatchObject({
      metadata: { name: 'linear-webhook-secret', namespace: 'froussard' },
      data: { 'webhook-secret': Buffer.from('do-not-expose').toString('base64') },
    })
  })

  it('redacts secret literals from command diagnostics', () => {
    const args = ['kubectl', 'create', 'secret', '--from-literal=webhook-secret=do-not=log-this']
    const command = __private.redactCommand(args)
    const stderr = __private.redactCommandOutput('invalid literal do-not=log-this', args)

    expect(command).toContain('--from-literal=<redacted>')
    expect(command).not.toContain('do-not=log-this')
    expect(stderr).toBe('invalid literal <redacted>')
  })

  it('writeDocuments normalizes YAML separators', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'froussard-reseal-test-'))
    const target = join(dir, 'secrets.yaml')

    await __private.writeDocuments(target, ['---\nfirst', 'second'])

    const content = readFileSync(target, 'utf8')
    expect(content).toBe('---\nfirst\n---\nsecond\n')
  })
})
