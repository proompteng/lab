import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const isMainModule = (meta: ImportMeta): boolean => {
  if (typeof meta.main === 'boolean') {
    return meta.main
  }

  try {
    const entry = process.argv[1]
    if (!entry) {
      return false
    }
    return entry === fileURLToPath(meta.url)
  } catch {
    return false
  }
}

export const runCli = async <T = void>(meta: ImportMeta, fn: () => Promise<T>): Promise<void> => {
  if (!isMainModule(meta)) {
    return
  }

  try {
    const result = await fn()
    if (typeof result === 'number') {
      const code = Number(result)
      // eslint-disable-next-line unicorn/no-process-exit
      process.exit(Number.isNaN(code) ? 0 : code)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1)
  }
}
