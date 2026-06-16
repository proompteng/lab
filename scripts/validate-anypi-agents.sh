#!/usr/bin/env bash
set -euo pipefail

# Get the directory containing this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ARGOCD_AGENTS_DIR="${ROOT_DIR}/argocd/applications/agents"

# Check that kustomization includes anypi files
echo "Checking kustomization.yaml includes Anypi resources..."
if command -v rg >/dev/null 2>&1; then
  if ! rg -q "anypi" "${ARGOCD_AGENTS_DIR}/kustomization.yaml"; then
    echo "ERROR: kustomization.yaml does not include anypi resources" >&2
    exit 1
  fi
else
  if ! grep -q "anypi" "${ARGOCD_AGENTS_DIR}/kustomization.yaml"; then
    echo "ERROR: kustomization.yaml does not include anypi resources" >&2
    exit 1
  fi
fi

# Validate agentprovider manifests have required envTemplate fields
echo "Validating agentprovider manifests..."
for provider in anypi anypi-eval; do
  provider_file="${ARGOCD_AGENTS_DIR}/${provider}-agentprovider.yaml"
  
  if [[ ! -f "$provider_file" ]]; then
    echo "ERROR: AgentProvider manifest not found: ${provider_file}" >&2
    exit 1
  fi
  
  # Check for ANYPI_PROMPT_VARIANT in envTemplate
  if ! grep -q "ANYPI_PROMPT_VARIANT" "$provider_file"; then
    echo "ERROR: ${provider_file} must have ANYPI_PROMPT_VARIANT in envTemplate" >&2
    exit 1
  fi
  
  if [[ "$provider" == "anypi" ]]; then
    if ! grep -q "minimal" "$provider_file"; then
      echo "ERROR: ${provider}-agentprovider.yaml must have default prompt variant 'minimal'" >&2
      exit 1
    fi
  elif [[ "$provider" == "anypi-eval" ]]; then
    if ! grep -q '{{parameters.promptVariant}}' "$provider_file"; then
      echo "ERROR: ${provider}-agentprovider.yaml must use {{parameters.promptVariant}} template" >&2
      exit 1
    fi
  fi
done

# Validate agent manifests have vcsRef and security sections
echo "Validating agent manifests..."
for agent in anypi-agent anypi-eval-agent; do
  agent_file="${ARGOCD_AGENTS_DIR}/${agent}.yaml"
  
  if [[ ! -f "$agent_file" ]]; then
    echo "ERROR: Agent manifest not found: ${agent_file}" >&2
    exit 1
  fi
  
  # Check for required vcsRef
  if ! grep -q "vcsRef:" "$agent_file"; then
    echo "ERROR: ${agent_file} must have spec.vcsRef" >&2
    exit 1
  fi
  
  # Check for security.allowedSecrets
  if ! grep -q "allowedSecrets:" "$agent_file"; then
    echo "ERROR: ${agent_file} must have spec.security.allowedSecrets" >&2
    exit 1
  fi
done

# Validate PR body rendering includes prompt variant evidence
echo "Validating PR body template handling..."
if [[ -f "${ROOT_DIR}/services/anypi/src/run.ts" ]]; then
  if command -v rg >/dev/null 2>&1; then
    if ! rg -q "Prompt variant:" "${ROOT_DIR}/services/anypi/src/run.ts"; then
      echo "ERROR: run.ts must render prompt variant in PR body" >&2
      exit 1
    fi
    if ! rg -q "promptHash" "${ROOT_DIR}/services/anypi/src/run.ts"; then
      echo "ERROR: run.ts must render prompt hash in PR body" >&2
      exit 1
    fi
  else
    if ! grep -q "Prompt variant:" "${ROOT_DIR}/services/anypi/src/run.ts"; then
      echo "ERROR: run.ts must render prompt variant in PR body" >&2
      exit 1
    fi
    if ! grep -q "promptHash" "${ROOT_DIR}/services/anypi/src/run.ts"; then
      echo "ERROR: run.ts must render prompt hash in PR body" >&2
      exit 1
    fi
  fi
fi

# Check that validation commands inference includes agents manifests
echo "Validating validation command inference..."
if [[ -f "${ROOT_DIR}/services/anypi/src/prompt.ts" ]]; then
  if command -v rg >/dev/null 2>&1; then
    if ! rg -q "argocd/applications/agents" "${ROOT_DIR}/services/anypi/src/prompt.ts"; then
      echo "ERROR: prompt.ts should infer validation for argocd/applications/agents" >&2
      exit 1
    fi
  else
    if ! grep -q "argocd/applications/agents" "${ROOT_DIR}/services/anypi/src/prompt.ts"; then
      echo "ERROR: prompt.ts should infer validation for argocd/applications/agents" >&2
      exit 1
    fi
  fi
fi

# Validate AgentRun example includes required fields
echo "Validating AgentRun example..."
if [[ -f "${ROOT_DIR}/docs/agents/anypi.md" ]]; then
  if command -v rg >/dev/null 2>&1; then
    if ! rg -q "validationCommands:" "${ROOT_DIR}/docs/agents/anypi.md"; then
      echo "ERROR: anypi.md AgentRun example must include validationCommands" >&2
      exit 1
    fi
    if ! rg -q "promptVariant:" "${ROOT_DIR}/docs/agents/anypi-prompt-eval-agentruns.yaml"; then
      echo "ERROR: agentruns template must include promptVariant" >&2
      exit 1
    fi
  else
    if ! grep -q "validationCommands:" "${ROOT_DIR}/docs/agents/anypi.md"; then
      echo "ERROR: anypi.md AgentRun example must include validationCommands" >&2
      exit 1
    fi
    if ! grep -q "promptVariant:" "${ROOT_DIR}/docs/agents/anypi-prompt-eval-agentruns.yaml"; then
      echo "ERROR: agentruns template must include promptVariant" >&2
      exit 1
    fi
  fi
fi

# Validate no placeholder text in evaluation manifests
echo "Checking for placeholder text in evaluation manifests..."
for file in "${ROOT_DIR}/docs/agents/anypi-prompt-eval"*.yaml; do
  if [[ -f "$file" ]]; then
    if command -v rg >/dev/null 2>&1; then
      if rg -q "TODO|TBD|<\.\.\.>" "$file"; then
        echo "ERROR: Found placeholder text in $file" >&2
        exit 1
      fi
    else
      if grep -qE "TODO|TBD|<\.\.\.>" "$file"; then
        echo "ERROR: Found placeholder text in $file" >&2
        exit 1
      fi
    fi
  fi
done

echo "All Anypi Agents manifest validations passed."
