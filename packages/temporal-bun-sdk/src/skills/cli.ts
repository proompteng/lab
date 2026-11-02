import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getBundledSkill, installBundledSkill, listBundledSkills } from './index'

const DEFAULT_SKILL_INSTALL_DIR = join(homedir(), '.codex', 'skills')

export type SkillCliResult = {
  exitCode?: number
}

export type SkillCliIo = {
  log: (message: string) => void
  error: (message: string) => void
}

export async function runSkillCli(
  args: string[],
  flags: Record<string, string | boolean>,
  io: SkillCliIo = { log: console.log, error: console.error },
): Promise<SkillCliResult | undefined> {
  const [subcommand = 'help', ...rest] = args

  if (subcommand === 'help') {
    printSkillHelp(io.log)
    return undefined
  }

  if (subcommand === 'list') {
    const skills = await listBundledSkills()
    if (skills.length === 0) {
      io.log('No bundled skills found.')
      return undefined
    }

    for (const skill of skills) {
      io.log(`${skill.name}\t${skill.description}`)
    }
    return undefined
  }

  if (subcommand === 'path') {
    const skillName = rest[0] ?? normalizeStringFlag(flags.skill) ?? 'temporal'
    const skill = await getBundledSkill(skillName)
    io.log(skill.sourceDir)
    return undefined
  }

  if (subcommand === 'install') {
    const skillName = rest[0] ?? normalizeStringFlag(flags.skill) ?? 'temporal'
    const installRoot = resolve(normalizeStringFlag(flags.to) ?? DEFAULT_SKILL_INSTALL_DIR)
    const force = Boolean(flags.force)

    const result = await installBundledSkill({
      skillName,
      destinationDir: installRoot,
      force,
    })

    const overwriteLabel = result.overwritten ? ' (overwritten)' : ''
    io.log(`Installed ${result.skill.name} to ${result.installedPath}${overwriteLabel}`)
    return undefined
  }

  io.error(`Unknown skill subcommand "${subcommand}".`)
  printSkillHelp(io.log)
  return { exitCode: 1 }
}

export function printSkillHelp(print: (message: string) => void = console.log) {
  print(`temporal-bun skill <command> [options]\n
Commands:
  list                    List bundled skills
  install [name]          Install a bundled skill (default: temporal)
  path [name]             Print bundled skill source path
  help                    Show this help message

Options:
  --to <path>             Install root directory (default: ~/.codex/skills)
  --skill <name>          Skill name (alternative to positional arg)
  --force                 Overwrite existing installed skill directory
`)
}

function normalizeStringFlag(value: string | boolean | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
