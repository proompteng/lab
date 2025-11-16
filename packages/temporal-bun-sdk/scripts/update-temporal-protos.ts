#!/usr/bin/env bun

import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { $ } from 'bun'

type CliOptions = {
  version?: string
  repo: string
}

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..')
const TEMPORAL_PROTO_DIR = path.join(REPO_ROOT, 'proto', 'temporal')
const VERSION_FILE = path.join(TEMPORAL_PROTO_DIR, 'VERSION')

const main = async () => {
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      repo: { type: 'string', default: 'temporalio/api' },
      help: { type: 'boolean', default: false },
    },
  })

  if (values.help) {
    printHelp()
    return
  }

  await ensureBuf()

  const options: CliOptions = {
    version: values.version,
    repo: values.repo,
  }

  const tag = await resolveTag(options)
  console.log(`[temporal-bun-sdk] Updating Temporal protos to ${tag}`)

  await regenerateFromTag(tag, options.repo)
  await writeFile(VERSION_FILE, `${tag}\n`, 'utf8')

  await generateTypeScript()

  console.log('[temporal-bun-sdk] Temporal protos regenerated successfully.')
}

const printHelp = () => {
  console.log(`Update Temporal protobuf definitions and generated TypeScript stubs.

Usage:
  bun scripts/update-temporal-protos.ts [--version <tag>] [--repo <owner/name>]

Options:
  --version   Temporal API release tag (default: latest GitHub release)
  --repo      GitHub repo containing the proto sources (default: temporalio/api)
  --help      Show this help message
`)
}

const ensureBuf = async () => {
  if (!Bun.which('buf')) {
    throw new Error(
      'buf CLI not found in PATH. Install from https://buf.build/docs/installation before running this script.',
    )
  }
  await $`buf --version`
}

const resolveTag = async (options: CliOptions): Promise<string> => {
  if (!options.version || options.version === 'latest') {
    const latest = await fetchJson<{ tag_name: string }>(`https://api.github.com/repos/${options.repo}/releases/latest`)
    if (!latest.tag_name) {
      throw new Error('Failed to resolve latest release tag from GitHub API.')
    }
    return latest.tag_name
  }

  const normalized = options.version.startsWith('v') ? options.version : `v${options.version}`
  return normalized
}

const regenerateFromTag = async (tag: string, repo: string) => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'temporal-protos-'))
  const archivePath = path.join(tmp, `${tag}.tar.gz`)
  const extractDir = path.join(tmp, 'extract')
  await mkdir(extractDir, { recursive: true })

  try {
    const archiveUrl = `https://github.com/${repo}/archive/refs/tags/${tag}.tar.gz`
    console.log(`[temporal-bun-sdk] Downloading ${archiveUrl}`)
    const response = await fetchWithError(archiveUrl, 'application/octet-stream')
    await Bun.write(archivePath, response)

    await $`tar -xzf ${archivePath} -C ${extractDir}`

    const sourceDir = await findTemporalDir(extractDir)
    if (!sourceDir) {
      throw new Error('Extracted archive did not contain a temporal/ directory.')
    }

    await rm(TEMPORAL_PROTO_DIR, { recursive: true, force: true })
    await cp(sourceDir, TEMPORAL_PROTO_DIR, { recursive: true })
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

const findTemporalDir = async (extractDir: string) => {
  const entries = await readdir(extractDir)
  for (const entry of entries) {
    const candidate = path.join(extractDir, entry, 'temporal')
    try {
      const stats = await stat(candidate)
      if (stats.isDirectory()) {
        return candidate
      }
    } catch {}
  }
  return undefined
}

const fetchJson = async <T>(url: string): Promise<T> => {
  const response = await fetchWithError(url, 'application/vnd.github+json')
  return (await response.json()) as T
}

const fetchWithError = async (url: string, accept: string) => {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'temporal-bun-sdk-proto-updater',
      Accept: accept,
    },
  })
  if (!response.ok) {
    const message = await response.text()
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}\n${message}`)
  }
  return response
}

const generateTypeScript = async () => {
  console.log('[temporal-bun-sdk] Generating TypeScript stubs via buf...')
  await $`cd ${REPO_ROOT} && buf generate --template buf.temporal.gen.yaml --path proto/temporal`
}

await main()
