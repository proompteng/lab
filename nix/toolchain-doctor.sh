fail() {
  printf 'toolchain-doctor: %s\n' "$*" >&2
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

expect_eq() {
  name="$1"
  expected="$2"
  actual="$3"
  if [ "$actual" != "$expected" ]; then
    fail "$name expected $expected, got $actual"
  fi
  printf '%-18s %s\n' "$name" "$actual"
}

expect_contains() {
  name="$1"
  expected="$2"
  actual="$3"
  case "$actual" in
    *"$expected"*) printf '%-18s %s\n' "$name" "$actual" ;;
    *) fail "$name expected output containing $expected, got $actual" ;;
  esac
}

for cmd in node bun go ruby python3.11 python3.12 uv tofu helm kustomize kubeconform kubectl argo argocd buf gh shellcheck jq yq rg fd fzf; do
  have "$cmd"
done

expect_eq node v24.11.1 "$(node --version)"
expect_eq bun 1.3.14 "$(bun --version)"
expect_eq go go1.25.5 "$(go version | awk '{print $3}')"
expect_eq ruby 3.4.7 "$(ruby --version | awk '{print $2}')"
expect_contains python3.11 "Python 3.11." "$(python3.11 --version)"
expect_contains python3.12 "Python 3.12." "$(python3.12 --version)"
printf '%-18s %s\n' uv "$(uv --version | head -n 1)"
printf '%-18s %s\n' tofu "$(tofu version | head -n 1)"
expect_eq helm v3.14.4 "$(helm version --template '{{ .Version }}')"
expect_contains kustomize "v5.8.0" "$(kustomize version)"
expect_contains kubeconform "v0.7.0" "$(kubeconform -v)"
expect_contains kubectl "v1.29.4" "$(kubectl version --client=true --output=yaml | awk '/gitVersion:/ {print $2; exit}')"
expect_contains argo "v4.0.5" "$(argo version --short 2>/dev/null || argo version | head -n 1)"
printf '%-18s %s\n' argocd "$(argocd version --client 2>/dev/null | head -n 1)"
printf '%-18s %s\n' buf "$(buf --version)"
printf '%-18s %s\n' gh "$(gh --version | head -n 1)"
printf '%-18s %s\n' shellcheck "$(shellcheck --version | awk -F': ' '/version:/ {print $2; exit}')"
expect_contains yq "v4.49.2" "$(yq --version)"
printf 'toolchain-doctor: ok\n'
