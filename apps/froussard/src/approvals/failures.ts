export const isRetryableGitHubFailure = (result: { reason: string; status?: number }) =>
  ['network-error', 'no-fetch', 'invalid-json'].includes(result.reason) ||
  (result.reason === 'http-error' &&
    (result.status === 404 ||
      result.status === 408 ||
      result.status === 422 ||
      result.status === 429 ||
      (result.status ?? 0) >= 500))
