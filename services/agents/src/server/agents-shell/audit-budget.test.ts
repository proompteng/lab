import { describe, expect, it } from 'vitest'
import { AUDIT_EVENT_BYTE_BUDGET, auditPayloadBudget } from './audit-budget'

describe('audit event preflight', () => {
  it('counts JSON escaping, Unicode and repeated aliases without materializing copies', () => {
    const shared = { text: 'snow雪😀\u0000\n\t\\"\ud800\udc00\ud800' }
    const payload = { a: shared, b: shared, ordinary: [1, null, true, false] }
    expect(auditPayloadBudget(payload)).toMatchObject({
      accepted: true,
      observedBytesLowerBound: Buffer.byteLength(JSON.stringify(payload)),
    })
  })
  it('stops before visiting later properties after a giant input', () => {
    let touched = false
    const payload = {
      patch: 'x'.repeat(AUDIT_EVENT_BYTE_BUDGET + 1),
      get next() {
        touched = true
        throw new Error('must not inspect')
      },
    }
    expect(auditPayloadBudget(payload)).toMatchObject({ accepted: false, reason: 'event_byte_budget_exceeded' })
    expect(touched).toBe(false)
  })
  it('bounds sparse arrays, property names and deep/cyclic structures', () => {
    const sparse: unknown[] = []
    sparse.length = 1_000_000_000
    expect(auditPayloadBudget(sparse).reason).toBe('event_node_budget_exceeded')
    expect(auditPayloadBudget({ ['x'.repeat(AUDIT_EVENT_BYTE_BUDGET)]: '' }).reason).toBe('event_byte_budget_exceeded')
    let deep: unknown = null
    for (let i = 0; i < 1000; i += 1) deep = { next: deep }
    expect(auditPayloadBudget(deep).reason).toBe('event_depth_budget_exceeded')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(auditPayloadBudget(cyclic).reason).toBe('cyclic_event_value')
  })
  it('never invokes accessors or custom serializers', () => {
    const payload = {
      get secret() {
        throw new Error('getter invoked')
      },
    }
    expect(auditPayloadBudget(payload).reason).toBe('unsupported_event_accessor')
    expect(
      auditPayloadBudget({
        toJSON() {
          throw new Error('serializer invoked')
        },
      }).reason,
    ).toBe('unsupported_event_value')
  })
  it('bounds omitted properties and rejects array getters and inherited enumeration', () => {
    const omitted = Object.fromEntries(Array.from({ length: 70_000 }, (_, i) => [`key${i}`, undefined]))
    expect(auditPayloadBudget(omitted).reason).toBe('event_node_budget_exceeded')
    const array = [0]
    Object.defineProperty(array, '0', {
      get() {
        throw new Error('array getter invoked')
      },
    })
    expect(auditPayloadBudget(array).reason).toBe('unsupported_event_accessor')
    expect(auditPayloadBudget(Object.create({ ordinary: 1 })).reason).toBe('unsupported_event_prototype')
    const inherited = [0]
    Object.setPrototypeOf(inherited, {
      get 0() {
        throw new Error('inherited getter invoked')
      },
    })
    expect(auditPayloadBudget(inherited).reason).toBe('unsupported_event_prototype')
  })

  it('accepts ordinary multi-megabyte results', () => {
    expect(auditPayloadBudget({ result: { content: 'ordinary'.repeat(400_000) } }).accepted).toBe(true)
  })
})
