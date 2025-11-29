import { describe, expect, it } from 'bun:test'

import { createDbClient } from './index'

describe('createDbClient', () => {
  it('configures the Convex client with the provided CONVEX_URL', async () => {
    const prev = Bun.env.CONVEX_URL
    Bun.env.CONVEX_URL = 'https://convex.proompteng.ai'

    const client = await createDbClient()

    expect(client).toBeTruthy()

    Bun.env.CONVEX_URL = prev
  })
})
