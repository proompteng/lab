import { describe, expect, test } from 'bun:test'

import { normalizePreviewGatewayOrigin } from './preview-origin'

describe('Tengri preview gateway origin', () => {
  test('accepts isolated HTTPS gateways and localhost development', () => {
    expect(normalizePreviewGatewayOrigin('https://isolated-tengri.example')).toBe('https://isolated-tengri.example')
    expect(normalizePreviewGatewayOrigin(' http://localhost:8080 ')).toBe('http://localhost:8080')
  })

  test('rejects untrusted or ambiguous origins', () => {
    for (const value of [
      '',
      'http://isolated-tengri.example',
      'http://127.0.0.1:8080',
      'https://user:secret@isolated-tengri.example',
      'https://isolated-tengri.example/path',
      'https://isolated-tengri.example?query=1',
      'javascript:alert(1)',
    ]) {
      expect(normalizePreviewGatewayOrigin(value)).toBe('')
    }
  })
})
