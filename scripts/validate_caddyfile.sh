#!/usr/bin/env bash
# Validate the perimeter Caddyfile against the pinned Caddy image — the local
# companion to the CI gate in .github/workflows/caddy-validate.yml: same
# validation, same image-pinning guard (keep the extractor below in lockstep
# with the workflow's), plus stronger local sandboxing the CI runner doesn't
# need (staged single-file mount, --network none).
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
# read? Don't execute the PR's copy of this file — run the canonical
# repository's copy against the PR worktree. Attach trust to the repo URL,
# not to a remote name (in a fork checkout, `origin` is the fork), and
# disable hooks for the fetch: with this repo's recommended
# `core.hooksPath .githooks`, the hooks directory is branch-controlled, so
# the fetch itself would otherwise run the unread PR's hooks:
#   git -c core.hooksPath=/dev/null fetch https://github.com/lcjanke2020/ob1-selfhosted.git main
#   validator=$(git show FETCH_HEAD:scripts/validate_caddyfile.sh) && bash -c "$validator"
# (Not `bash <(git show …)`: a process-substitution failure doesn't propagate —
# bash would run an empty script and report success, silently skipping the
# validation. The && form fails closed if the extraction fails.)
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
