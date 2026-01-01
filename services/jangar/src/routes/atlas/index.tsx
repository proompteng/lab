import { createFileRoute, Navigate } from '@tanstack/react-router'

export const Route = createFileRoute('/atlas/')({
  component: AtlasIndexRedirect,
})

const DEFAULT_LIMIT = 25

function AtlasIndexRedirect() {
  return <Navigate to="/atlas/search" search={{ query: '', repository: '', pathPrefix: '', limit: DEFAULT_LIMIT }} />
}
