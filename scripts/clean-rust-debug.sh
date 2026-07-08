#!/usr/bin/env bash
# Clean Rust DEBUG build artifacts across the zenith tree.
#
# Removes only */target/debug directories. target/release is never touched —
# nova's release binary is consumed as an MCP server and must survive cleanup.
#
# Usage:
#   scripts/clean-rust-debug.sh [--dry-run] [ROOT]
#
#   --dry-run   list what would be deleted and the space it would free, no rm
#   ROOT        directory to scan (default: the repo root containing scripts/)
set -euo pipefail

DRY_RUN=0
ROOT=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) ROOT="$arg" ;;
  esac
done
ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

if [[ ! -d "$ROOT" ]]; then
  echo "error: root directory not found: $ROOT" >&2
  exit 1
fi

echo "Scanning for target/debug under: $ROOT"

# -prune on matches so we don't descend into the huge trees we're about to
# delete; skip node_modules and .git for speed.
targets=()
while IFS= read -r dir; do
  targets+=("$dir")
done < <(find "$ROOT" \
    \( -name node_modules -o -name .git \) -prune -o \
    -type d -path '*/target/debug' -prune -print 2>/dev/null | sort)

if [[ ${#targets[@]} -eq 0 ]]; then
  echo "Nothing to clean."
  exit 0
fi

total_kb=0
for dir in "${targets[@]}"; do
  kb=$(du -sk "$dir" 2>/dev/null | awk '{print $1}')
  total_kb=$((total_kb + kb))
  printf '  %8.1f GB  %s\n' "$(echo "$kb" | awk '{printf "%.1f", $1/1048576}')" "$dir"
done
printf 'Total: %.1f GB in %d director%s\n' \
  "$(echo "$total_kb" | awk '{printf "%.1f", $1/1048576}')" \
  "${#targets[@]}" "$([[ ${#targets[@]} -eq 1 ]] && echo y || echo ies)"

if [[ $DRY_RUN -eq 1 ]]; then
  echo "(dry run — nothing deleted)"
  exit 0
fi

for dir in "${targets[@]}"; do
  # Belt and braces: refuse anything that isn't exactly a target/debug dir.
  case "$dir" in
    */target/debug) rm -rf "$dir" ;;
    *) echo "skipping unexpected path: $dir" >&2 ;;
  esac
done
echo "Done."
