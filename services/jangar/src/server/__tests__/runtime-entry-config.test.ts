import { describe, expect, it } from 'vitest'

import { resolveHttpServerListenConfig } from '~/server/runtime-entry-config'

describe('runtime entry config', () => {
  it('uses a production HTTP idle timeout long enough for embedding-backed routes', () => {
    expect(resolveHttpServerListenConfig({})).toMatchObject({
      port: 3000,
      hostname: '0.0.0.0',
      idleTimeoutSeconds: 120,
    })
  })

  it('allows the HTTP idle timeout to be configured', () => {
    expect(
      resolveHttpServerListenConfig({
        JANGAR_HTTP_IDLE_TIMEOUT_SECONDS: '180',
      }).idleTimeoutSeconds,
    ).toBe(180)
  })

  it('falls back for invalid HTTP idle timeout values', () => {
    expect(
      resolveHttpServerListenConfig({
        JANGAR_HTTP_IDLE_TIMEOUT_SECONDS: '0',
      }).idleTimeoutSeconds,
    ).toBe(120)
  })
})
