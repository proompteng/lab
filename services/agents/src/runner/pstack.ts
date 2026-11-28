import { type Dirent, mkdirSync, readdirSync, statSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const PSTACK_SKILLS_PATH = '/opt/agents-shell/pstack/skills'

export const installPstackSkills = ({
  codexHome,
  enabled,
  bundleSkillsPath = PSTACK_SKILLS_PATH,
}: {
  codexHome: string
  enabled?: string
  bundleSkillsPath?: string
}): void => {
  const mode = enabled?.trim().toLowerCase()
  if (mode === 'false') return
  if (mode !== undefined && mode !== 'true') {
    throw new Error('AGENTS_RUNNER_PSTACK_ENABLED must be true or false')
  }

  const source = resolve(bundleSkillsPath)
  let entries: Dirent[]
  try {
    entries = readdirSync(source, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (mode === 'true') {
      throw new Error(`AGENTS_RUNNER_PSTACK_ENABLED=true requires pstack skills at ${source}`, { cause: error })
    }
    return
  }

  const skills = entries.filter(
    (entry) =>
      entry.isDirectory() && statSync(join(source, entry.name, 'SKILL.md'), { throwIfNoEntry: false })?.isFile(),
  )
  if (skills.length === 0) throw new Error(`pstack bundle at ${source} contains no skills with SKILL.md`)

  const destination = join(codexHome, 'skills')
  mkdirSync(destination, { recursive: true })
  for (const { name } of skills) {
    try {
      symlinkSync(join(source, name), join(destination, name), 'dir')
    } catch (error) {
      // The image path is stable across releases. Leave any existing entry, even a dangling link, alone.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}
