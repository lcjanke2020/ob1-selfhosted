#!/usr/bin/env bash
# Validate the perimeter Caddyfile against the pinned Caddy image — the local
# mirror of the CI gate in .github/workflows/caddy-validate.yml (keep the
# extractor below in lockstep with the workflow's).
#
# The checkout's FILES are treated as untrusted input:
#   - the image is restricted to an official, patch-pinned `caddy:` tag taken
#     from the perimeter Dockerfile's FROM line — a Dockerfile pointing at any
#     other registry or a floating tag fails loudly instead of running an
#     arbitrary image;
#   - only a staged throwaway COPY of the Caddyfile is mounted, never the
#     checkout — so nothing gitignored (deployment .env files) is exposed to
#     the container. The `:z` on the copy makes the mount work on
#     SELinux-enforcing hosts (Fedora/Qubes); the relabel hits the staged
#     copy, not your files;
#   - the container runs with --network none.
#
# THIS SCRIPT is not: it runs on your host with your permissions, so it is
# only as trustworthy as the ref it came from. Reviewing a PR you haven't
# read? Don't execute the PR's copy of this file — run the trusted one from
# main against the PR worktree:
#   bash <(git show origin/main:scripts/validate_caddyfile.sh)
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
DOCKERFILE="$ROOT/deploy/compose-tailnet/caddy/Dockerfile"
CADDYFILE="$ROOT/deploy/compose-tailnet/Caddyfile"

for f in "$DOCKERFILE" "$CADDYFILE"; do
  if [ ! -f "$f" ]; then
    echo "error: expected file $f is missing" >&2
    exit 1
  fi
done

# Same guarded extractor as caddy-validate.yml: official `caddy:` repo only,
# full major.minor.patch pin (optional -alpine/-slim/… variant suffix),
# floating tags like caddy:2 / caddy:2-alpine rejected.
CADDY_IMAGE=$(awk '$1 == "FROM" && $2 ~ /^caddy:[0-9]+[.][0-9]+[.][0-9]+[A-Za-z0-9._-]*$/ { print $2; exit }' "$DOCKERFILE")
if [ -z "$CADDY_IMAGE" ]; then
  echo "error: could not derive a pinned 'FROM caddy:<major.minor.patch>' image from $DOCKERFILE (floating tags and non-official registries are rejected)" >&2
  exit 1
fi

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp "$CADDYFILE" "$STAGE/Caddyfile"

echo "Validating $CADDYFILE with $CADDY_IMAGE"
docker run --rm --network none \
  -v "$STAGE/Caddyfile:/etc/caddy/Caddyfile:ro,z" \
  "$CADDY_IMAGE" \
  caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile
