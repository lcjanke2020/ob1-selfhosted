#!/bin/bash
# Forward <this-qube's-own-IP>:18787 → the app qube's mcp (127.0.0.1:8787)
# over qubes.ConnectTCP.
#
# Caddy's MCP_UPSTREAM points HERE instead of at an app-qube network address:
# the app qube has no network-facing mcp listener at all — its mcp publishes
# loopback only, and dom0 policy gates this channel (explicit destination, and
# autostart=no so a call can never boot a halted app qube as a side effect):
#
#   qubes.ConnectTCP +8787 <ingress-qube> <app-qube> allow autostart=no
#
# Bound to the qube's own IP (`qubesdb-read /qubes-ip`) so the ROOTLESS caddy
# container can reach it: under rootless docker, container → own-host-IP
# traffic rides slirp4netns and arrives on lo, which the qubes input chain
# accepts — no custom-input rule needed. eth0/tailscale peers are covered by
# the qubes input default-drop (no accept rule exists for :18787), so only
# this qube's own workloads can use the forwarder; dom0 policy and mcp's
# OAuth door gate what a connection can do.
#
# Install at /rw/config/ob1-mcp-forward.sh (chmod +x — the unit runs the file
# directly as ExecStart). socat must be installed in this qube's TEMPLATE
# (/usr is template-provided; an AppVM-local install vanishes on reboot).
# The companion unit ob1-mcp-forward.service is restaged from rc.local each
# boot. See README.md § The ingress→app hop.
set -e
BIND_IP="$(qubesdb-read /qubes-ip)"
exec socat TCP-LISTEN:18787,fork,reuseaddr,bind="${BIND_IP}" \
  EXEC:'/usr/bin/qrexec-client-vm <app-qube> qubes.ConnectTCP+8787'
