export function clearDeletedDesktopState(agentId: string) {
  try {
    const exactKeys = new Set([`tengri:desktop:${agentId}`, `tengri:terminal-cleanup:${agentId}`])
    const prefixes = [`tengri:windows:${agentId}:`, `tengri:terminal:${agentId}:`]

    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index)
      if (key && prefixes.some((prefix) => key.startsWith(prefix))) exactKeys.add(key)
    }

    for (const key of exactKeys) sessionStorage.removeItem(key)
  } catch {
    // Deleted guest state is still authoritative when session storage is unavailable.
  }
}
