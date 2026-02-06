import { copyFile, stat } from 'node:fs/promises'
import { which } from 'bun'

export const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

export const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) {
    return fallback
  }
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes'].includes(normalized)) {
    return true
  }
  if (['0', 'false', 'no'].includes(normalized)) {
    return false
  }
  return fallback
}

export const randomRunId = (length = 6): string => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < length; i += 1) {
    const index = Math.floor(Math.random() * alphabet.length)
    result += alphabet[index]
  }
  return result
}

export const timestampUtc = (): string => {
  const iso = new Date().toISOString()
  return iso.replace(/\.\d+Z$/, 'Z')
}

export const copyAgentLogIfNeeded = async (outputPath: string, agentPath: string) => {
  try {
    const outputStats = await stat(outputPath)
    if (outputStats.size > 0) {
      return
    }
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  try {
    const agentStats = await stat(agentPath)
    if (agentStats.size === 0) {
      return
    }
    await copyFile(agentPath, outputPath)
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }
}

export const buildDiscordChannelCommand = async (scriptPath: string, args: string[]): Promise<string[]> => {
  const bunPath = await which('bun')
  if (!bunPath) {
    throw new Error('bun not available in PATH')
  }
  return [bunPath, 'run', scriptPath, ...args]
}
