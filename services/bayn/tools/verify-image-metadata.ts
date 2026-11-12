import { readFileSync } from 'node:fs'
import { Result } from 'effect'

import { BrokerEnvironment } from '../src/broker/identity'
import { makeStrategyProtocolHashResult } from '../src/contracts'
import { makeExecutionRiskPolicy } from '../src/execution/risk-policy'
import { canonicalHashV1Result } from '../src/hash'
import { activeStrategyBehaviorHash, activeStrategyName, loadActiveStrategyProtocol } from '../src/strategy'

const identity = Result.getOrThrow(
  Result.gen(function* () {
    const protocol = yield* loadActiveStrategyProtocol()
    const parameterHash = yield* canonicalHashV1Result(protocol)
    const protocolHash = yield* makeStrategyProtocolHashResult({
      name: activeStrategyName,
      behaviorHash: activeStrategyBehaviorHash,
      parameterHash,
      parameterSchemaVersion: protocol.schemaVersion,
    })
    const riskPolicy = yield* makeExecutionRiskPolicy('build-contract', protocol.universe, BrokerEnvironment.Sandbox)
    return {
      strategyBehaviorHash: activeStrategyBehaviorHash,
      strategyParameterHash: parameterHash,
      strategyName: activeStrategyName,
      strategyProtocolHash: protocolHash,
      executionRiskPolicyHash: yield* canonicalHashV1Result(riskPolicy),
    }
  }),
)
const nix = readFileSync(new URL('../../../nix/images/bayn.nix', import.meta.url), 'utf8')
for (const [name, actual] of Object.entries(identity)) {
  const values = [...nix.matchAll(new RegExp(`^  ${name} = "([^"]+)";`, 'gm'))]
  if (values.length !== 1 || values[0]?.[1] !== actual)
    throw new Error(`Bayn image ${name} does not match production source: expected ${actual}`)
}
