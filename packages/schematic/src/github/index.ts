const ciWorkflow = (name: string) => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expression literal
  const workflowExpr = '${{ github.workflow }}'
  // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expression literal
  const refExpr = '${{ github.ref }}'
  return `name: ${name}-ci

on:
  pull_request:
    paths:
      - 'services/${name}/**'
      - 'packages/scripts/src/${name}/**'
      - 'argocd/applications/${name}/**'
      - '.github/workflows/${name}-ci.yml'

concurrency:
  group: ${workflowExpr}-${refExpr}
  cancel-in-progress: true

jobs:
  lint-test-build:
    uses: ./.github/workflows/common-monorepo.yml
    with:
      install-command: bun install --frozen-lockfile
      lint-command: bunx oxfmt --check services/${name} packages/scripts/src/${name} argocd/applications/${name}
      test-command: cd services/${name} && bun run test
      build-command: cd services/${name} && bun run build
`
}

const buildWorkflow = (name: string) => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expression literal
  const shaExpr = '${{ github.sha }}'
  return `name: ${name}-build-push

on:
  push:
    branches:
      - main
    paths:
      - 'services/${name}/**'
      - 'packages/scripts/src/${name}/**'
      - 'argocd/applications/${name}/**'
      - '.github/workflows/${name}-build-push.yaml'
  workflow_dispatch:

jobs:
  docker:
    uses: ./.github/workflows/docker-build-common.yaml
    with:
      image_name: ${name}
      dockerfile: services/${name}/Dockerfile
      context: .
      new_tag: ${shaExpr}
      platforms: linux/arm64
`
}

export { buildWorkflow, ciWorkflow }
