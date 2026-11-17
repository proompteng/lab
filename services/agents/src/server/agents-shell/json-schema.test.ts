import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { effectSchemaToJsonSchema } from './json-schema'
import { EmptyInputSchema, ExecInputSchema } from './schemas'

describe('MCP JSON schemas', () => {
  it('publishes constrained optional arguments without allowing null', () => {
    expect(effectSchemaToJsonSchema(ExecInputSchema)).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['requestKey', 'command', 'sessionId'],
      properties: {
        outputEncoding: { type: 'string', enum: ['utf8', 'base64'] },
        requestKey: { type: 'string', minLength: 1, maxLength: 128 },
        timeoutSeconds: { type: 'integer', minimum: 1 },
        waitMs: { type: 'integer', minimum: 0, maximum: 30_000 },
        maxBytes: { type: 'integer', minimum: 4096, maximum: 1_048_576 },
      },
    })
    const decode = Schema.decodeUnknownSync(ExecInputSchema, { onExcessProperty: 'error' })
    const required = { requestKey: 'request', command: 'printf hello', sessionId: 'repo-session' }
    expect(decode(required)).toEqual(required)
    expect(() => decode({ ...required, timeoutSeconds: null })).toThrow()
    expect(() => decode({ ...required, unexpected: 'argument' })).toThrow()
  })

  it('models an empty argument object and rejects unmodeled arguments', () => {
    expect(effectSchemaToJsonSchema(EmptyInputSchema)).toEqual({ type: 'object', additionalProperties: false })
    const decode = Schema.decodeUnknownSync(EmptyInputSchema)
    expect(decode({})).toEqual({})
    for (const invalid of [{ unexpected: true }, [], null, 'input', 1]) {
      expect(() => decode(invalid)).toThrow()
    }
  })

  it('keeps named recursive definitions with resolvable local references', () => {
    type Tree = { readonly name: string; readonly children: readonly Tree[] }
    const TreeSchema = Schema.Struct({
      name: Schema.String,
      children: Schema.Array(Schema.suspend((): Schema.Codec<Tree> => TreeSchema)),
    }).annotate({ identifier: 'Tree' })
    expect(effectSchemaToJsonSchema(TreeSchema)).toEqual({
      $ref: '#/$defs/Tree',
      $defs: {
        Tree: {
          type: 'object',
          properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/$defs/Tree' } } },
          required: ['name', 'children'],
          additionalProperties: false,
        },
      },
    })
  })

  it('keeps decoding defaults optional and preserves documented defaults', () => {
    const schema = Schema.Struct({
      name: Schema.String.annotate({ default: 'anonymous' }).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed('anonymous')),
      ),
    })
    expect(effectSchemaToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: { name: { type: 'string', default: 'anonymous' } },
      additionalProperties: false,
    })
    expect(Schema.decodeUnknownSync(schema)({})).toEqual({ name: 'anonymous' })
  })
})
