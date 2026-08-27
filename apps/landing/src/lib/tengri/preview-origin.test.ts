import { describe, expect, test } from 'bun:test'

import { normalizePreviewGatewayOrigin } from './preview-origin'

describe('Tengri preview gateway configuration', () => {
  test('accepts arbitrary HTTPS origins and exact localhost development origins', () => {
    expect(normalizePreviewGatewayOrigin('https://isolated-tengri.example')).toBe('https://isolated-tengri.example')
    expect(normalizePreviewGatewayOrigin(' http://localhost:8080 ')).toBe('http://localhost:8080')
  })

  test('rejects non-local plaintext, credentials, paths, query strings, and fragments', () => {
    for (const value of [
      'http://isolated-tengri.example',
      'http://127.0.0.1:8080',
      'https://user:secret@tengri.example',
      'https://tengri.example/path',
      'https://tengri.example/?mode=dev',
      'https://tengri.example/#token',
      'javascript:alert(1)',
      `https://${'x'.repeat(2_048)}.example`,
    ]) {
      expect(normalizePreviewGatewayOrigin(value)).toBe('')
    }
  })
})
