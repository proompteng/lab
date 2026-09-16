#!/usr/bin/env bash
set -euo pipefail

pstack_root="${AGENTS_SHELL_PSTACK_ROOT:-/opt/agents-shell/pstack}"
skills_source="${pstack_root}/skills"
prompts_source="${pstack_root}/.codex-plugin/prompts"
skills_target="${HOME}/.agents/skills"
prompts_target="${HOME}/.codex/prompts"

if [[ ! -f "${skills_source}/poteto-mode/SKILL.md" ]]; then
  echo "agents-shell pstack bundle is missing poteto-mode" >&2
  exit 1
fi
if [[ ! -d "${prompts_source}" ]]; then
  echo "agents-shell pstack bundle is missing Codex prompts" >&2
  exit 1
fi

mkdir -p "${skills_target}" "${prompts_target}"

install_link() {
  local source="$1"
  local target="$2"

  if [[ -L "${target}" ]]; then
    local current
    current="$(readlink "${target}")"
    if [[ "${current}" == "${pstack_root}"/* ]]; then
      ln -sfn "${source}" "${target}"
    fi
    return
  fi

  if [[ -e "${target}" ]]; then
    return
  fi

  ln -s "${source}" "${target}"
}

for skill in "${skills_source}"/*; do
  [[ -d "${skill}" && -f "${skill}/SKILL.md" ]] || continue
  install_link "${skill}" "${skills_target}/$(basename "${skill}")"
done

for prompt in "${prompts_source}"/*.md; do
  [[ -f "${prompt}" ]] || continue
  install_link "${prompt}" "${prompts_target}/$(basename "${prompt}")"
done
