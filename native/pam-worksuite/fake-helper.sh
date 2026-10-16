#!/bin/sh
# Stand-in for worksuite-pam-directory in test.sh: logs argv, environment and stdin (hex), then answers by password.
out="${0%/*}/out"
printf '%s\n' "$*" >> "$out/argv"
env | sort > "$out/env"
secret=$(cat | tr -d '\0')
printf '%s\n' "$secret" >> "$out/stdin"
case "$secret" in
  good) exit 0 ;;
  mfa) exit 10 ;;
  mfa123456) exit 0 ;;
  expired) exit 11 ;;
  notdir) exit 12 ;;
  *) exit 1 ;;
esac
