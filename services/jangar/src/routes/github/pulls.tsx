import { createFileRoute, Outlet } from '@tanstack/react-router'

export const Route = createFileRoute('/github/pulls')({
  component: GithubPullsLayout,
})

function GithubPullsLayout() {
  return <Outlet />
}
