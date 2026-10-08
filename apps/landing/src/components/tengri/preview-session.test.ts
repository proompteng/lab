import { describe, expect, test } from 'bun:test'
import { safePreviewLaunchUrl, safePreviewSessionOrigin } from './preview-session'

describe('owner-scoped preview URLs', () => {
  const id = 'a'.repeat(24)
  const ticket = `${'a'.repeat(32)}.${'b'.repeat(32)}`
  test('accepts only the configured gateway and a one-use fragment ticket', () => {
    const url = `https://tengri.proompteng.ai/v1/preview/open#${ticket}`
    expect(safePreviewLaunchUrl(url, 'https://tengri.proompteng.ai')).toBe(url)
    for (const invalid of [
      url.replace('tengri.proompteng.ai', 'evil.example'),
      url.replace('#', '?ticket='),
      'javascript:alert(1)',
    ]) {
      expect(safePreviewLaunchUrl(invalid, 'https://tengri.proompteng.ai')).toBe('')
    }
  })
  test('rejects another preview identity, credentials, and paths', () => {
    const origin = `https://tengri-${id}.proompteng.ai`
    expect(safePreviewSessionOrigin(origin, id)).toBe(origin)
    for (const invalid of [
      origin.replace(id, 'b'.repeat(24)),
      origin + '/path',
      origin + '?token=secret',
      origin.replace('https://', 'https://user@'),
    ]) {
      expect(safePreviewSessionOrigin(invalid, id)).toBe('')
    }
  })
})
