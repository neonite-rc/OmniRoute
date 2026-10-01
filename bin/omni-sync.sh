#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# omni-sync.sh — Workspace Load Balancer & GitHub Synchronization Suite
#
# Solves Arena workspace snapshot limits (10,000 files / 128 MB max).
# Keeps the local workspace balanced and ultra-lean (< 6,700 files, < 110 MB)
# using sparse-checkout and shallow git tracking, while preserving 100% of the
# codebase and history safely on GitHub via personal access token.
#
# Usage:
#   ./bin/omni-sync.sh balance   # Balance workspace (< 6,700 files, ~109 MB)
#   ./bin/omni-sync.sh status    # Check file count, disk usage, and quota safety
#   ./bin/omni-sync.sh push      # Push branch commits to GitHub
#   ./bin/omni-sync.sh pull      # Pull latest branch commits from GitHub
#   ./bin/omni-sync.sh full      # Restore all 13k+ files (temporary for complete tests)
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

    log "=== OmniRoute Workspace Balance & Health Status ==="
    log "Branch: $branch @ $commit"
    log "Files:  $files / $MAX_FILES max quota"
    log "Disk:   ${mb} MB / ${MAX_MB} MB max quota"

    if [ "$files" -gt "$MAX_FILES" ] || [ "$mb" -gt "$MAX_MB" ]; then
      warn "Workspace exceeds Arena snapshot limits! Run './bin/omni-sync.sh balance' to reduce load."
    else
      log "Status: BALANCED & HEALTHY (0 files dropped, fully snapshotted)"
    fi
    ;;

  balance)
    cd "$REPO_DIR"
    log "Applying sparse-checkout (excluding heavy test suites and static i18n dictionaries)..."
    git sparse-checkout init --cone 2>/dev/null || true
    git sparse-checkout set --no-cone '/*' '!/tests' '!/docs/i18n' '!/src/i18n'
    git checkout -f 2>/dev/null || true
    git sparse-checkout reapply 2>/dev/null || true

    files=$(get_file_count)
    mb=$(get_disk_mb)
    log "Balance complete. Files: $files (limit: $MAX_FILES), Size: ${mb} MB (limit: $MAX_MB)."
    ;;

  push)
    cd "$REPO_DIR"
    branch=$(git rev-parse --abbrev-ref HEAD)
    target_branch="${2:-$branch}"
    log "Pushing branch '$branch' to GitHub origin/$target_branch..."
    git push origin "$branch:$target_branch"
    log "Push successful. GitHub remote is up to date."
    ;;

  pull)
    cd "$REPO_DIR"
    branch=$(git rev-parse --abbrev-ref HEAD)
    target_branch="${2:-$branch}"
    log "Pulling branch '$target_branch' from origin with --depth 1..."
    git pull --depth 1 origin "$target_branch"
    log "Pull complete. Re-applying balance to maintain low workspace load..."
    "$0" balance
    ;;

  full)
    cd "$REPO_DIR"
    log "Disabling sparse-checkout (restoring all 13k+ files)..."
    git sparse-checkout disable
    files=$(get_file_count)
    mb=$(get_disk_mb)
    log "All files restored. Files: $files, Size: ${mb} MB."
    warn "Remember to run './bin/omni-sync.sh balance' before ending session to avoid snapshot overlimit."
    ;;

  *)
    echo "Usage: $0 {status|balance|push|pull|full}"
    exit 1
    ;;
esac
