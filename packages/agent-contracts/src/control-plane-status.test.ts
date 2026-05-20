import { describe, expect, it } from 'vitest'

import { isControlPlaneHeartbeatFresh } from './control-plane-status'

describe('control-plane status contracts', () => {
  it('treats control-plane heartbeats as fresh only inside the observed/expiry window', () => {
    const heartbeat = {
      observed_at: '2026-03-08T12:00:00Z',
      expires_at: '2026-03-08T12:02:00Z',
    }

    expect(isControlPlaneHeartbeatFresh(heartbeat, new Date('2026-03-08T12:01:00Z'))).toBe(true)
    expect(isControlPlaneHeartbeatFresh(heartbeat, new Date('2026-03-08T12:03:00Z'))).toBe(false)
  })
})
