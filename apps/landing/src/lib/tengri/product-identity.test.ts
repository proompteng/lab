import { describe, expect, test } from 'bun:test'

import {
  createProductManifest,
  PUBLIC_PRODUCT_IDENTITY,
  selectProductIdentity,
  TENGRI_PRODUCT_IDENTITY,
} from './product-identity'

describe('Tengri product identity', () => {
  test('keeps the public identity until the desktop is configured', () => {
    expect(selectProductIdentity(false)).toBe(PUBLIC_PRODUCT_IDENTITY)
    expect(createProductManifest(false)).toMatchObject({
      name: 'ProomptEng AI',
      short_name: 'ProomptEng',
      theme_color: '#0e0e10',
    })
  })

  test('uses the Tengri install identity only for an available desktop', () => {
    expect(selectProductIdentity(true)).toBe(TENGRI_PRODUCT_IDENTITY)
    expect(createProductManifest(true)).toMatchObject({
      name: 'Tengri MicroVM Desktop',
      short_name: 'Tengri',
      theme_color: '#050914',
    })
    expect(TENGRI_PRODUCT_IDENTITY.openGraphImage).not.toBe(PUBLIC_PRODUCT_IDENTITY.openGraphImage)
  })
})
