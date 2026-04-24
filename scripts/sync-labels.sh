#!/usr/bin/env bash
# sync-labels.sh — Apply unified labels to all Zenith repos
#
# Usage:
#   ./scripts/sync-labels.sh              # sync all repos
#   ./scripts/sync-labels.sh bamboo       # sync only bamboo
#   ./scripts/sync-labels.sh --dry-run    # preview without changes
#
# Requires: gh (authenticated with repo scope)

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LABELS_FILE="$SCRIPT_DIR/../.github/labels.tsv"
DRY_RUN=false
TARGET=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    *) TARGET="$arg" ;;
  esac
done

if [[ ! -f "$LABELS_FILE" ]]; then
  echo "Error: $LABELS_FILE not found"
  exit 1
fi

# Module name → owner/repo mapping
get_repo() {
  case "$1" in
    zenith)   echo "bigduu/Zenith" ;;
    bamboo)   echo "bigduu/Bamboo-agent" ;;
    lotus)    echo "bigduu/Lotus" ;;
    bodhi)    echo "bigduu/Bodhi" ;;
    pavilion) echo "bigduu/Pavilion" ;;
    *)        echo "" ;;
  esac
}

ALL_MODULES="zenith bamboo lotus bodhi pavilion"

sync_labels() {
  local repo="$1"
  echo ""
  echo "=== Syncing labels for $repo ==="

  while IFS=$'\t' read -r name color description; do
    [[ "$name" =~ ^# ]] && continue
    [[ -z "$name" ]] && continue

    if $DRY_RUN; then
      echo "  [dry-run] $name ($color) — $description"
    else
      if gh label create "$name" \
        --repo "$repo" \
        --color "$color" \
        --description "$description" \
        --force 2>/dev/null; then
        echo "  ✓ $name"
      else
        echo "  ✗ $name (failed)"
      fi
    fi
  done < "$LABELS_FILE"
}

if [[ -n "$TARGET" ]]; then
  repo="$(get_repo "$TARGET")"
  if [[ -z "$repo" ]]; then
    echo "Error: Unknown module '$TARGET'"
    echo "Available: $ALL_MODULES"
    exit 1
  fi
  sync_labels "$repo"
else
  for mod in $ALL_MODULES; do
    repo="$(get_repo "$mod")"
    sync_labels "$repo"
  done
fi

echo ""
echo "Done."
