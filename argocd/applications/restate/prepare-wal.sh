#!/bin/sh
set -eu

store=$1
wal=$2
identity=.restate-source-identity

mkdir -p "$wal"

if [ -f "$wal/$identity" ]; then
  [ ! -s "$wal/$identity" ] || cmp "$store/IDENTITY" "$wal/$identity"
  exit 0
fi

# A failed seed can retry; a completed seed must never replay old WAL over newer writes.
if [ -f "$wal/.initializing" ]; then
  if [ -s "$wal/.initializing" ]; then
    cmp "$store/IDENTITY" "$wal/.initializing"
  else
    test ! -e "$store/IDENTITY"
  fi
elif [ -n "$(find "$wal" -mindepth 1 -maxdepth 1 ! -name .identity.tmp -print -quit)" ]; then
  echo 'Refusing an unrecognized WAL directory' >&2
  exit 1
else
  if [ -s "$store/IDENTITY" ]; then
    cp "$store/IDENTITY" "$wal/.identity.tmp"
  else
    if [ -d "$store" ] && [ -n "$(find "$store" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
      echo 'Refusing retained log storage without its RocksDB identity' >&2
      exit 1
    fi
    : > "$wal/.identity.tmp"
  fi
  mv "$wal/.identity.tmp" "$wal/.initializing"
fi
sync -f "$wal"

for file in "$store"/*.log; do
  [ -f "$file" ] || continue
  cp "$file" "$wal/"
done
if [ -d "$store/archive" ]; then
  mkdir -p "$wal/archive"
  cp -R "$store/archive/." "$wal/archive/"
fi
sync -f "$wal"
mv "$wal/.initializing" "$wal/$identity"
sync -f "$wal"
