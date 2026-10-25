import * as Context from 'effect/Context'
import * as Layer from 'effect/Layer'
import type { Config, GlobalFlags, ResolvedConfig } from '../config'

export type AgentctlContextValue = {
  argv: string[]
  flags: GlobalFlags
  config: Config
  resolved: ResolvedConfig
}

export class AgentctlContext extends Context.Tag('agentctl/Context')<AgentctlContext, AgentctlContextValue>() {}

export const makeAgentctlContextLayer = (value: AgentctlContextValue) => Layer.succeed(AgentctlContext, value)
