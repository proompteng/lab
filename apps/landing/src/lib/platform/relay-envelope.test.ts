import { expect, test } from 'bun:test'
import { relayEnvelope } from './relay-envelope'

test('the public relay envelope requires an explicit purpose and preserves exact signed bytes', () => {
  const body = Buffer.from('{\n "arguments": {"value":"\\u00e9"} }\n')
  for (const kind of ['execute', 'lookup'] as const) {
    const parsed = relayEnvelope.parse({ kind, body: body.toString('base64') })
    expect(parsed.body.equals(body)).toBe(true)
    expect(parsed.kind).toBe(kind)
  }
  for (const value of [
    { body: body.toString('base64') },
    { kind: 'other', body: body.toString('base64') },
    { kind: 'execute', body: 'Z' },
    { kind: 'execute', body: 'e30' },
    { kind: 'execute', body: 'e30=\n' },
    { kind: 'lookup', body: '' },
    { kind: 'execute', body: body.toString('base64'), clientService: 'other' },
  ])
    expect(relayEnvelope.safeParse(value).success).toBe(false)
})

test('execution and lookup enforce their own decoded byte budgets', () => {
  for (const [kind, limit] of [
    ['execute', 65_536],
    ['lookup', 262_144],
  ] as const) {
    expect(relayEnvelope.safeParse({ kind, body: Buffer.alloc(limit).toString('base64') }).success).toBe(true)
    expect(relayEnvelope.safeParse({ kind, body: Buffer.alloc(limit + 1).toString('base64') }).success).toBe(false)
  }
})
