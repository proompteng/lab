import { expect, test } from 'bun:test'
import * as Schema from 'effect/Schema'

import { createDefaultDataConverter } from '../src/common/payloads'
import { createTypedSearchAttributes, defineSearchAttributes } from '../src/search-attributes'

const schema = defineSearchAttributes({
  CustomKeywordField: Schema.Array(Schema.String),
  CustomIntField: Schema.Number,
})

test('typed search attributes encode and decode', async () => {
  const dataConverter = createDefaultDataConverter()
  const typed = createTypedSearchAttributes(schema, dataConverter)

  const encoded = await typed.encode({
    CustomKeywordField: ['alpha', 'beta'],
    CustomIntField: 7,
  })
  expect(encoded).toBeDefined()

  const decoded = await typed.decode(encoded)
  expect(decoded).toEqual({
    CustomKeywordField: ['alpha', 'beta'],
    CustomIntField: 7,
  })
})
