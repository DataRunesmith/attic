#!/bin/sh
# Points git at .githooks, unless this clone already uses another hooks folder.
set -eu
current=$(git config --get core.hooksPath || true)
if [ -n "$current" ] && [ "$current" != ".githooks" ]; then
  echo "core.hooksPath is already set to '$current'; not changing it." >&2
  echo "Call .githooks/pre-push from your hooks, or unset it and run again." >&2
  exit 1
fi
git config core.hooksPath .githooks
