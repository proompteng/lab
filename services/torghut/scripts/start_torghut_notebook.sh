#!/usr/bin/env bash
set -euo pipefail

readonly canonical_dir=/opt/torghut-notebooks
readonly workspace_dir=/home/jovyan/work

mkdir -p "${workspace_dir}"
for notebook in \
  00-system-flow.ipynb \
  10-strategy-lifecycle.ipynb \
  20-execution-evidence.ipynb \
  30-capital-authority.ipynb \
  40-transformer-math-from-first-principles.ipynb; do
  if [[ ! -e "${workspace_dir}/${notebook}" ]]; then
    cp "${canonical_dir}/${notebook}" "${workspace_dir}/${notebook}"
  fi
done

if [[ ! -e "${workspace_dir}/README.md" ]]; then
  cp "${canonical_dir}/README.md" "${workspace_dir}/README.md"
fi

if [[ "$#" -eq 0 ]]; then
  set -- jupyterhub-singleuser
fi

exec "$@"
