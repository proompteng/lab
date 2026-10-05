export const terminalHeartbeatMaximum = ({ heartbeatMaxMs, pendingHeartbeatLatenessMs }) =>
  Math.max(heartbeatMaxMs, pendingHeartbeatLatenessMs ?? 0)
