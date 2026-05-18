import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const dockerfile = () => readFileSync(new URL('../../../Dockerfile', import.meta.url), 'utf8')

describe('Agents control-plane image layout', () => {
  it('builds only the transitional server bundle while REST and gRPC routes finish moving', () => {
    const content = dockerfile()

    expect(content).toContain('bun run build:server')
    expect(content).toContain('bun run copy:grpc-proto')
    expect(content).not.toContain('bun run build;')
  })

  it('does not copy Jangar client assets into the Agents control-plane image', () => {
    const content = dockerfile()

    expect(content).toContain('rm -rf .output/public')
    expect(content).toContain('COPY --from=agents-build /app/services/jangar/.output/server ./.output/server')
    expect(content).not.toContain('COPY --from=agents-build /app/services/jangar/.output ./.output')
  })

  it('starts the transitional server in the non-client Agents control-plane profile', () => {
    expect(dockerfile()).toContain('AGENTS_SERVER_PROFILE=agents-control-plane')
  })
})
