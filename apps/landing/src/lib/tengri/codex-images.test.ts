import { describe, expect, test } from 'bun:test'
import {
  codexMessageAttachments,
  codexOutputImagePaths,
  isWorkspaceImagePath,
  isCodexAttachmentPath,
} from './codex-images'

const path = '/workspace/.tengri-attachments/11111111-1111-4111-8111-111111111111.png'

describe('sent image references', () => {
  test('extracts retained attachments without treating arbitrary image markers as fetch targets', () => {
    expect(codexMessageAttachments(`Inspect this\n[Local image: ${path}]`)).toEqual({
      text: 'Inspect this',
      paths: [path],
    })
    for (const target of [
      'https://example.com/a.png',
      '/etc/private.png',
      '/workspace/.tengri-attachments/../private.png',
    ]) {
      expect(isCodexAttachmentPath(target)).toBe(false)
      const text = `[Local image: ${target}]`
      expect(codexMessageAttachments(text)).toEqual({ text, paths: [] })
    }
  })

  test('bounds the number of restored thumbnails', () => {
    const result = codexMessageAttachments(Array.from({ length: 5 }, () => `[Local image: ${path}]`).join('\n'))
    expect(result.paths).toHaveLength(4)
    expect(result.text).toContain('[Local image:')
  })
})

test('recognizes only workspace raster outputs for inline agent previews', () => {
  expect(codexOutputImagePaths('/workspace/chart.png')).toEqual(['/workspace/chart.png'])
  expect(codexOutputImagePaths('View image: /workspace/chart.png')).toEqual(['/workspace/chart.png'])
  expect(codexOutputImagePaths('![Chart](/workspace/chart.png)')).toEqual([])
  expect(codexOutputImagePaths('![Remote](https://example.com/chart.png)')).toEqual([])
  expect(isWorkspaceImagePath('/workspace/../private.png')).toBe(false)
  expect(isWorkspaceImagePath('/workspace/a.svg')).toBe(false)
})

test('does not turn Markdown examples inside command output into image reads', () => {
  expect(
    codexOutputImagePaths(`for (const failure of [
  const text = '![Recovered diagram](/workspace/recovered-diagram.png)'
]`),
  ).toEqual([])
  expect(
    codexOutputImagePaths(`cat README.md
![Example](/workspace/example.png)`),
  ).toEqual([])
})
