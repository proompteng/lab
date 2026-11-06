import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { Result } from 'effect'

import { decodeRetainedJevV38ExecutionDecisionDocument } from '../shadow-decision-contract'

// Captured independently with the original strict decoder on 8f87974758c4490bbfc9549fc7c44ba5f02f871a.
// Never regenerate these identities from the successor implementation.
export const retainedV38ExecutionGoldens = [
  {
    name: 'entry-equity',
    file: 'entry-equity.json.gz',
    bytes: 1_523_926,
    contentHash: '28239567cc102e26338e384850d98eaa1e3555f1f4ce6bfee769277bd2c2b4e7',
    canonicalHash: '265d5a690d7729a38d456dbe684b5d95fb0f56b4fe66bf8eef6f55923e03aaf0',
  },
  {
    name: 'exit-protective-stop',
    file: 'exit-protective-stop-document.json.gz',
    bytes: 34_714,
    contentHash: '10195fb9969a20442553812630dba45a5d597544040ff9161cff9b23110bfbcc',
    canonicalHash: 'd88e147ced2f32dee0f01f529e835455b04453607ca6f3830da34a77154da655',
  },
  {
    name: 'entry-ablation',
    file: 'entry-ablation-document.json.gz',
    bytes: 1_458_989,
    contentHash: '8720d8f56d8d9a476b1f9de99b1bcb48280672c852afba5c9efce888330f3b32',
    canonicalHash: 'a4340e022a6397202d175c2b8c2e9e1ccd8524e43f30d57a474b626cce92c9a8',
  },
  {
    name: 'entry-momentum',
    file: 'entry-momentum-document.json.gz',
    bytes: 1_061_094,
    contentHash: 'b35781ba2b97a56ff799f6e9de748d140d2759d39c342138f650c832ef5f0938',
    canonicalHash: '1267f6cd0b904a80cfc34febd15df027a64033d6f3003540259d5888f94464db',
  },
  {
    name: 'exit-ablation-node',
    file: 'node-exit-ablation.json.gz',
    bytes: 34_714,
    contentHash: 'f0a3fa911898387768091caa4db69f9bf7b9187863e5594abd7bf2b5f83bc091',
    canonicalHash: '6b484aea69fda9cb2576e93ef149c7c2f6db7f6ac01fe0928d648e3e1923f9bd',
  },
  {
    name: 'exit-momentum-node',
    file: 'node-exit-momentum.json.gz',
    bytes: 34_714,
    contentHash: '005815abb3c0ecb46f84def21cbb9d7517f8af9c193ef828227e1b02fd57e4c3',
    canonicalHash: '1f295ab9a50da75e4d0d87913a2f78e5181717ff6125d4548e181e54572d8941',
  },
] as const

export const retainedV38FixtureBytes = (file: string) => {
  const bytes = readFileSync(new URL(`./fixtures/retained-v38/${file}`, import.meta.url))
  return file.endsWith('.gz') ? gunzipSync(bytes) : bytes
}

export const retainedV38ExecutionFixture = (index = 0) => {
  const golden = retainedV38ExecutionGoldens[index]
  if (golden === undefined) throw new Error('Missing retained v38 document golden')
  const bytes = retainedV38FixtureBytes(golden.file)
  const document = Result.getOrThrow(decodeRetainedJevV38ExecutionDecisionDocument(JSON.parse(bytes.toString('utf8'))))
  return { golden, bytes, document }
}
