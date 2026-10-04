import { readdir, readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

const MAX_FILE_LINES = 1000

const LEGACY_OVERSIZED_LINE_CAPS: Record<string, number> = {
  'src/server/control-plane-status-types.ts': 2980,
  'src/server/atlas-store.ts': 2219,
  'src/server/chat-completion-encoder.ts': 2076,
  'src/server/torghut-market-context-agents.ts': 2036,
  'src/server/torghut-simulation-control-plane.ts': 1741,
  'src/server/chat.ts': 1537,
  'src/server/github-review-store.ts': 1459,
  'src/server/torghut-whitepapers.ts': 1328,
  'src/server/terminals.ts': 1029,
  'src/routes/github/pulls/$owner/$repo/$number.tsx': 1028,
  'src/server/db.ts': 1017,
}

const ROOT = process.cwd()
const SCAN_DIRS = ['src/server', 'src/routes', 'src/components']

const shouldCheckFile = (path: string) => {
  if (!path.endsWith('.ts') && !path.endsWith('.tsx')) return false
  if (
    path.endsWith('.test.ts') ||
    path.endsWith('.test.tsx') ||
    path.endsWith('.spec.ts') ||
    path.endsWith('.spec.tsx')
  ) {
    return false
  }
  if (path.includes('/__tests__/')) return false
  if (path === 'src/routeTree.gen.ts') return false
  return true
}

const walk = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walk(absolutePath)))
      continue
    }
    if (!entry.isFile()) continue
    files.push(absolutePath)
  }

  return files
}

const countLines = async (path: string) => {
  const content = await readFile(path, 'utf8')
  return content.length === 0 ? 0 : content.split('\n').length
}

const main = async () => {
  const candidates = await Promise.all(SCAN_DIRS.map((directory) => walk(resolve(ROOT, directory))))
  const files = candidates
    .flat()
    .map((path) => relative(ROOT, path))
    .filter(shouldCheckFile)
    .sort()

  const failures: string[] = []

  for (const file of files) {
    const lineCount = await countLines(resolve(ROOT, file))
    const legacyCap = LEGACY_OVERSIZED_LINE_CAPS[file]

    if (legacyCap !== undefined) {
      if (lineCount > legacyCap) {
        failures.push(`${file} grew from ${legacyCap} lines to ${lineCount}; legacy oversized files must only shrink.`)
      }
      continue
    }

    if (lineCount > MAX_FILE_LINES) {
      failures.push(`${file} is ${lineCount} lines; modules must stay at or below ${MAX_FILE_LINES} lines.`)
    }
  }

  if (failures.length > 0) {
    console.error('Jangar module-size guardrail failed:')
    for (const failure of failures) {
      console.error(`- ${failure}`)
    }
    process.exit(1)
  }

  console.log(
    `Jangar module-size guardrail passed for ${files.length} files. Files under ${MAX_FILE_LINES} lines are within policy; legacy oversized files stayed within baseline caps.`,
  )
}

await main()
