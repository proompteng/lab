;(() => {
  const desktopOrigin = __TENGRI_DESKTOP_ORIGIN_JSON__
  const sessionId = window.location.hostname.match(/^tengri-([a-z0-9]{24})\./)?.[1]
  const nonce = new URL(window.location.href).searchParams.get('__tengri_renew') || ''
  const token = decodeURIComponent(window.location.hash.slice(1))
  history.replaceState(null, '', '/_tengri/preview/open')
  const send = (message) =>
    window.parent.postMessage(
      {
        channel: 'tengri-preview-lease-v1',
        sessionId,
        nonce,
        ...message,
      },
      desktopOrigin,
    )
  if (!token || !sessionId) {
    document.body.textContent = 'Preview session is missing or expired.'
    return
  }
  fetch('/_tengri/bootstrap', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
    .then(async (response) => {
      if (!response.ok) throw new Error('preview session rejected')
      const payload = await response.json()
      if (
        typeof payload.leaseId !== 'string' ||
        typeof payload.path !== 'string' ||
        typeof payload.fragment !== 'string' ||
        typeof payload.expiresInMs !== 'number'
      )
        throw new Error('preview lease missing')
      send({ type: 'renewed', leaseId: payload.leaseId, expiresInMs: payload.expiresInMs })
      // A renewal frame only refreshes the HttpOnly cookie. The visible application stays mounted.
      if (nonce) return
      window.location.replace(`${window.location.origin}${payload.path}${payload.fragment}`)
    })
    .catch(() => {
      send({ type: 'error' })
      document.body.textContent = 'Preview session is missing or expired.'
    })
})()
