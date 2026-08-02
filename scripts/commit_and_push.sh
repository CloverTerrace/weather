#!/usr/bin/env bash
# Commits and pushes data/weather.json + data/history.json if they changed.
# Meant to run on a short interval (systemd timer), decoupled from how often
# the gateway actually pushes new readings -- so we get frequent updates on
# the live site without spamming git with a commit per reading.
set -euo pipefail

REPO_DIR="${WEATHER_REPO_DIR:?WEATHER_REPO_DIR must be set}"
cd "$REPO_DIR"

git add data/weather.json data/history.json

if git diff --cached --quiet; then
  exit 0
fi

git commit -m "Live weather update $(date -u +%FT%TZ) [skip ci]" --quiet

# Pick up any fallback commits pushed by the GitHub Actions watchdog while
# this box was offline, then push ours on top. On conflict, our local data
# wins -- it's the freshest source once we're back online.
if ! git pull --rebase -X theirs --autostash --quiet; then
  echo "WARNING: rebase failed even with -X theirs; leaving commit local for next run" >&2
  git rebase --abort || true
  exit 1
fi

git push --quiet
