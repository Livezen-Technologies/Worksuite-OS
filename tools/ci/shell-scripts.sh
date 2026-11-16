#!/bin/bash
# Lists the tracked shell scripts, NUL-separated: *.sh files and any file whose first line is a sh/bash/dash shebang.
# CI runs shellcheck on them: tools/ci/shell-scripts.sh | xargs -0 shellcheck
set -eu
cd "$(dirname "$0")/../.."
git ls-files -z | while IFS= read -r -d '' f; do
	[ -f "$f" ] || continue
	case "$f" in
	*.sh) printf '%s\0' "$f"; continue ;;
	esac
	if head -n1 "$f" 2>/dev/null | grep -qE '^#!.*[/ ](ba|da)?sh( |$)'; then
		printf '%s\0' "$f"
	fi
done
