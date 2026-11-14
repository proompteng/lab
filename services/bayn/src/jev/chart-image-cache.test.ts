import { expect, test } from 'bun:test'
import { ChartImageCache } from './chart-image-cache'

test('chart cache evicts complete oldest images at either independent memory bound', () => {
  const value = { pngHash: 'hash', image: 'image' }
  const byCount = new ChartImageCache(2, 1000)
  for (const key of ['a', 'b', 'c']) byCount.set(key, value)
  expect(byCount.get('a')).toBeUndefined()
  expect(byCount.get('b')).toEqual(value)
  expect(byCount.get('c')).toEqual(value)
  const byBytes = new ChartImageCache(10, 40)
  for (const key of ['a', 'b', 'c']) byBytes.set(key, value)
  expect(byBytes.get('a')).toBeUndefined()
  expect(byBytes.get('b')).toEqual(value)
  expect(byBytes.get('c')).toEqual(value)
})

test('replacement removes its old charge, oversized images are not retained and callers cannot mutate retained bytes', () => {
  const cache = new ChartImageCache(2, 40)
  const value = { pngHash: 'hash', image: 'image' }
  cache.set('a', value)
  Reflect.set(value, 'image', 'changed')
  expect(cache.get('a')?.image).toBe('image')
  expect(Reflect.set(cache.get('a') ?? {}, 'image', 'poisoned')).toBe(false)
  cache.set('a', { pngHash: 'hash', image: 'image' })
  cache.set('b', { pngHash: 'hash', image: 'image' })
  expect(cache.get('a')).toBeDefined()
  expect(cache.get('b')).toBeDefined()
  cache.set('a', { pngHash: 'hash', image: 'x'.repeat(100) })
  expect(cache.get('a')).toBeUndefined()
  expect(cache.get('b')).toBeDefined()
})
