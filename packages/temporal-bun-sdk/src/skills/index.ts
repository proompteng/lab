import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = '@proompteng/temporal-bun-sdk'

type BundledSkillsManifest = {
  skills: BundledSkillDefinition[]
}

type BundledSkillDefinition = {
  name: string
  description: string
  path: string
  entry: string
}

export type BundledSkill = {
  name: string
  description: string
  sourceDir: string
  entryFile: string
  entryPath: string
}

export type InstallBundledSkillOptions = {
  skillName: string
  destinationDir: string
  force?: boolean
}

export type InstallBundledSkillResult = {
  skill: BundledSkill
  installedPath: string
  overwritten: boolean
}

export function resolveBundledSkillsDirectory(): string {
  const packageRoot = resolvePackageRoot()
  const skillsDirectory = join(packageRoot, 'skills')
  const manifestPath = join(skillsDirectory, 'manifest.json')

  if (!existsSync(manifestPath)) {
    throw new Error(`Bundled skills manifest not found at ${manifestPath}`)
  }

  return skillsDirectory
}

export async function listBundledSkills(): Promise<BundledSkill[]> {
  const { skillsDirectory, manifest } = await loadBundledSkillsManifest()
  return manifest.skills.map((skill) => {
    const sourceDir = join(skillsDirectory, skill.path)
    return {
      name: skill.name,
      description: skill.description,
      sourceDir,
      entryFile: skill.entry,
      entryPath: join(sourceDir, skill.entry),
    }
  })
}

export async function getBundledSkill(skillName: string): Promise<BundledSkill> {
  const normalizedName = normalizeSkillName(skillName)
  const skills = await listBundledSkills()
  const skill = skills.find((entry) => entry.name === normalizedName)
  if (!skill) {
    const available = skills.map((entry) => entry.name).join(', ')
    throw new Error(`Unknown bundled skill "${skillName}". Available: ${available}`)
  }
  return skill
}

export async function installBundledSkill(options: InstallBundledSkillOptions): Promise<InstallBundledSkillResult> {
  const destinationDir = resolve(options.destinationDir)
  const skill = await getBundledSkill(options.skillName)
  const targetDir = join(destinationDir, skill.name)
  const force = options.force ?? false

  await mkdir(destinationDir, { recursive: true })

  const targetExists = existsSync(targetDir)
  if (targetExists && !force) {
    throw new Error(`Skill destination already exists: ${targetDir} (use --force to overwrite)`)
  }

  if (targetExists && force) {
    await rm(targetDir, { recursive: true, force: true })
  }

  await cp(skill.sourceDir, targetDir, { recursive: true })

  return {
    skill,
    installedPath: targetDir,
    overwritten: targetExists,
  }
}

async function loadBundledSkillsManifest(): Promise<{ skillsDirectory: string; manifest: BundledSkillsManifest }> {
  const skillsDirectory = resolveBundledSkillsDirectory()
  const manifestPath = join(skillsDirectory, 'manifest.json')
  const manifestRaw = await readFile(manifestPath, 'utf8')
  const manifest = parseManifest(manifestRaw, manifestPath)
  return { skillsDirectory, manifest }
}

function parseManifest(contents: string, manifestPath: string): BundledSkillsManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch (error) {
    throw new Error(
      `Failed to parse bundled skills manifest at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!parsed || typeof parsed !== 'object' || !('skills' in parsed) || !Array.isArray(parsed.skills)) {
    throw new Error(`Invalid bundled skills manifest at ${manifestPath}: expected { skills: [] }`)
  }

  const normalizedSkills: BundledSkillDefinition[] = []
  for (const entry of parsed.skills) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Invalid bundled skill entry in ${manifestPath}: expected object`)
    }

    const name = getStringField(entry, 'name', manifestPath)
    const description = getStringField(entry, 'description', manifestPath)
    const path = getStringField(entry, 'path', manifestPath)
    const entryFile = getStringField(entry, 'entry', manifestPath)

    normalizedSkills.push({
      name: normalizeSkillName(name),
      description,
      path,
      entry: entryFile,
    })
  }

  return { skills: normalizedSkills }
}

function getStringField(value: object, field: string, manifestPath: string): string {
  const record = value as Record<string, unknown>
  const raw = record[field]
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(`Invalid bundled skills manifest at ${manifestPath}: field "${field}" must be a non-empty string`)
  }
  return raw.trim()
}

function normalizeSkillName(skillName: string): string {
  return skillName.trim().toLowerCase()
}

function resolvePackageRoot(): string {
  let currentDirectory = dirname(fileURLToPath(import.meta.url))

  while (true) {
    const packageJsonPath = join(currentDirectory, 'package.json')
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: string }
        if (packageJson.name === PACKAGE_NAME) {
          return currentDirectory
        }
      } catch {
        // ignore malformed package.json entries while walking upward
      }
    }

    const parentDirectory = dirname(currentDirectory)
    if (parentDirectory === currentDirectory) {
      break
    }

    currentDirectory = parentDirectory
  }

  throw new Error(`Unable to resolve package root for ${PACKAGE_NAME} from ${import.meta.url}`)
}
