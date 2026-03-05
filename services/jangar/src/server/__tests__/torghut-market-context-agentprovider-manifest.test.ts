import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('torghut market-context AgentProvider manifest', () => {
  it('uses a bearer token for lifecycle start/progress requests', async () => {
    const manifest = await readFile(
      resolve(process.cwd(), '..', '..', 'argocd/applications/agents/torghut-market-context-agentprovider.yaml'),
      'utf8',
    )

    expect(manifest).toContain("DEFAULT_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token'")
    expect(manifest).toContain('token = _load_bearer_token()')
    expect(manifest).toContain("headers['authorization'] = f'Bearer {token}'")
  })
})
