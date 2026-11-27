import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { S3Client } from 'bun'

import { objectKey, readTape, sha256, tapeHash, universes } from './daily-alpha-data'
import { type Development, develop, encodeLedger, makeLedger, scoreHoldout } from './daily-alpha-study'

const root = resolve(import.meta.dir, '../../..')
const evidence = 'docs/bayn/evidence/2026-11-27-5yr-daily-overnight-alpha'
const fingerprinted = [
  'daily-alpha-data.ts',
  'daily-alpha-metrics.ts',
  'daily-alpha-replay.ts',
  'daily-alpha-signals.ts',
  'daily-alpha-study.ts',
  'midday-research-statistics.ts',
  'research-5yr-daily-overnight-alpha.ts',
]
const protocolHash = () => sha256(readFileSync(join(root, evidence, 'protocol.md')))

function receipt(development: Development, ledger: string) {
  return `${JSON.stringify(
    {
      type: 'bayn.daily-overnight-freeze.v1',
      objectKey,
      tapeSha256: tapeHash,
      protocolSha256: protocolHash(),
      engineSha256: sha256(
        JSON.stringify([
          universes,
          ...fingerprinted.map((name) => [name, sha256(readFileSync(join(import.meta.dir, name)))]),
        ]),
      ),
      developmentLedgerSha256: sha256(ledger),
      ...development.selection,
    },
    null,
    2,
  )}\n`
}

function git(args: string[]) {
  const completed = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  if (completed.exitCode !== 0)
    throw new Error(`Git could not verify the committed freeze: ${completed.stderr.toString().trim()}`)
  return completed.stdout.toString()
}

function committedFreeze(requestedCommit: string | undefined) {
  const path = `${evidence}/freeze.json`
  const commits =
    requestedCommit === undefined
      ? git(['log', '--format=%H', '--diff-filter=A', '--', path]).trim().split('\n')
      : [requestedCommit]
  const [commit] = commits
  if (commits.length !== 1 || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('Commit exactly one development-only freeze.json and results.json before opening Holdout')
  }
  const frozen = git(['show', `${commit}:${path}`])
  if (frozen !== readFileSync(join(root, path), 'utf8'))
    throw new Error('Working freeze.json differs from the committed freeze')
  const ledgerPath = `${evidence}/results.json`
  const ledger = git(['show', `${commit}:${ledgerPath}`])
  const current = git(['show', `HEAD:${ledgerPath}`])
  if (current === ledger) return { commit, frozen, ledger }

  const recorded: unknown = JSON.parse(current)
  if (
    typeof recorded !== 'object' ||
    recorded === null ||
    !('stage' in recorded) ||
    recorded.stage !== 'scored' ||
    !('freezeCommit' in recorded) ||
    recorded.freezeCommit !== commit
  )
    throw new Error('Committed results.json is neither the frozen development ledger nor its scored result')
  return { commit, frozen, ledger, scoredLedger: current }
}

interface DevelopmentBytes {
  frozen: string
  ledger: string
}

const withoutEngineHash = (receipt: string) => receipt.replace(/^  "engineSha256": "[a-f0-9]{64}",\n/m, '')

export function verifyReproducedFreeze(
  committed: DevelopmentBytes & { scoredLedger?: string },
  reproduced: DevelopmentBytes,
) {
  // Never open a new holdout with a different engine. Once a result exists in Git, allow only
  // a read-only audit: every development byte and every previously scored byte must still agree.
  const sameReceipt =
    committed.frozen === reproduced.frozen ||
    (committed.scoredLedger !== undefined &&
      withoutEngineHash(committed.frozen) === withoutEngineHash(reproduced.frozen))
  if (!sameReceipt || committed.ledger !== reproduced.ledger) {
    throw new Error('Development replay changed since freeze; refusing to open Holdout')
  }
}

export function verifyReproducedScore(committed: string, reproduced: string) {
  if (committed !== reproduced)
    throw new Error('Holdout replay differs from the committed result; no artifacts written')
}

async function loadTape(path: string | undefined) {
  if (path !== undefined) return Bun.file(path).bytes()
  const accessKeyId = process.env['AWS_ACCESS_KEY_ID']
  const secretAccessKey = process.env['AWS_SECRET_ACCESS_KEY']
  if (accessKeyId === undefined || accessKeyId === '' || secretAccessKey === undefined || secretAccessKey === '')
    throw new Error('Mount the agents-artifacts secret or supply the pinned gzip with --input')
  const s3 = new S3Client({
    endpoint: process.env['AGENTS_ARTIFACTS_ENDPOINT'] || 'http://rook-ceph-rgw-objectstore.rook-ceph.svc:80',
    bucket: process.env['AGENTS_ARTIFACTS_BUCKET'] || 'agents-artifacts',
    accessKeyId,
    secretAccessKey,
    region: 'us-east-1',
  })
  return new Uint8Array(await s3.file(objectKey).arrayBuffer())
}

async function main() {
  const {
    values: { freeze, score, input, 'freeze-commit': freezeCommit },
  } = parseArgs({
    options: {
      freeze: { type: 'boolean' },
      score: { type: 'boolean' },
      input: { type: 'string' },
      'freeze-commit': { type: 'string' },
    },
  })
  if (Boolean(freeze) === Boolean(score) || (freeze === true && freezeCommit !== undefined)) {
    throw new Error(
      'Usage: bun services/bayn/tools/research-5yr-daily-overnight-alpha.ts (--freeze | --score) [--input pinned.tsv.gz] [--freeze-commit SHA]',
    )
  }
  const frozenPath = join(root, evidence, 'freeze.json')
  if (freeze === true && (await Bun.file(frozenPath).exists()))
    throw new Error('Refusing to overwrite an existing freeze receipt')
  const committed = score === true ? committedFreeze(freezeCommit) : undefined
  const bytes = await loadTape(input)
  const developmentTape = readTape(bytes, 'freeze')
  const development = develop(developmentTape)
  const ledger = encodeLedger(makeLedger(developmentTape, development))
  const frozen = receipt(development, ledger)
  const ledgerPath = join(root, evidence, 'results.json')
  if (committed === undefined) {
    writeFileSync(ledgerPath, ledger, { flag: 'wx' })
    writeFileSync(frozenPath, frozen, { flag: 'wx' })
    console.log(
      `Froze ${development.selection.finalists.length} development finalists from ${development.selection.trialCount} registered trials`,
    )
    return
  }
  verifyReproducedFreeze(committed, { frozen, ledger })
  const tape = readTape(bytes, 'score')
  const scored = makeLedger(tape, development, scoreHoldout(tape, development))
  const scoredLedger = encodeLedger({ ...scored, freezeCommit: committed.commit })
  if (committed.scoredLedger === undefined) writeFileSync(ledgerPath, scoredLedger)
  else verifyReproducedScore(committed.scoredLedger, scoredLedger)
  console.log(
    `${committed.scoredLedger === undefined ? 'Scored' : 'Reproduced'} ${development.selection.holdoutIds.length} frozen evaluations; ${scored.accepted.length} passed every gate`,
  )
}

if (import.meta.main) await main()
