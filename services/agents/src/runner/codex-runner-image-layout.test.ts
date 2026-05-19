import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const dockerfile = () => readFileSync(new URL('../../Dockerfile.codex-runner', import.meta.url), 'utf8')

const finalStage = () => {
  const content = dockerfile()
  const start = content.lastIndexOf('\nFROM ')
  expect(start).toBeGreaterThanOrEqual(0)
  return content.slice(start + 1)
}

describe('Agents Codex runner image layout', () => {
  it('does not use the OpenAI universal image or Jangar runner scripts', () => {
    const content = dockerfile()

    expect(content).not.toContain('ghcr.io/openai/codex-universal')
    expect(content).not.toContain('services/jangar')
    expect(content).not.toContain('codex-implement')
  })

  it('keeps native build tooling out of the final runtime stage', () => {
    const content = finalStage()

    expect(content).not.toContain('build-essential')
    expect(content).not.toContain('pkg-config')
    expect(content).not.toContain('node-gyp')
  })

  it('copies only built runner and Codex package payloads into the final image', () => {
    const content = finalStage()

    expect(content).toContain(
      'COPY --from=agents-runner-build /opt/agents-runner/agent-runner.js /app/services/agents/scripts/codex/agent-runner.js',
    )
    expect(content).toContain(
      'COPY --from=codex-package-build /opt/proompteng/packages/codex/dist /app/node_modules/@proompteng/codex/dist',
    )
    expect(content).not.toContain('COPY services/agents /app/services/agents')
    expect(content).not.toContain('COPY packages/codex /opt/proompteng/packages/codex')
    expect(content).not.toContain('cp -R /opt/proompteng/packages/codex')
  })
})
