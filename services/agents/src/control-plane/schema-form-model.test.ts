import { describe, expect, it } from 'vitest'

import { buildSchemaFieldModels } from './schema-form-model'

describe('schema form model', () => {
  it('models required scalar, nested object, array, enum, and schemaless fields', () => {
    const fields = buildSchemaFieldModels(
      {
        type: 'object',
        required: ['name', 'runtime'],
        properties: {
          mode: { type: 'string', enum: ['auto', 'manual'] },
          name: { type: 'string' },
          runtime: {
            type: 'object',
            required: ['type'],
            properties: {
              config: {
                type: 'object',
                'x-kubernetes-preserve-unknown-fields': true,
              },
              type: { type: 'string' },
            },
          },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
      ['spec'],
      new Set(['name', 'runtime']),
    )

    expect(fields.map((field) => field.name)).toEqual(['name', 'runtime', 'mode', 'tags'])
    expect(fields[0]).toMatchObject({ kind: 'string', required: true, path: ['spec', 'name'] })
    expect(fields[1]).toMatchObject({ kind: 'object', required: true, path: ['spec', 'runtime'] })
    expect(fields[1]?.children?.find((field) => field.name === 'config')).toMatchObject({ kind: 'schemaless' })
    expect(fields.find((field) => field.name === 'mode')).toMatchObject({ kind: 'enum' })
    expect(fields.find((field) => field.name === 'tags')).toMatchObject({ kind: 'array' })
  })
})
