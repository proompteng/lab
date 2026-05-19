import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'bun:test'

const guardScript = () => readFileSync(resolve(process.cwd(), 'scripts/agents/guard-extraction-boundaries.sh'), 'utf8')

describe('agents extraction boundary guard', () => {
  it('does not fail on colocated tests that assert forbidden runtime strings are absent', () => {
    const content = guardScript()

    expect(content).toContain("--glob '!**/__tests__/**'")
    expect(content).toContain("--glob '!**/*.test.*'")
  })

  it('guards legacy completion topics and reflected Jangar database secrets out of Agents runtime', () => {
    const content = guardScript()

    expect(content).toContain('ingressroute-agents-api\\.yaml')
    expect(content).toContain('agents\\.k8s\\.proompteng\\.ai')
    expect(content).toContain('proxyAgentsServiceRequest|buildAgentsServiceProxyUrl')
    expect(content).toContain('agents\\.proompteng\\.ai/compatibility-route')
    expect(content).toContain('argo\\.workflows\\.completions')
    expect(content).toContain('reflection-(allowed|auto)-namespaces')
    expect(content).toContain('jangar-db-ca')
    expect(content).toContain('legacy generic Agents /api/control-plane API compatibility aliases')
    expect(content).toContain(
      '/api/control-plane/(agent-events|agent-runs|events|implementation-sources|logs|resource|resources|status|stream)',
    )
    expect(content).toContain('agents-control-plane runtime profile')
    expect(content).toContain('agents-controllers runtime profile')
  })
})
