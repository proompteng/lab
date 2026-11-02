#!/usr/bin/env bash
set -euo pipefail

case "${1:?target architecture is required}" in
  amd64) arch=x86_64; digest=bce0f56eda1f1b1db6eee8f4133d7a38813ea07933837dd1777411ca384c6875; ts_arch=x64; ts_digest=d01042f94ba3d6827ddc9788e235f75d8366431be42bdf90ade534d960c98b7d ;;
  arm64) arch=arm64; digest=1aa5ca085249580ae0f91eb14f27ec0919773ff2d99a163d03f3d6c21ac29725; ts_arch=arm64; ts_digest=404be5d54a4955571c4067c21d4699660eab3a534cefb0659341b207f7139ec5 ;;
  *) exit 1 ;;
esac

editor=/opt/tengri/editor
mkdir -p "$editor/nvim" "$editor/plugins" "$editor/bin"
curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error --retry 3 \
  "https://github.com/neovim/neovim/releases/download/v0.12.5/nvim-linux-$arch.tar.gz" -o /tmp/nvim.tar.gz
printf '%s  /tmp/nvim.tar.gz\n' "$digest" | sha256sum --check --status -
tar -xzf /tmp/nvim.tar.gz --strip-components=1 --no-same-owner -C "$editor/nvim"
rm /tmp/nvim.tar.gz
curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error --retry 3 \
  "https://github.com/tree-sitter/tree-sitter/releases/download/v0.27.1/tree-sitter-linux-$ts_arch.gz" -o /tmp/tree-sitter.gz
printf '%s  /tmp/tree-sitter.gz\n' "$ts_digest" | sha256sum --check --status -
gzip -dc /tmp/tree-sitter.gz > "$editor/bin/tree-sitter"
chmod 0755 "$editor/bin/tree-sitter"
rm /tmp/tree-sitter.gz
export PATH="$editor/bin:$PATH"
git clone --filter=blob:none https://github.com/folke/lazy.nvim.git "$editor/plugins/lazy.nvim"
git -C "$editor/plugins/lazy.nvim" checkout --detach 85c7ff3711b730b4030d03144f6db6375044ae82
TENGRI_EDITOR_BUILD=1 "$editor/nvim/bin/nvim" --headless -u /usr/share/nanoagent/astronvim-init.lua \
  '+lua require("lazy").install({wait=true,show=false})' \
  '+luafile /usr/share/nanoagent/editor-manifest.lua' \
  '+if v:errmsg != "" | cquit 1 | endif' +qa
cp -a "$HOME/.local/share/nvim/site" "$editor/site"
install -m 0755 /usr/share/nanoagent/launch-editor.sh "$editor/bin/nvim"
chmod -R a+rX "$editor"
du -sk "$editor"
