#!/bin/bash
# Forward <this-qube's-own-IP>:5432 → the db qube's Postgres (127.0.0.1:5432)
# over qubes.ConnectTCP.
#
# DB_HOST in this qube's .env points HERE instead of at a db-qube network
# address: the db qube has no network-facing Postgres listener at all — its
# cluster binds loopback only (db-qube/postgresql.local.conf), and dom0 policy
# gates this channel (explicit destination, and autostart=no so a connection
# can never boot a halted db qube as a side effect; start it deliberately):
#
#   qubes.ConnectTCP +5432 <app-qube> <db-qube> allow autostart=no
#
# Bound to the qube's own IP (`qubesdb-read /qubes-ip`) so the ROOTLESS mcp
# container can reach it: under rootless docker, container → own-host-IP
# traffic rides slirp4netns and arrives on lo, which the qubes input chain
# accepts — no custom-input rule needed. eth0/tailscale peers are covered by
# the qubes input default-drop (no accept rule exists for :5432), so only this
# qube's own workloads can use the forwarder; dom0 policy names the one
# permitted destination, and the db qube's pg_hba + scram gate what a
# connection can do. Host-side clients — the encrypted backup, the auth-events
# rollup, admin psql — use the same address.
#
# Install at /rw/config/ob1-db-forward.sh (chmod +x — the unit runs the file
# directly as ExecStart). socat must be installed in this qube's TEMPLATE
# (/usr is template-provided; an AppVM-local install vanishes on reboot).
# The companion unit ob1-db-forward.service is restaged from rc.local each
# boot. See README.md § The app→db hop.

# >>> EDIT THIS: the db qube's name (the qrexec ConnectTCP destination —
#     must match the dom0 policy line's destination exactly).
DB_QUBE="<db-qube>"

set -e
BIND_IP="$(qubesdb-read /qubes-ip)"
exec socat TCP-LISTEN:5432,fork,reuseaddr,bind="${BIND_IP}" \
  EXEC:"/usr/bin/qrexec-client-vm ${DB_QUBE} qubes.ConnectTCP+5432"
