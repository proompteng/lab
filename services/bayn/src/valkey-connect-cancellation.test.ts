import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

describe('Native Valkey connection cancellation', () => {
  test.each(['tls-cancel', 'tls-close', 'tls-reconnect', 'handshake-reconnect', 'external-abort'])(
    '%s closes only the cancelled socket and settles its connect promise',
    async (mode) => {
      const child = Bun.spawn(['node', join(import.meta.dir, 'testing/valkey-connect-cancellation-node.mjs'), mode], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
      expect(JSON.parse(stdout).mode).toBe(mode)
    },
  )
})
