#!/bin/sh
if [ -x "$HOME/.linuxbrew/bin/brew" ]; then
  export HOMEBREW_PREFIX="$HOME/.linuxbrew"
  export HOMEBREW_CELLAR="$HOMEBREW_PREFIX/Cellar"
  export HOMEBREW_REPOSITORY="$HOMEBREW_PREFIX/Homebrew"
  export PATH="$HOMEBREW_PREFIX/bin:$HOMEBREW_PREFIX/sbin${PATH+:$PATH}"
  if [ -n "${MANPATH-}" ]; then
    MANPATH="${MANPATH%"${MANPATH##*[!:]}"}"
    export MANPATH=":${MANPATH#"${MANPATH%%[!:]*}"}"
  fi
  export INFOPATH="$HOMEBREW_PREFIX/share/info:${INFOPATH:-}"
fi
export PATH="$HOME/.local/bin:$HOME/go/bin:$HOME/.cargo/bin:$PATH"
export EDITOR="${EDITOR:-nvim}"
export VISUAL="${VISUAL:-$EDITOR}"
