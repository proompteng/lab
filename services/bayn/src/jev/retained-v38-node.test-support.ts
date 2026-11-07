import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { Result } from 'effect'

import { canonicalJsonV1Result, sha256 } from '../hash'
import {
  decodeExecutionDecisionDocument,
  decodeRetainedJevExecutionDecisionDocument,
} from '../shadow-decision-contract'
import { verifyPerformanceDecisions } from '../forward-performance/postgres/projection'

assert.equal(process.versions['bun'], undefined, 'Production evidence must be replayed by Node')
const runtime = {
  executable: process.execPath,
  node: process.versions['node'],
  arch: process.arch,
  platform: process.platform,
  zlib: process.versions['zlib'],
  sharedZlib: process.config.variables['node_shared_zlib'],
}
const goldens = [
  {
    bytes: 1_523_926,
    canonicalHash: '313ee50a8740412c5fa69ccf4753dd5e53be99a6e578dc968857859a5ff4500e',
    contentHash: '3a8eb0e67f156757cbe0957a06c5bbf645115961ab162b3175aff87b381368a4',
  },
  {
    bytes: 34_714,
    canonicalHash: 'f89e444fd3fe538346344f9c2f8e21dab6b995a9e901beb8374742300c7fbfad',
    contentHash: 'f3e8e3832c9cd0aa543ef2016392add87ced473fac597d468dd49d536adfd5f2',
  },
  {
    bytes: 1_522_195,
    canonicalHash: 'ce05d8ed4a7396abe7adf18f695401b8313004e34f7275dbfc396c17113b1fb7',
    contentHash: 'dfbff59c8d94d1a272eb40efd093206973fd9770a3892cacfc7b5d4a47bf5996',
  },
  {
    bytes: 1_061_094,
    canonicalHash: '1267f6cd0b904a80cfc34febd15df027a64033d6f3003540259d5888f94464db',
    contentHash: 'b35781ba2b97a56ff799f6e9de748d140d2759d39c342138f650c832ef5f0938',
  },
  {
    bytes: 34_714,
    canonicalHash: '6b484aea69fda9cb2576e93ef149c7c2f6db7f6ac01fe0928d648e3e1923f9bd',
    contentHash: 'f0a3fa911898387768091caa4db69f9bf7b9187863e5594abd7bf2b5f83bc091',
  },
  {
    bytes: 34_714,
    canonicalHash: '1f295ab9a50da75e4d0d87913a2f78e5181717ff6125d4548e181e54572d8941',
    contentHash: '005815abb3c0ecb46f84def21cbb9d7517f8af9c193ef828227e1b02fd57e4c3',
  },
  {
    bytes: 245_187,
    canonicalHash: '79a832650d6e5deebbe4d1b1acbceee7a48d3661e33c63024460aa037e7f5e2d',
    contentHash: '39b9bb4151b38b273843d41bf32ba134e6c88b7208b6b111f26016287d7645a4',
  },
]
const paths = process.argv.slice(2)
assert.equal(paths.length, goldens.length)
for (const [index, path] of paths.entries()) {
  const golden = goldens[index]!
  const bytes = gunzipSync(readFileSync(path))
  assert.equal(bytes.byteLength, golden.bytes)
  assert.equal(sha256(bytes), golden.canonicalHash)
  const decoded = decodeRetainedJevExecutionDecisionDocument(JSON.parse(bytes.toString('utf8')))
  if (Result.isFailure(decoded)) throw new Error(`${JSON.stringify(runtime)}: ${decoded.failure.message}`)
  const document = decoded.success
  assert.equal(document.contentHash, golden.contentHash)
  assert.equal(Result.getOrThrow(canonicalJsonV1Result(document)), bytes.toString('utf8'))
  assert.equal(Result.isFailure(decodeExecutionDecisionDocument(document)), true)
  const projection = verifyPerformanceDecisions([
    {
      cycle_id: document.bindings.cycleId,
      decision_hash: document.contentHash,
      created_at: new Date(document.createdAt),
      document,
    },
  ])
  assert.equal(projection.verifiedRows.length, 1)
  assert.deepEqual(projection.unverifiedDecisionHashes, [])
  assert.equal(
    Result.isFailure(decodeRetainedJevExecutionDecisionDocument({ ...document, contentHash: 'f'.repeat(64) })),
    true,
  )
}
process.stdout.write(JSON.stringify({ status: 'VERIFIED', caseCount: goldens.length, runtime }))
