import type { TengriAgent, TengriDesktopSnapshot } from './types'

export type DesktopGateState =
  | { kind: 'auth-unconfigured' }
  | { kind: 'control-plane-unconfigured' }
  | { kind: 'create' }
  | { kind: 'error'; detail: string }
  | { kind: 'failed'; agent: TengriAgent }
  | { kind: 'loading' }
  | { kind: 'ready'; agent: TengriAgent }
  | { kind: 'sign-in' }
  | { kind: 'sleeping'; agent: TengriAgent }
  | { kind: 'transitioning'; agent: TengriAgent }
  | { kind: 'unknown'; agent: TengriAgent }

export function resolveDesktopGate(snapshot: TengriDesktopSnapshot | null, error: string): DesktopGateState {
  if (!snapshot && !error) return { kind: 'loading' }
  if (error) return { kind: 'error', detail: error }
  if (!snapshot?.authConfigured) return { kind: 'auth-unconfigured' }
  if (!snapshot.authenticated) return { kind: 'sign-in' }
  if (!snapshot.controlPlaneConfigured) return { kind: 'control-plane-unconfigured' }

  const agent = snapshot.agents[0]
  if (!agent) return { kind: 'create' }
  if (agent.phase === 'ready') return { kind: 'ready', agent }
  if (agent.phase === 'sleeping') return { kind: 'sleeping', agent }
  if (agent.phase === 'failed') return { kind: 'failed', agent }
  if (agent.phase === 'unknown') return { kind: 'unknown', agent }
  return { kind: 'transitioning', agent }
}
