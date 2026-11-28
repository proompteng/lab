#!/usr/bin/env bun

import { link, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { fatal, repoRoot } from '../shared/cli'
import { prepareKnowledgeDelta } from './emit-knowledge-delta-core'
import { maxOntologyJsonBytes } from './ontology-json'

const usage = `Usage: emit-knowledge-delta --input <draft.json> --output <knowledge-delta.json>
       emit-knowledge-delta --check --input <knowledge-delta.json>`

const readInput = async (path: string) => {
  try {
    const file = await lstat(path)
    if (!file.isFile() || file.size > maxOntologyJsonBytes) throw new Error()
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(path))
  } catch {
    throw new Error('Expected a readable regular UTF-8 JSON file up to 1 MiB at --input')
  }
}

const readHeadCommit = async () => {
  try {
    const git = Bun.spawn(['git', 'rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const [code, stdout] = await Promise.all([git.exited, new Response(git.stdout).text()])
    if (code === 0) return stdout.trim()
  } catch {
    // Git and filesystem errors may echo input paths or environment values.
  }
  throw new Error('Could not resolve HEAD in the checkout containing the emitter')
}

const writeProposal = async (path: string, contents: string) => {
  const destination = resolve(path)
  const directory = await mkdtemp(join(dirname(destination), '.knowledge-delta-'))
  try {
    const temporary = join(directory, 'proposal.json')
    await writeFile(temporary, contents, { mode: 0o600 })
    // Publish the complete file atomically, without replacing any existing path.
    await link(temporary, destination)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const parseOptions = () => {
  try {
    return parseArgs({
      options: {
        input: { type: 'string' },
        output: { type: 'string' },
        check: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values
  } catch {
    throw new Error(usage)
  }
}

const main = async () => {
  const { input, output, check, help } = parseOptions()
  if (help) {
    console.log(usage)
    return
  }
  if (!input || (check ? output !== undefined : !output)) throw new Error(usage)

  const headCommit = await readHeadCommit()
  const canonical = await prepareKnowledgeDelta(await readInput(input), { headCommit, check })
  if (output) {
    await writeProposal(output, canonical).catch(() => {
      throw new Error('Could not publish the proposal; --output must be a new path in an existing writable directory')
    })
    console.log('Wrote validated knowledge delta.')
  } else {
    console.log('Validated canonical knowledge delta.')
  }
}

if (import.meta.main) await main().catch((error) => fatal('Knowledge delta preflight failed.', error))
