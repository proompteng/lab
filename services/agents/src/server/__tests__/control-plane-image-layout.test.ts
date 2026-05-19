import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const dockerfile = () => readFileSync(new URL('../../../Dockerfile', import.meta.url), 'utf8')

const dockerfileTarget = (target: string) => {
  const content = dockerfile()
  const start = content.indexOf(` AS ${target}`)
  expect(start).toBeGreaterThanOrEqual(0)
  const fromStart = content.lastIndexOf('\nFROM ', start)
  const next = content.indexOf('\nFROM ', start + target.length)
  return content.slice(fromStart >= 0 ? fromStart + 1 : 0, next >= 0 ? next : undefined)
}

describe('Agents control-plane image layout', () => {
  it('builds the Agents service for the control-plane target', () => {
    const content = dockerfileTarget('control-plane')

    expect(content).toContain('WORKDIR /app/services/agents')
    expect(content).toContain('COPY --from=agents-build /app/services/agents/src ./src')
    expect(content).toContain('CMD ["bun", "run", "src/server/index.ts"]')
    expect(content).not.toContain('services/jangar')
    expect(content).not.toContain('.output/server/index.mjs')
  })

  it('keeps the transitional Jangar server bundle isolated to the controller target', () => {
    const content = dockerfileTarget('controller')

    expect(content).toContain('COPY --from=jangar-build /app/services/jangar/.output/server ./.output/server')
    expect(content).toContain('CMD ["bun", "run", ".output/server/index.mjs"]')
    expect(content).not.toContain('bun run build;')
  })

  it('does not copy Jangar client assets into the transitional controller image', () => {
    const content = dockerfileTarget('controller')

    expect(dockerfile()).toContain('rm -rf .output/public')
    expect(content).toContain('COPY --from=jangar-build /app/services/jangar/.output/server ./.output/server')
    expect(content).not.toContain('COPY --from=jangar-build /app/services/jangar/.output ./.output')
  })

  it('starts the transitional server in the non-client Agents control-plane profile', () => {
    expect(dockerfileTarget('control-plane')).toContain('AGENTS_SERVER_PROFILE=agents-control-plane')
  })
})
