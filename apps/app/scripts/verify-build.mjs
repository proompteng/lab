import { access } from 'node:fs/promises'

const entry = new URL('../.output/server/_ssr/ssr.mjs', import.meta.url)

await access(entry)

const server = await import(entry)

if (typeof server.default?.fetch !== 'function') {
  throw new Error('Built SSR entry does not export a fetch handler')
}

console.log('Built SSR entry import smoke passed')
