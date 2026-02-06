import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export const ensureFileDirectory = async (filePath: string) => {
  await mkdir(dirname(filePath), { recursive: true })
}
