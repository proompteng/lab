import { expect, test } from 'bun:test'
import { generatedImageContent } from './generated-image-content'
import { parseCodexGeneratedImagePath, MAX_CODEX_IMAGE_BYTES } from './codex-images'

const path = '/home/nanoagent/.codex/generated_images/thread-cat/exec-cat.png'
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
function history(result = png, savedPath = path, status = 'completed') {
  return JSON.stringify({ thread: { turns: [{ items: [{ type: 'imageGeneration', status, savedPath, result }] }] } })
}

test('reads only the exact generated image recorded in native history', () => {
  const image = generatedImageContent(history(), path)
  expect(image?.mediaType).toBe('image/png')
  expect(image?.content).toEqual(Buffer.from(png, 'base64'))
  expect(generatedImageContent(history(), path.replace('exec-cat', 'other'))).toBeNull()
  expect(generatedImageContent(history(png, path, 'in_progress'), path)).toBeNull()
})

test('rejects malformed, oversized, and non-image generation results', () => {
  for (const result of [
    '[Image output]',
    'not an image',
    png + '!',
    Buffer.from('<svg/>').toString('base64'),
    Buffer.alloc(MAX_CODEX_IMAGE_BYTES + 1).toString('base64'),
  ]) {
    expect(() => generatedImageContent(history(result), path)).toThrow('Invalid generated image data')
  }
})

test('generated image references cannot name arbitrary home files or escape their thread directory', () => {
  expect(parseCodexGeneratedImagePath(path)).toEqual({ threadId: 'thread-cat', path })
  for (const invalid of [
    path.replace('exec-cat', '..%2Fauth'),
    path + '?x=1',
    path.replace('png', 'svg'),
    '/home/nanoagent/.codex/auth.json',
    path.replace('thread-cat', '.'),
    'https://example.com' + path,
  ]) {
    expect(parseCodexGeneratedImagePath(invalid)).toBeNull()
  }
})
