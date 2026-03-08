import { describe, expect, it } from 'bun:test'

import { classifyJangarImageMode } from '../resolve-jangar-image-mode'

describe('classifyJangarImageMode', () => {
  it('reuses the published image for chart-only changes', () => {
    expect(
      classifyJangarImageMode(['charts/agents/values-ci.yaml', 'charts/agents/templates/deployment.yaml']),
    ).toEqual({
      mode: 'reuse-published-image',
      needsLocalJangarImage: false,
      matchedPaths: [],
    })
  })

  it('builds a local image for jangar changes', () => {
    const result = classifyJangarImageMode(['services/jangar/src/server/control-plane-status.ts'])
    expect(result.mode).toBe('build-local-image')
    expect(result.needsLocalJangarImage).toBe(true)
    expect(result.matchedPaths).toEqual(['services/jangar/src/server/control-plane-status.ts'])
  })

  it('builds a local image when bun.lock changes', () => {
    const result = classifyJangarImageMode(['bun.lock'])
    expect(result.mode).toBe('build-local-image')
    expect(result.matchedPaths).toEqual(['bun.lock'])
  })

  it('builds a local image for shared jangar dependency package changes', () => {
    const result = classifyJangarImageMode(['packages/temporal-bun-sdk/src/index.ts'])
    expect(result.mode).toBe('build-local-image')
    expect(result.matchedPaths).toEqual(['packages/temporal-bun-sdk/src/index.ts'])
  })
})
