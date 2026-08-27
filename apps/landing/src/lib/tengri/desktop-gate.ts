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
  if (!snapshot) return error ? { kind: 'error', detail: error } : { kind: 'loading' }
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

export function shouldRenderTengriDesktop(authConfigured: boolean, controlPlaneConfigured: boolean) {
  return authConfigured && controlPlaneConfigured
}

export function desktopRefreshDelay(state: DesktopGateState, now: number): number | null {
  if (state.kind === 'transitioning') return 2_000
  if (state.kind === 'ready') return refreshBeforeDeadline(now, state.agent.idleDeadline, state.agent.expiresAt)
  if (state.kind === 'sleeping') return refreshBeforeDeadline(now, state.agent.expiresAt)
  return null
}

function refreshBeforeDeadline(now: number, ...deadlines: string[]) {
  let delay = 30_000
  for (const deadline of deadlines) {
    const timestamp = Date.parse(deadline)
    if (!Number.isFinite(timestamp)) continue
    delay = Math.min(delay, Math.max(1_000, timestamp - now + 250))
  }
  return delay
}
