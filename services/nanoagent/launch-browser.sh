#!/usr/bin/env bash
set -euo pipefail
umask 077
browser_root="$HOME/.tengri/browser"
if [[ -f "$browser_root/runtime-path" ]]; then
  runtime_root="$(<"$browser_root/runtime-path")"
  [[ "$runtime_root" == "$browser_root"/libraries-* && -f "$runtime_root/.verified" ]]
  export PATH="$runtime_root/usr/bin:$PATH"
  runtime_libraries="$runtime_root/usr/lib:$runtime_root/lib"
  for directory in "$runtime_root/usr/lib/"*-linux-gnu "$runtime_root/lib/"*-linux-gnu; do
    if [[ -d "$directory" ]]; then runtime_libraries="$runtime_libraries:$directory"; fi
  done
  export LD_LIBRARY_PATH="$runtime_libraries${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export XDG_DATA_DIRS="$runtime_root/usr/share:/usr/local/share:/usr/share"
  export XKB_CONFIG_ROOT="$runtime_root/usr/share/X11/xkb" XKB_BINDIR="$runtime_root/usr/bin"
  export FONTCONFIG_FILE="$browser_root/fonts.conf"
  cat > "$FONTCONFIG_FILE" <<XML
<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig><dir>$runtime_root/usr/share/fonts</dir><cachedir>$browser_root/font-cache</cachedir>
<alias><family>sans-serif</family><prefer><family>Liberation Sans</family></prefer></alias>
<alias><family>sans</family><prefer><family>Liberation Sans</family></prefer></alias>
<alias><family>serif</family><prefer><family>Liberation Serif</family></prefer></alias>
<alias><family>monospace</family><prefer><family>Liberation Mono</family></prefer></alias>
</fontconfig>
XML
fi
if [[ "${1:-}" == --validate-install ]]; then
  "$CHROMIUM_BINARY" --version
  Xtigervnc -version
  xdotool --version
  xclip -version
  scrot --version
  exit 0
fi
export DISPLAY=:91 XAUTHORITY="$browser_root/xauthority" XDG_RUNTIME_DIR="$browser_root/runtime"
mkdir -p "$browser_root/profile/Default" "$XDG_RUNTIME_DIR" "$TENGRI_BROWSER_DOWNLOADS"
chmod 0700 "$browser_root" "$XDG_RUNTIME_DIR"
exec 9>"$browser_root/session.lock"
flock --nonblock 9
# The exclusive display lease makes these crashed-process symlinks safe to
# remove when the retained profile resumes in a guest with a new hostname.
rm -f "$browser_root/profile/SingletonLock" "$browser_root/profile/SingletonCookie" "$browser_root/profile/SingletonSocket"
rm -f "$browser_root/ready" "$browser_root/rfb.sock" "$XAUTHORITY"
touch "$XAUTHORITY"
xauth -f "$XAUTHORITY" add "$DISPLAY" . "$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
browser_pids=()
cleanup() {
  trap - EXIT INT TERM
  rm -f "$browser_root/ready"
  for ((browser_index=${#browser_pids[@]}-1; browser_index>=0; browser_index--)); do
    kill "${browser_pids[browser_index]}" 2>/dev/null || true
    wait "${browser_pids[browser_index]}" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM
Xtigervnc "$DISPLAY" ${XKB_CONFIG_ROOT:+-xkbdir "$XKB_CONFIG_ROOT"} -geometry 1280x800 -depth 24 -nolisten tcp -auth "$XAUTHORITY" \
  -rfbport -1 -rfbunixpath "$browser_root/rfb.sock" -rfbunixmode 0600 \
  -SecurityTypes None -AlwaysShared -desktop Chrome &
browser_pids+=("$!")
for ((browser_attempt=0; browser_attempt<100; browser_attempt++)); do
  if xdpyinfo >/dev/null 2>&1; then break; fi
  sleep .1
done
xdpyinfo >/dev/null
cat > "$browser_root/openbox.xml" <<'XML'
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <applications><application class="*"><decor>no</decor><maximized>yes</maximized></application></applications>
  <focus><focusNew>yes</focusNew><followMouse>no</followMouse></focus>
  <desktops><number>1</number></desktops>
</openbox_config>
XML
openbox --config-file "$browser_root/openbox.xml" &
browser_pids+=("$!")
browser_preferences="$browser_root/profile/Default/Preferences"
if [[ ! -f "$browser_preferences" ]]; then printf '{}\n' > "$browser_preferences"; fi
jq --arg directory "$TENGRI_BROWSER_DOWNLOADS" \
  '.download.default_directory=$directory | .download.prompt_for_download=false | .browser.check_default_browser=false | .browser.custom_chrome_frame=false | .profile.default_content_setting_values.notifications=2 | .extensions.theme.system_theme=2' \
  "$browser_preferences" > "$browser_preferences.tmp"
mv "$browser_preferences.tmp" "$browser_preferences"
"$CHROMIUM_BINARY" --user-data-dir="$browser_root/profile" --no-first-run --no-default-browser-check \
  --start-maximized --disable-dev-shm-usage --force-dark-mode --ozone-platform=x11 about:blank &
browser_pids+=("$!")
for ((browser_attempt=0; browser_attempt<150; browser_attempt++)); do
  if xdotool search --onlyvisible --class 'chromium|chrome' >/dev/null 2>&1; then
    touch "$browser_root/ready"
    break
  fi
  kill -0 "${browser_pids[2]}"
  sleep .1
done
[[ -f "$browser_root/ready" ]]
wait -n "${browser_pids[@]}"
