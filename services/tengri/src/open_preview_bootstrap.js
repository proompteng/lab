;(() => {
  const token = decodeURIComponent(window.location.hash.slice(1))
  const nonce = new URL(window.location.href).searchParams.get('__tengri_renew')
  history.replaceState(null, '', '/v1/preview/open')
  if (!token) {
    document.body.textContent = 'Preview ticket is missing or expired.'
    return
  }
  fetch('/v1/preview/open', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
    .then(async (response) => {
      if (!response.ok) throw new Error('preview ticket rejected')
      const payload = await response.json()
      if (typeof payload.location !== 'string') throw new Error('preview location missing')
      const location = new URL(payload.location)
      if (nonce) location.searchParams.set('__tengri_renew', nonce)
      window.location.replace(location.href)
    })
    .catch(() => {
      document.body.textContent = 'Preview ticket is missing or expired.'
    })
})()
