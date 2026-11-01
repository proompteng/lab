import { expect, test } from 'bun:test'
import { Result, Schema, SchemaIssue } from 'effect'

import { decodePositions } from './model'
import { positionDecodeDiagnostic, type PositionDecodeDiagnostic } from './response-decode-diagnostics'

const position = {
  asset_id: 'b0b6dd9d-8b9b-48a9-ba46-b9d54906e415',
  symbol: 'AAPL',
  exchange: 'NASDAQ',
  asset_class: 'us_equity',
  avg_entry_price: '100',
  cost_basis: '500',
  qty: '5',
  side: 'long',
  market_value: '600',
  unrealized_pl: '100',
  current_price: '120',
}
const diagnostic = (input: unknown) => {
  const decoded = decodePositions(input)
  if (Result.isSuccess(decoded)) throw new Error('Expected synthetic rejection')
  return positionDecodeDiagnostic(decoded.failure, input)
}

test.each([
  ['null', null],
  ['number', 12345],
  ['boolean', true],
  ['object', { private: 'never report this value' }],
  ['array', ['private']],
] as const)('positions diagnostics report only the rejected %s type', (actualType, qty) => {
  expect(diagnostic([{ ...position, qty }])).toEqual({
    field: '[].qty',
    issue: 'type',
    expectedType: 'string',
    actualType,
  })
})

test('missing, enum, refinement and envelope failures have fixed categories', () => {
  const { qty: _, ...missing } = position
  expect(diagnostic([missing])).toEqual({
    field: '[].qty',
    issue: 'missing',
    expectedType: 'string',
    actualType: 'missing',
  })
  expect(diagnostic([{ ...position, exchange: 'private-exchange' }])).toEqual({
    field: '[].exchange',
    issue: 'enum',
    expectedType: 'string',
    actualType: 'string',
  })
  expect(diagnostic([{ ...position, qty: 'private-secret-value' }])).toEqual({
    field: '[].qty',
    issue: 'constraint',
    expectedType: 'string',
    actualType: 'string',
  })
  expect(diagnostic({ private: 'not an array' })).toEqual({
    field: '$',
    issue: 'type',
    expectedType: 'array',
    actualType: 'object',
  })
  expect(diagnostic([null])).toEqual({ field: '[]', issue: 'type', expectedType: 'object', actualType: 'null' })
})

test('indices, hostile values, arbitrary keys and formatted issue messages never escape', () => {
  const secret = 'sensitive-token-account-symbol-938475'
  const input = [...Array.from({ length: 17 }, () => position), { ...position, qty: secret }]
  expect(diagnostic(input)).toEqual(diagnostic([{ ...position, qty: secret }]))
  const issue = new SchemaIssue.Pointer([17, secret], new SchemaIssue.InvalidValue({ message: secret }))
  const error = new Schema.SchemaError(issue)
  Object.defineProperty(error, 'message', {
    get: () => {
      throw new Error('must not format errors')
    },
  })
  const result = positionDecodeDiagnostic(error, input)
  expect(result).toEqual({ field: 'unknown', issue: 'unknown', expectedType: 'unknown', actualType: 'unknown' })
  expect(JSON.stringify([result, diagnostic(input)])).not.toContain(secret)
  expect(JSON.stringify(diagnostic(input))).not.toContain('17')
})

test('diagnostics do not invoke input accessors or issue formatters', () => {
  const input = [{ ...position }]
  Object.defineProperty(input[0], 'qty', {
    get: () => {
      throw new Error('private getter')
    },
  })

  const error = new Schema.SchemaError(
    new SchemaIssue.Pointer([0, 'qty'], new SchemaIssue.InvalidType(Schema.String.ast)),
  )
  expect(positionDecodeDiagnostic(error, input)).toEqual({
    field: '[].qty',
    issue: 'type',
    expectedType: 'string',
    actualType: 'unknown',
  })
})

test('hostile issue accessors and proxy traps cannot replace the original decode failure', () => {
  const unknown: PositionDecodeDiagnostic = {
    field: 'unknown',
    issue: 'unknown',
    expectedType: 'unknown',
    actualType: 'unknown',
  }
  let invoked = 0
  const hostile = () => {
    invoked += 1
    throw new Error('private-accessor-value')
  }
  const leaf = () => new SchemaIssue.InvalidType(Schema.String.ast)
  const issueGetter = new Schema.SchemaError(leaf())
  Object.defineProperty(issueGetter, 'issue', { get: hostile })
  expect(positionDecodeDiagnostic(issueGetter, [])).toEqual(unknown)
  for (const key of ['_tag', 'path', 'issue']) {
    const pointer = new SchemaIssue.Pointer([0, 'qty'], leaf())
    Object.defineProperty(pointer, key, { get: hostile })
    expect(positionDecodeDiagnostic(new Schema.SchemaError(pointer), [{ qty: null }])).toEqual(unknown)
  }
  const proxy = new Proxy(new Schema.SchemaError(leaf()), { get: hostile, getOwnPropertyDescriptor: hostile })
  expect(positionDecodeDiagnostic(proxy, [])).toEqual(unknown)
  const revoked = Proxy.revocable(new Schema.SchemaError(leaf()), {})
  revoked.revoke()
  expect(positionDecodeDiagnostic(revoked.proxy, [])).toEqual(unknown)
  expect(invoked).toBe(0)
})

test('revoked inputs and hostile path arrays degrade safely without inspecting values or iterators', () => {
  const error = new Schema.SchemaError(
    new SchemaIssue.Pointer([0, 'qty'], new SchemaIssue.InvalidType(Schema.String.ast)),
  )
  const revoked = Proxy.revocable([], {})
  revoked.revoke()
  expect(positionDecodeDiagnostic(error, revoked.proxy)).toEqual({
    field: 'unknown',
    issue: 'unknown',
    expectedType: 'unknown',
    actualType: 'unknown',
  })
  let invoked = 0
  const path = [0, 'qty']
  Object.defineProperty(path, Symbol.iterator, {
    get: () => {
      invoked += 1
      throw new Error('private-iterator')
    },
  })
  const hostilePath = new Schema.SchemaError(
    new SchemaIssue.Pointer(path, new SchemaIssue.InvalidType(Schema.String.ast)),
  )
  expect(positionDecodeDiagnostic(hostilePath, [{ qty: null }])).toEqual({
    field: '[].qty',
    issue: 'type',
    expectedType: 'string',
    actualType: 'null',
  })
  expect(invoked).toBe(0)
})

test('nested proxies, AST accessors, sparse paths and cyclic issues stay bounded and value-free', () => {
  const unknown: PositionDecodeDiagnostic = {
    field: 'unknown',
    issue: 'unknown',
    expectedType: 'unknown',
    actualType: 'unknown',
  }
  let invoked = 0
  const hostile = () => {
    invoked += 1
    throw new Error('private-nested-value')
  }
  const leaf = new SchemaIssue.InvalidType(Schema.String.ast)
  const pointer = (path: readonly PropertyKey[], issue = leaf) => new SchemaIssue.Pointer(path, issue)
  const pathProxy = new Proxy([0, 'qty'], { get: hostile, getOwnPropertyDescriptor: hostile })
  expect(positionDecodeDiagnostic(new Schema.SchemaError(pointer(pathProxy)), [])).toEqual(unknown)
  const issueProxy = new Proxy(leaf, { get: hostile, getOwnPropertyDescriptor: hostile })
  expect(positionDecodeDiagnostic(new Schema.SchemaError(pointer([0, 'qty'], issueProxy)), [])).toEqual(unknown)
  const inputProxy = new Proxy({ qty: null }, { get: hostile, getOwnPropertyDescriptor: hostile })
  expect(positionDecodeDiagnostic(new Schema.SchemaError(pointer([0, 'qty'])), [inputProxy])).toEqual({
    field: '[].qty',
    issue: 'type',
    expectedType: 'string',
    actualType: 'unknown',
  })
  const astGetter = new SchemaIssue.InvalidType(Schema.String.ast)
  Object.defineProperty(astGetter, 'ast', { get: hostile })
  expect(positionDecodeDiagnostic(new Schema.SchemaError(pointer([0, 'qty'], astGetter)), [])).toEqual(unknown)
  const path = [0, 'qty']
  Object.defineProperty(path, 1, { get: hostile })
  expect(positionDecodeDiagnostic(new Schema.SchemaError(pointer(path)), [])).toEqual(unknown)
  const cycle = pointer([])
  Object.defineProperty(cycle, 'issue', { value: cycle })
  expect(positionDecodeDiagnostic(new Schema.SchemaError(cycle), [])).toEqual(unknown)
  expect(invoked).toBe(0)
})
