#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# omni-sync.sh — Workspace Load Balancer & GitHub Sync Tool
#
# Solves Arena workspace snapshot limits (10,000 files / 128 MB max).
# Keeps local workspace lean (< 7,000 files, < 110 MB) via shallow fetch
# and sparse-checkout while using GitHub as the persistent remote store.
#
# Usage:
#   ./bin/omni-sync.sh balance   # Apply sparse-checkout & prune bloat (keeps repo < 7k files)
#   ./bin/omni-sync.sh status    # Check file count, size, and quota health
#   ./bin/omni-sync.sh push      # Push current branch to GitHub
#   ./bin/omni-sync.sh pull      # Pull latest branch from GitHub safely
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAX_FILES=10000
MAX_MB=128

log()  { echo "[omni-sync] $*"; }
warn() { echo "[omni-sync] WARNING: $*" >&2; }

cmd="${1:-status}"

get_file_count() {
  find "$REPO_DIR" -type f | wc -l
}

get_disk_mb() {
  du -sm "$REPO_DIR" | cut -f1
}

case "$cmd" in
  status)
    cd "$REPO_DIR"
    branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
    commit=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
    files=$(get_file_count)
    mb=$(get_disk_mb)

    log "=== OmniRoute Workspace Health Status ==="
    log "Branch: $branch @ $commit"
    log "Files:  $files / $MAX_FILES limit"
    log "Disk:   ${mb} MB / ${MAX_MB} MB limit"

    if [ "$files" -gt "$MAX_FILES" ] || [ "$mb" -gt "$MAX_MB" ]; then
      warn "Workspace exceeds Arena snapshot limits! Run './bin/omni-sync.sh balance' to reduce load."
    else
      log "Status: HEALTHY (well within snapshot limits)"
    fi
    ;;

  balance)
    cd "$REPO_DIR"
    log "Applying sparse-checkout to exclude heavy tests and translation files..."
    git sparse-checkout init --cone 2>/dev/null || true
    git sparse-checkout set --no-cone '/*' '!/tests' '!/docs/i18n'
    
    files=$(get_file_count)
    mb=$(get_disk_mb)
    log "Balance complete. Files: $files (limit: $MAX_FILES), Size: ${mb} MB (limit: $MAX_MB)."
    ;;

  push)
    cd "$REPO_DIR"
    branch=$(git rev-parse --abbrev-ref HEAD)
    target_branch="${2:-$branch}"
    log "Pushing branch '$branch' to origin/$target_branch..."
    git push origin "$branch:$target_branch"
    log "Push successful."
    ;;

  pull)
    cd "$REPO_DIR"
    branch=$(git rev-parse --abbrev-ref HEAD)
    target_branch="${2:-$branch}"
    log "Pulling branch '$target_branch' from origin..."
    git pull --depth 1 origin "$target_branch"
    log "Pull complete. Running balance to maintain low load..."
    "$0" balance
    ;;

  full)
    cd "$REPO_DIR"
    log "Disabling sparse-checkout (restoring all files)..."
    git sparse-checkout disable
    files=$(get_file_count)
    mb=$(get_disk_mb)
    log "All files restored. Files: $files, Size: ${mb} MB."
    ;;

  *)
    echo "Usage: $0 {status|balance|push|pull|full}"
    exit 1
    ;;
esac
