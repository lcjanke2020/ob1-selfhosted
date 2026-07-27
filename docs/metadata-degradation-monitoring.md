# Alerting when metadata extraction degrades

The metadata extractor degrades in three ways, and every one of them is
announced as a single line on the mcp container's stdout — which nobody reads.
The worst of the three means **a thought's full text left your network**. The
server intentionally never blocks a capture on classification, so without an
operator-side alert the only "detection" is noticing, days later, that topic
filters miss recent thoughts — or that your GPU's fans stayed quiet when they
shouldn't have.

Until a durable in-server signal exists (see [Where this should go
eventually](#where-this-should-go-eventually)), a small log-scraping monitor
gives the operator a push notification within minutes. This doc sketches one
against [Pushover](https://pushover.net/); [ntfy](https://ntfy.sh/) is
analogous. It was built and live-fire tested on the Qubes three-qube
deployment, but nothing in it is Qubes-specific — any host that can run
`docker logs` and a systemd user timer can carry it.

## The trigger lines

All three come from [`server/metadata.ts`](../server/metadata.ts) and contain
no thought content; grep for the stable substrings shown.

| log line (substring) | what it means | suggested priority |
|---|---|---|
| `classified via FALLBACK endpoint` | Content may have left your network (depends on `FALLBACK_CHAT_API_BASE`). The headline event. | high |
| `stamping uncategorized stub` | Every configured endpoint failed; the thought is stored with placeholder metadata and won't surface under topic/type filters until backfilled. | normal |
| `primary endpoint failed` | Early warning — fires even when the fallback then rescues the capture. On a deployment that keeps a resident local model (see the [GPU-qube transport doc](../deploy/qubes/gpu-offload-transport.md), §6–7), this firing *at all* means the residency guarantees are not holding. | normal |

## Alert content policy

The alert says **that** captures degraded and **how many**, never **what** was
captured: counts, hostname, and the time window only. An alert body quoting
the thought would recreate the leak in a second channel — the notification
service is exactly the kind of third party the primary/local path exists to
keep content away from.

## Anti-spam, and failing loudly

- **First occurrence alerts immediately; further events accumulate** and roll
  up no more often than every 30 minutes. When the primary is down, *every*
  capture degrades — one push plus periodic rollups, not one push per capture.
- **A failed send carries its counts forward** into the next attempt rather
  than dropping them.
- **A monitor that cannot see is itself an alert**: if the container log can't
  be read, send a "monitor is blind" notification instead of silently
  skipping. Fail-alert, never fail-silent.

## Sketch: bash + systemd user timer

Secrets live in two `0600` files outside any repo —
`~/.config/ob1-metadata-monitor/pushover-token` (the application API token)
and `…/pushover-user` (the user key). The curl `-F name=<file` form reads the
value from the file, keeping secrets out of argv (`/proc/*/cmdline` is
world-readable).

`~/.local/bin/ob1-metadata-monitor.sh`:

```bash
#!/bin/bash
set -u
CONTAINER="${OB1_MCP_CONTAINER:-<mcp-container-name>}"   # e.g. from `docker ps`
STATE_DIR="$HOME/.local/state/ob1-metadata-monitor"
CONF_DIR="$HOME/.config/ob1-metadata-monitor"
API_URL="https://api.pushover.net/1/messages.json"
ROLLUP_SECS=1800

mkdir -p "$STATE_DIR"
LAST_SCAN_FILE="$STATE_DIR/last-scan"    # RFC3339 upper bound of last scanned window
LAST_ALERT_FILE="$STATE_DIR/last-alert"  # epoch seconds of last alert sent
PENDING_FILE="$STATE_DIR/pending-counts" # "fallback stub primaryfail" awaiting rollup

now_epoch=$(date +%s)
now_rfc=$(date -u +%Y-%m-%dT%H:%M:%SZ)

if [[ ! -r "$CONF_DIR/pushover-token" || ! -r "$CONF_DIR/pushover-user" ]]; then
  echo "ERROR: missing $CONF_DIR/pushover-{token,user} (0600, one value per file)" >&2
  exit 1
fi

send_pushover() { # $1=title $2=message $3=priority
  curl -sf --max-time 20 "$API_URL" \
    -F "token=<$CONF_DIR/pushover-token" -F "user=<$CONF_DIR/pushover-user" \
    -F "title=$1" -F "message=$2" -F "priority=${3:-0}" >/dev/null
}

since=$(cat "$LAST_SCAN_FILE" 2>/dev/null || true)
[[ -z "$since" ]] && since=$(date -u -d "5 minutes ago" +%Y-%m-%dT%H:%M:%SZ)

if ! logs=$(docker logs --since "$since" "$CONTAINER" 2>&1); then
  send_pushover "OB1 metadata monitor" \
    "cannot read $CONTAINER logs on $(hostname) since $since — monitor is blind" 1 || exit 1
  echo "$now_rfc" > "$LAST_SCAN_FILE"
  exit 0
fi
echo "$now_rfc" > "$LAST_SCAN_FILE"

fallback=$(grep -c "classified via FALLBACK endpoint" <<<"$logs") || true
stub=$(grep -c "stamping uncategorized stub" <<<"$logs") || true
primfail=$(grep -c "primary endpoint failed" <<<"$logs") || true

if [[ -f "$PENDING_FILE" ]]; then
  read -r pf ps pp < "$PENDING_FILE"
else
  pf=0; ps=0; pp=0
fi
pf=$((pf + fallback)); ps=$((ps + stub)); pp=$((pp + primfail))
(( pf + ps + pp == 0 )) && exit 0

last_alert=$(cat "$LAST_ALERT_FILE" 2>/dev/null || echo 0)
if (( now_epoch - last_alert >= ROLLUP_SECS )); then
  msg="capture degradation on $(hostname): off-box fallback=$pf, stub=$ps, primary-fail=$pp since last alert. No content included."
  prio=0; (( pf > 0 )) && prio=1
  if send_pushover "OB1 metadata degraded" "$msg" "$prio"; then
    echo "$now_epoch" > "$LAST_ALERT_FILE"
    rm -f "$PENDING_FILE"
  else
    printf '%s %s %s\n' "$pf" "$ps" "$pp" > "$PENDING_FILE"
    echo "ERROR: pushover send failed; counts carried forward" >&2
    exit 1
  fi
else
  printf '%s %s %s\n' "$pf" "$ps" "$pp" > "$PENDING_FILE"
fi
```

`~/.config/systemd/user/ob1-metadata-monitor.service`:

```ini
[Unit]
Description=OB1: alert on metadata capture degradation (Pushover)

[Service]
Type=oneshot
ExecStart=%h/.local/bin/ob1-metadata-monitor.sh
```

`~/.config/systemd/user/ob1-metadata-monitor.timer`:

```ini
[Unit]
Description=OB1: metadata degradation monitor every 5 min

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
AccuracySec=30s

[Install]
WantedBy=timers.target
```

Enable (as the user that can run `docker logs`, no root needed):

```sh
loginctl enable-linger "$USER"   # user timers must outlive login sessions (needs auth once)
systemctl --user daemon-reload
systemctl --user enable --now ob1-metadata-monitor.timer
```

To verify end-to-end without inducing a failure: if the container log still
holds a past degradation, write an earlier RFC3339 timestamp into
`~/.local/state/ob1-metadata-monitor/last-scan` and run the script once — it
will count the real lines and send a real push. Otherwise point
`CHAT_API_BASE` at a dead port for one capture and restore it.

Two caveats worth knowing:

- **Container recreation wipes `docker logs` history** (a deploy that rebuilds
  the container, not a mere restart). The monitor only scans small forward
  windows, so at worst one window of events is lost — but it also means the
  log is not an audit trail. See the next section.
- **Egress**: the monitor runs on the *host*, so container-scoped egress
  firewalls (e.g. a `DOCKER-USER` chain) don't apply to it — but check the
  host's own path once: `curl -sI https://api.pushover.net` from the account
  that will run the timer.

## Where this should go eventually

Log scraping is the cheap interim, not the destination. Its source of truth
resets on every container replacement, and nothing durable records *which*
thoughts were classified by *which* endpoint — so "which of my thoughts have
ever been sent off-box?" is unanswerable after the fact. The better shape,
sketched here so the interim doesn't calcify:

- the server records each degradation event durably (the auth-audit table
  pattern already in [`db/`](../db/) is the in-repo precedent), and/or stamps
  the classifying endpoint into the thought's stored metadata at capture time;
- the alerter reads that record instead of stdout, and grows pluggable
  delivery (Pushover / ntfy / SMTP) rather than one hardcoded transport;
- an operator-selected fallback policy (`off` / `alert` / `allow`) makes the
  privacy stance explicit instead of emergent from which env vars happen to be
  set — with `alert` refusing to boot when no channel is configured.

Related reading: [`docs/why-local-only.md`](why-local-only.md) for why the
fallback exists at all, and the [GPU-qube transport
doc](../deploy/qubes/gpu-offload-transport.md) §6–7 for keeping the primary
healthy enough that this monitor stays quiet.
