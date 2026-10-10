local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not vim.uv.fs_stat(lazypath) then
  vim.fn.mkdir(vim.fn.fnamemodify(lazypath, ":h"), "p")
  local staging = vim.fn.trim(vim.fn.system({ "mktemp", "-d", lazypath .. ".install-XXXXXX" }))
  assert(vim.v.shell_error == 0 and staging ~= "", "create Lazy staging directory: " .. staging)
  local output = vim.fn.system({
    "git", "clone", "--filter=blob:none", "--branch=stable",
    "https://github.com/folke/lazy.nvim.git", staging,
  })
  assert(vim.v.shell_error == 0, output)
  output = vim.fn.system({
    "git", "-C", staging, "checkout", "--detach",
    "85c7ff3711b730b4030d03144f6db6375044ae82",
  })
  assert(vim.v.shell_error == 0, output)
  local installed, err = vim.uv.fs_rename(staging, lazypath)
  assert(installed, err)
end
vim.opt.rtp:prepend(lazypath)

require("lazy").setup({
  {
    "AstroNvim/AstroNvim",
    version = "v6.1.0",
    import = "astronvim.plugins",
    opts = {
      mapleader = " ",
      maplocalleader = ",",
      icons_enabled = true,
    },
  },
}, {
  install = { colorscheme = { "astrotheme", "habamax" } },
  ui = { backdrop = 100 },
})
