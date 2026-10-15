#!/bin/sh
# Build the WorkSuite OS .debs from a clean copy of the working tree. Output: packaging/out/*.deb
# Usage: packaging/build-debs.sh [-d]   (-d skips the build-dependency check, e.g. when Node 22 isn't a dpkg package)
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/src"
# Tracked and new (not ignored) files that exist: no node_modules, build output or local state.
cd "$here"
git ls-files --cached --others --exclude-standard | while IFS= read -r f; do [ -f "$f" ] && printf '%s\n' "$f"; done \
  | tr '\n' '\0' | xargs -0 cp --parents -t "$work/src"
cp -a "$here/packaging/debian" "$work/src/debian"
cd "$work/src"
dpkg-buildpackage -b -us -uc "$@"
mkdir -p "$here/packaging/out"
cp "$work"/*.deb "$here/packaging/out/"
ls -l "$here/packaging/out"
