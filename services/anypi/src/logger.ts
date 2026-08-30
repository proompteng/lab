import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export type Logger = {
  info: (message: string) => Promise<void>
  error: (message: string) => Promise<void>
}

const timestampUtc = () => new Date().toISOString()

export const createLogger = async (logPath: string): Promise<Logger> => {
  await mkdir(dirname(logPath), { recursive: true })
  const write = async (level: 'info' | 'error', message: string) => {
    const line = `${timestampUtc()} ${level.toUpperCase()} ${message}\n`
    if (level === 'error') {
      process.stderr.write(line)
    } else {
      process.stdout.write(line)
    }
    await appendFile(logPath, line, 'utf8')
  }
  return {
    info: (message) => write('info', message),
    error: (message) => write('error', message),
  }
}
