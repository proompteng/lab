#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

if ! grep -qi microsoft /proc/version; then
  echo "not_running_under_wsl2" >&2
  exit 2
fi

if ! nvidia-smi >/dev/null 2>&1; then
  echo "nvidia_smi_unavailable_inside_wsl2" >&2
  exit 2
fi

sudo apt-get update
sudo apt-get install -y \
  build-essential \
  ca-certificates \
  curl \
  git \
  python3.12 \
  python3.12-venv \
  python3-pip \
  wget

if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="${HOME}/.local/bin:${PATH}"
fi

mkdir -p "${HOME}/torghut-rapids-artifacts"

if ! dpkg -s cuda-keyring >/dev/null 2>&1; then
  tmp_deb="$(mktemp --suffix=.deb)"
  wget -O "${tmp_deb}" \
    https://developer.download.nvidia.com/compute/cuda/repos/wsl-ubuntu/x86_64/cuda-keyring_1.1-1_all.deb
  sudo dpkg -i "${tmp_deb}"
  rm -f "${tmp_deb}"
fi

sudo apt-get update
if apt-cache show cuda-toolkit-13-0 >/dev/null 2>&1; then
  sudo apt-get install -y cuda-toolkit-13-0
elif apt-cache show cuda-toolkit-13-1 >/dev/null 2>&1; then
  sudo apt-get install -y cuda-toolkit-13-1
else
  echo "cuda_toolkit_13_package_missing" >&2
  exit 2
fi

uv venv --python 3.12 .venv-rapids
source .venv-rapids/bin/activate
uv pip install --upgrade pip
uv pip install -r requirements/rapids-wsl2-cu13.txt
uv pip install -e ".[dev]"

python scripts/check_rapids_wsl2_runtime.py
python - <<'PY'
import cudf

print(cudf.Series([1, 2, 3]))
PY
