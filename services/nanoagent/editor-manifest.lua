local patched = vim.system({
  "git", "-C", "/opt/tengri/editor/plugins/blink.cmp", "apply", "--whitespace=error-all",
  "/usr/share/nanoagent/blink-manual-library.patch",
}):wait()
assert(patched.code == 0, patched.stderr)
require("lazy").load({ plugins = { "blink.cmp", "nvim-treesitter" } })
assert(vim.wait(300000, function()
  return require("blink.cmp.fuzzy").implementation_type == "rust"
end, 10), "native completion failed installation")
assert(vim.fn.delete(require("blink.cmp.fuzzy.download.files").version_path) == 0, "completion download metadata remains")
local languages = { "bash", "c", "lua", "markdown", "markdown_inline", "python", "query", "vim", "vimdoc" }
require("nvim-treesitter").install(languages):wait(300000)
for _, language in ipairs(languages) do
  assert(vim.tbl_contains(require("nvim-treesitter").get_installed(), language), language .. " parser is missing")
end
local plugins = {}
for name, plugin in pairs(require("lazy.core.config").plugins) do
  assert(plugin._.installed, name .. " is missing")
  for _, task in ipairs(plugin._.tasks or {}) do
    assert(not task:has_errors(), name .. " failed installation")
  end
  assert(plugin.dir == "/opt/tengri/editor/plugins/" .. name, name .. " is outside the editor bundle")
  table.insert(plugins, {
    url = plugin.url,
    name = name,
    dir = plugin.dir,
    pin = true,
    opts = name == "blink.cmp" and {
      fuzzy = { prebuilt_binaries = { download = false } },
    } or nil,
  })
end
table.sort(plugins, function(a, b) return a.name < b.name end)
local astro = require("lazy.core.config").plugins.AstroNvim
assert(astro.commit and vim.fn.readfile(astro.dir .. "/.git/HEAD")[1] == astro.commit, "AstroNvim revision differs from the pinned commit")
local version = require("astronvim").version()
assert(version == "v6.1.0", "expected AstroNvim v6.1.0, got " .. tostring(version))
assert(vim.v.errmsg == "", vim.v.errmsg)
vim.fn.writefile(vim.split("return " .. vim.inspect(plugins), "\n", { plain = true }), "/opt/tengri/editor/plugins.lua")
