import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

let loaded = false

const stripQuotes = (value: string) => value.replace(/^['"]|['"]$/g, '')

const parseLine = (line: string) => {
  if (!line || line.startsWith('#')) return null
  const eqIndex = line.indexOf('=')
  if (eqIndex === -1) return null
  const key = line.slice(0, eqIndex).trim()
  const raw = line.slice(eqIndex + 1).trim()
  if (!key) return null
  return { key, value: stripQuotes(raw) }
}

const loadFile = (filepath: string) => {
  if (!existsSync(filepath)) return
  const content = readFileSync(filepath, 'utf8')
  for (const line of content.split('\n')) {
    const parsed = parseLine(line)
    if (!parsed) continue
    if (process.env[parsed.key] === undefined) {
      process.env[parsed.key] = parsed.value
    }
  }
}

export const loadEnv = () => {
  if (loaded) return
  const serviceRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
  // Load .env.local first so it can override .env for local dev
  loadFile(resolve(serviceRoot, '.env.local'))
  loadFile(resolve(serviceRoot, '.env'))
  loaded = true
}
