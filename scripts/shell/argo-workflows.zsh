#!/usr/bin/env zsh
# shellcheck shell=bash
# Argo Workflows aliases and helpers for the oh-my-posh Zsh setup.
# The file is sourced from .zshrc so keep definitions idempotent.

if ! command -v argo >/dev/null 2>&1; then
  return 0
fi

# Keep argo completion available even when running without Oh My Zsh.
if [[ -z ${__ARGO_COMPLETION_SOURCED:-} ]]; then
  autoload -U +X compinit && compinit
  # shellcheck disable=SC1090
  source <(argo completion zsh 2>/dev/null)
  __ARGO_COMPLETION_SOURCED=1
fi

alias aw='argo'
alias awl='argo list'
alias awg='argo get'
alias awd='argo delete'
alias aws='argo submit'
alias awt='argo get --watch'

# shellcheck disable=SC2154
if (( $+functions[compdef] )); then
  compdef aw=argo 2>/dev/null
fi

__aw_current_namespace() {
  if [[ -n ${ARGO_NAMESPACE:-} ]]; then
    print -r -- "$ARGO_NAMESPACE"
    return
  fi
  print -r -- default
}

__aw_require_fzf() {
  if command -v fzf >/dev/null 2>&1; then
    return 0
  fi
  print -u2 -- 'argo helper requires fzf; install fzf or set FZF_DEFAULT_COMMAND.'
  return 1
}

__aw_select_workflow() {
  __aw_require_fzf || return
  local ns line wf
  ns=${1:-$(__aw_current_namespace)}
  line=$(ARGO_NAMESPACE="$ns" argo list --output wide 2>/dev/null | \
    tail -n +2 | \
    fzf --prompt="workflows (${ns})> " --height=50% --border \
        --preview "ARGO_NAMESPACE=${ns} argo get {1} --output yaml" \
        --preview-window=right:60%:wrap \
        --ansi) || return
  wf=${line%% *}
  [[ -n $wf ]] && print -r -- "$wf"
}

awns() {
  local ns picker_output
  if [[ -n $1 ]]; then
    ns=$1
  else
    __aw_require_fzf || return
    picker_output=$(argo list --all-namespaces 2>/dev/null | \
      awk 'NR>1 {print $1}' | sort -u | \
      fzf --prompt='namespaces> ' --height=40% --border \
          --preview 'ARGO_NAMESPACE={} argo list --limit 5' \
          --preview-window=right:60%:wrap \
          --ansi)
    if [[ -z $picker_output ]]; then
      if command -v kubectl >/dev/null 2>&1; then
        picker_output=$(kubectl get namespaces -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null | \
          fzf --prompt='namespaces> ' --height=40% --border \
              --preview 'kubectl get namespace {} -o yaml' \
              --preview-window=right:60%:wrap \
              --ansi)
      fi
    fi
    ns=$picker_output
  fi
  [[ -z $ns ]] && return
  export ARGO_NAMESPACE="$ns"
  print -r -- "ARGO_NAMESPACE=${ARGO_NAMESPACE}"
}

awlogs() {
  local ns wf step
  local args=()
  local has_follow=0
  local skip_follow=0

  ns=${ARGO_NAMESPACE:-$(__aw_current_namespace)}
  if [[ -n $1 ]]; then
    wf=$1; shift
  else
    wf=$(__aw_select_workflow "$ns") || return
  fi
  if [[ -n $1 ]]; then
    step=$1; shift
  fi
  for arg in "$@"; do
    if [[ $arg == --no-follow ]]; then
      skip_follow=1
      continue
    fi
    args+=("$arg")
    if [[ $arg == --follow || $arg == -f ]]; then
      has_follow=1
    fi
  done
  if [[ $has_follow -eq 0 && $skip_follow -eq 0 ]]; then
    args+=(--follow)
  fi
  ARGO_NAMESPACE="$ns" argo logs "$wf" ${step:+--step "$step"} "${args[@]}"
}

awwatch() {
  local ns wf
  ns=${ARGO_NAMESPACE:-$(__aw_current_namespace)}
  if [[ -n $1 ]]; then
    wf=$1; shift
  else
    wf=$(__aw_select_workflow "$ns") || return
  fi
  ARGO_NAMESPACE="$ns" argo get "$wf" --watch "$@"
}

awresubmit() {
  local ns wf
  ns=${ARGO_NAMESPACE:-$(__aw_current_namespace)}
  if [[ -n $1 ]]; then
    wf=$1; shift
  else
    wf=$(__aw_select_workflow "$ns") || return
  fi
  ARGO_NAMESPACE="$ns" argo resubmit "$wf" "$@"
}

awterminate() {
  local ns wf
  ns=${ARGO_NAMESPACE:-$(__aw_current_namespace)}
  if [[ -n $1 ]]; then
    wf=$1; shift
  else
    wf=$(__aw_select_workflow "$ns") || return
  fi
  ARGO_NAMESPACE="$ns" argo terminate "$wf" "$@"
}
