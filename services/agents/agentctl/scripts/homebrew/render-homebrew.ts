import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(scriptDir, '..', '..')

export type RenderHomebrewOptions = {
  version: string
  checksums: Map<string, string>
  outputPath?: string
  templatePath?: string
}

export const renderHomebrewFormula = async ({
  version,
  checksums,
  outputPath = resolve(root, 'dist', 'release', 'agentctl.rb'),
  templatePath = resolve(root, 'scripts', 'homebrew', 'agentctl.rb'),
}: RenderHomebrewOptions) => {
  const replacements = new Map<string, string>([
    ['__VERSION__', version],
    ['__SHA256_DARWIN_ARM64__', checksums.get('darwin-arm64') ?? ''],
    ['__SHA256_DARWIN_AMD64__', checksums.get('darwin-amd64') ?? ''],
    ['__SHA256_LINUX_ARM64__', checksums.get('linux-arm64') ?? ''],
    ['__SHA256_LINUX_AMD64__', checksums.get('linux-amd64') ?? ''],
  ])

  let template = await readFile(templatePath, 'utf8')

  for (const [token, value] of replacements) {
    if (!value) {
      throw new Error(`Missing checksum for ${token}`)
    }
    template = template.replaceAll(token, value)
  }

  if (template.includes('__VERSION__') || template.includes('__SHA256_')) {
    throw new Error('Homebrew formula template contains unreplaced tokens')
  }

  await writeFile(outputPath, template, 'utf8')
  console.log(`Wrote Homebrew formula to ${outputPath}`)
}
