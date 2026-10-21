# Dev toolchain environment for Fexa work in WSL (Ruby/rbenv, Node/nvm, Sencha, Android).
#
# Loaded by EVERY bash shell, not just interactive terminals:
#   ~/.bashrc   sources it ABOVE the "not interactive -> return" guard
#   ~/.profile  exports BASH_ENV=~/.dev-env.sh, so non-interactive `bash -c` / scripts load it too
# ~/.dev-env.sh is a symlink to this file (bin/setup.sh installs it). Edit here, not in ~/.bashrc.
#
# Must stay safe to source repeatedly and silent (no output): it runs for every script.

_dev_prepend() { case ":$PATH:" in *":$1:"*) ;; *) [ -d "$1" ] && PATH="$1:$PATH" ;; esac; }
_dev_append()  { case ":$PATH:" in *":$1:"*) ;; *) [ -d "$1" ] && PATH="$PATH:$1" ;; esac; }

# Claude Code (native installer)
_dev_prepend "$HOME/.local/bin"

# Ruby 2.7.8 via rbenv. Shims on PATH is all a script needs; the interactive
# block below adds the `rbenv` shell function on top.
_dev_prepend "$HOME/.rbenv/bin"
_dev_prepend "$HOME/.rbenv/shims"

# Sencha Cmd 7.7.0.36 (desktop build). Cmd/ must come before the switcher dir.
# Mobile builds need 6.5.3.6 — use a subshell PATH override, never change this default.
_dev_prepend "$HOME/bin/Sencha"
_dev_prepend "$HOME/bin/Sencha/Cmd"

# Node via nvm: put the default version's bin on PATH without loading nvm.sh
# (nvm.sh is slow, and scripts only need `node`/`npm`). `nvm alias default 20`.
export NVM_DIR="$HOME/.nvm"
if [ -r "$NVM_DIR/alias/default" ]; then
  _dev_node_ver="$(cat "$NVM_DIR/alias/default")"
  _dev_node_bin="$(ls -d "$NVM_DIR"/versions/node/v"${_dev_node_ver#v}"*/bin 2>/dev/null | sort -V | tail -1)"
  [ -n "$_dev_node_bin" ] && _dev_prepend "$_dev_node_bin"
  unset _dev_node_ver _dev_node_bin
fi

# Android SDK + Gradle (Fexa mobile / Cordova build)
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
_dev_append "$ANDROID_HOME/cmdline-tools/latest/bin"
_dev_append "$ANDROID_HOME/platform-tools"
_dev_append "$HOME/tools/gradle-8.14.2/bin"

export PATH
unset -f _dev_prepend _dev_append

# Interactive extras: the `rbenv` and `nvm` shell functions and completion.
case $- in
  *i*)
    command -v rbenv >/dev/null 2>&1 && eval "$(rbenv init - bash)"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    [ -s "$NVM_DIR/bash_completion" ] && . "$NVM_DIR/bash_completion"
    ;;
esac
