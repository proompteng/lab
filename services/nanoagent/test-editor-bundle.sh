#!/usr/bin/env bash
set -euo pipefail

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/config/nvim" "$work/data/nvim/lazy/custom-plugin/lua"
cp /usr/share/nanoagent/astronvim-init.lua "$work/config/nvim/init.lua"
chmod 0644 "$work/config/nvim/init.lua"
printf 'return true\n' > "$work/data/nvim/lazy/custom-plugin/lua/custom.lua"
sha256sum "$work/data/nvim/lazy/custom-plugin/lua/custom.lua" > "$work/custom.sha256"
export XDG_CONFIG_HOME="$work/config" XDG_DATA_HOME="$work/data" XDG_STATE_HOME="$work/state"
original_git="$(command -v git)"
mkdir -p "$work/bin"
{
  cat <<'SH'
#!/usr/bin/env bash
for argument in "$@"; do
  if [[ "$argument" == /opt/tengri/editor/plugins/blink.cmp/.git ]]; then exit 90; fi
done
SH
  printf 'exec %q "$@"\n' "$original_git"
} > "$work/bin/git"
chmod 0755 "$work/bin/git"
export PATH="$work/bin:$PATH"
for _ in 1 2; do
  /opt/tengri/editor/bin/nvim --headless \
    '+lua assert(vim.fn.has("nvim-0.12") == 1); assert(require("astronvim").version() == "v6.1.0"); assert(vim.o.number and vim.o.undofile)' \
    '+lua local plugin = require("lazy.core.config").plugins.AstroNvim; assert(plugin.commit and vim.fn.readfile(plugin.dir .. "/.git/HEAD")[1] == plugin.commit, "AstroNvim revision differs from the pinned commit")' \
    '+lua assert(require("lazy.core.config").options.install.missing == false)' \
    '+lua require("lazy").load({plugins={"blink.cmp"}}); assert(vim.wait(1000, function() return require("blink.cmp.fuzzy").implementation_type == "rust" end, 10), "bundled native completion is unavailable"); assert(require("blink.cmp.config").fuzzy.prebuilt_binaries.download == false)' \
    '+lua assert(vim.tbl_contains(require("blink.cmp.fuzzy").get_words("tengri completion"), "tengri"))' \
    '+lua for name,plugin in pairs(require("lazy.core.config").plugins) do assert(plugin.dir == "/opt/tengri/editor/plugins/" .. name, name .. " is not local"); assert(plugin._.installed, name .. " is missing") end' \
    '+lua for _,lang in ipairs({"bash","c","lua","markdown","markdown_inline","python","query","vim","vimdoc"}) do assert(vim.api.nvim_get_runtime_file("parser/" .. lang .. ".so", false)[1], lang .. " parser missing") end' \
    '+if v:errmsg != "" | cquit 1 | endif' +qa
done
sha256sum --check "$work/custom.sha256"
# An edited user configuration can still load its retained custom plugin.
printf 'package.path = vim.fn.stdpath("data") .. "/lazy/custom-plugin/lua/?.lua;" .. package.path\nassert(require("custom"))\n' > "$work/config/nvim/init.lua"
/opt/tengri/editor/bin/nvim --headless '+if v:errmsg != "" | cquit 1 | endif' +qa
printf 'Bundled Neovim and AstroNvim start offline; custom plugin data remains usable.\n'
