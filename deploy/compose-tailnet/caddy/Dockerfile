# Derived from caddy:2-alpine. The only change is stripping the POSIX file
# capability from /usr/bin/caddy.
#
# Why this exists:
#   The upstream caddy:2-alpine binary ships with `cap_net_bind_service=ep`
#   set as a file capability. The `e` (effective) bit means the kernel
#   requires that capability in the container's bounding set at execve()
#   time — even if the binary never actually binds a privileged port.
#   With `cap_drop: [ALL]` in docker-compose.yml the bounding set is empty,
#   so exec fails with `exec /usr/bin/caddy: operation not permitted`
#   before main() runs.
#
#   Our deployment binds the high port 9787 only (Pattern Y
#   single-listener), so the cap is genuinely unused. Stripping it at
#   image-build lets us run with a true zero-capability container
#   instead of carrying NET_BIND_SERVICE solely to satisfy the kernel
#   exec check.
#
# Pinned to a specific patch version (matches the ollama pinning pattern in
# docker-compose.yml). `2-alpine` is a floating tag within 2.x and would
# auto-bump on every `--pull` build; for a perimeter container we want
# deliberate, reviewed upgrades. Bump when re-validating the perimeter and
# re-run the build (the post-strip getcap check will fail loudly if caddy
# ever moves the binary or changes its fcap state).
FROM caddy:2.11.3-alpine

# libcap-utils provides setcap/getcap. apk is in the upstream image.
# Remove the cap, drop the tooling, and verify (the verify step is the
# canary — if the binary path changed or fcaps are gone, the build still
# succeeds; this RUN exits non-zero on unexpected state).
RUN apk add --no-cache libcap \
 && setcap -r /usr/bin/caddy \
 && [ -z "$(getcap /usr/bin/caddy)" ] \
 && apk del libcap
