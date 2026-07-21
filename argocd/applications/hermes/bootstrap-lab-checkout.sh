#!/bin/sh
set -eu

umask 077
export GIT_TERMINAL_PROMPT="${GIT_TERMINAL_PROMPT:-0}"
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null

repository_url=${LAB_REPOSITORY_URL:-https://github.com/proompteng/lab.git}
checkout_ref=${LAB_CHECKOUT_REF:-main}
checkout_dir=${LAB_CHECKOUT_DIR:-/opt/data/workspace/tuslagch/lab}
revision_file=${LAB_CHECKOUT_REVISION_FILE:-/opt/data/workspace/tuslagch/.lab-source-revision}

case "$checkout_ref" in
  ''|*[!A-Za-z0-9._/-]*)
    echo "invalid lab checkout ref: $checkout_ref" >&2
    exit 1
    ;;
esac

if [ -L "$checkout_dir" ]; then
  echo "lab checkout path must not be a symbolic link: $checkout_dir" >&2
  exit 1
fi

mkdir -p "$(dirname "$checkout_dir")" "$(dirname "$revision_file")"

if [ ! -e "$checkout_dir" ]; then
  staging_dir="${checkout_dir}.clone.$$"
  cleanup_staging() {
    rm -rf -- "$staging_dir"
  }
  trap cleanup_staging EXIT HUP INT TERM
  git -c protocol.version=2 clone \
    --filter=blob:none \
    --no-tags \
    --single-branch \
    --branch "$checkout_ref" \
    "$repository_url" \
    "$staging_dir"
  mv -- "$staging_dir" "$checkout_dir"
  trap - EXIT HUP INT TERM
elif [ ! -d "$checkout_dir/.git" ]; then
  echo "lab checkout path exists but is not a Git worktree: $checkout_dir" >&2
  exit 1
else
  configured_remote=$(git -C "$checkout_dir" remote get-url origin)
  if [ "$configured_remote" != "$repository_url" ]; then
    echo "lab checkout origin mismatch: $configured_remote" >&2
    exit 1
  fi

  if git -C "$checkout_dir" fetch \
    --filter=blob:none \
    --no-tags \
    --prune \
    origin \
    "refs/heads/$checkout_ref:refs/remotes/origin/$checkout_ref"; then
    current_branch=$(git -C "$checkout_dir" symbolic-ref --quiet --short HEAD || true)
    if [ "$current_branch" = "$checkout_ref" ] && [ -z "$(git -C "$checkout_dir" status --porcelain)" ]; then
      git -C "$checkout_dir" merge --ff-only "refs/remotes/origin/$checkout_ref"
    else
      echo "preserving local lab checkout state; refreshed origin/$checkout_ref only"
    fi
  else
    echo "warning: could not refresh lab checkout; preserving the existing verified worktree" >&2
  fi
fi

revision=$(git -C "$checkout_dir" rev-parse HEAD)
revision_tmp="${revision_file}.tmp.$$"
printf '%s\n' "$revision" >"$revision_tmp"
mv -- "$revision_tmp" "$revision_file"
printf 'lab_checkout_ready=true revision=%s path=%s\n' "$revision" "$checkout_dir"
