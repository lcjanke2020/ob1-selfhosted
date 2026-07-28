# Alerting when metadata extraction degrades

The metadata extractor degrades in three ways, and every one of them is
announced as a single line on the mcp container's **stderr** — which nobody
reads.
The worst of the three can mean **a thought's full text left your network**
(whether it did depends on where `FALLBACK_CHAT_API_BASE` points). The
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
| `primary endpoint failed` | Primary-path health warning — fires even when the fallback then rescues the capture, and covers every primary failure mode alike: connectivity errors, timeouts, non-2xx responses, unparseable output, schema-invalid metadata (see the verification note at the end of the [GPU-qube transport doc](../deploy/qubes/gpu-offload-transport.md)). On a deployment that keeps a resident local model (transport doc §6–7), recurring firings deserve a diagnosis — a broken residency guarantee (§6) is one field-observed cause, not the conclusion. | normal |

All three are `console.warn` lines, which Deno emits on **stderr**; only the
healthy `classified via primary endpoint` confirmation goes to stdout. The
sketch below sees them because `docker logs` replays the container's stderr
onto its own and the `2>&1` merges it into the scanned text — that redirect is
load-bearing, not error plumbing. If you adapt the sketch to anything that
splits the streams — `docker logs` piped without `2>&1`, journald forwarding,
a log shipper — make sure the stderr leg survives, or the monitor goes silent
on exactly the lines it exists to catch.

## Alert content policy

The alert says **that** captures degraded and **how many**, never **what** was
captured. What leaves the host is exactly: a fixed title, an operator-chosen
deployment label, three integers, and the time window — no thought content,
and no infrastructure identifiers either. Hostnames and container names count
as identifiers: the notification service is a third party, and handing it your
topology in the message body is a smaller cousin of the leak this monitor
watches for. The sketch uses `$LABEL` (default `ob1`, override with
`OB1_MONITOR_LABEL`) everywhere a machine or container name would be tempting.
An alert body quoting the thought would recreate the leak outright in a second
channel.

The counts are labeled honestly: the push says `fallback=`, not "off-box",
because whether a fallback classification left your network depends entirely
on where `FALLBACK_CHAT_API_BASE` points — the monitor can't see that, so it
doesn't claim it.

## Anti-spam, and failing loudly

- **First occurrence alerts immediately; further events accumulate** and roll
  up no more often than every 30 minutes. When the primary is down, *every*
  capture degrades — one push plus periodic rollups, not one push per capture.
- **A failed send carries its counts forward** into the next attempt rather
  than dropping them.
- **A monitor that cannot see is itself an alert**: if the container log can't
  be read, send a "monitor is blind" notification instead of silently
  skipping — throttled to the same rollup cadence (a dead container is one
  push per rollup period, not one per timer tick), and **without advancing the
  scan cursor**, so the unread window is scanned once visibility returns.
  Fail-alert, never fail-silent.
- **The cursor and the counts move together.** Scan position and pending
  counts live in one atomically-replaced state record, committed *before* any
  send — so a crash or failed send at any point can at worst repeat an alert,
  never lose events that were already read.

## Sketch: bash + systemd user timer

Secrets live in two `0600` files outside any repo —
`~/.config/ob1-metadata-monitor/pushover-token` (the application API token)
and `…/pushover-user` (the user key). Create them so the values never touch
shell history or argv, and **without a trailing newline** — the curl
`-F name=<file` form sends the file bytes *verbatim*, so a newline appended
by `echo` or an editor becomes part of the credential and every send fails:

```bash
umask 077
mkdir -p ~/.config/ob1-metadata-monitor
# paste each value at the (silent) prompt; printf %s writes no trailing newline
read -rs t && printf %s "$t" > ~/.config/ob1-metadata-monitor/pushover-token; unset t
read -rs u && printf %s "$u" > ~/.config/ob1-metadata-monitor/pushover-user; unset u
```

The same `-F name=<file` form keeps the values out of argv at send time
(`/proc/*/cmdline` is world-readable), and the script below refuses to run if
either file's mode is anything but `0600`.

`~/.local/bin/ob1-metadata-monitor.sh`:

```bash
#!/bin/bash
set -u
CONTAINER="${OB1_MCP_CONTAINER:-<mcp-container-name>}"   # e.g. from `docker ps`
LABEL="${OB1_MONITOR_LABEL:-ob1}"  # non-identifying deployment label for alert bodies
STATE_DIR="$HOME/.local/state/ob1-metadata-monitor"
CONF_DIR="$HOME/.config/ob1-metadata-monitor"
API_URL="https://api.pushover.net/1/messages.json"
ROLLUP_SECS=1800

mkdir -p "$STATE_DIR"
# One atomically-replaced record: scan cursor, last-alert time, pending counts.
# A single file means a crash can never separate the cursor from the counts.
STATE_FILE="$STATE_DIR/state"  # "<cursor-rfc3339> <last-alert-epoch> <fallback> <stub> <primaryfail>"

now_epoch=$(date +%s)
now_rfc=$(date -u +%Y-%m-%dT%H:%M:%SZ)

for f in "$CONF_DIR/pushover-token" "$CONF_DIR/pushover-user"; do
  if [[ ! -r "$f" ]]; then
    echo "ERROR: missing $f (see setup above: one value, no trailing newline)" >&2
    exit 1
  fi
  mode=$(stat -c %a "$f")
  if [[ "$mode" != "600" ]]; then
    echo "ERROR: $f is mode $mode, want 0600" >&2
    exit 1
  fi
done

send_pushover() { # $1=title $2=message $3=priority
  curl -sf --max-time 20 "$API_URL" \
    -F "token=<$CONF_DIR/pushover-token" -F "user=<$CONF_DIR/pushover-user" \
    -F "title=$1" -F "message=$2" -F "priority=${3:-0}" >/dev/null
}

write_state() { # $1=cursor $2=last_alert $3..$5=counts — tmp+mv, never half-written
  printf '%s %s %s %s %s\n' "$1" "$2" "$3" "$4" "$5" > "$STATE_FILE.tmp" &&
    mv -f "$STATE_FILE.tmp" "$STATE_FILE"
}

cursor=""; last_alert=0; pf=0; ps=0; pp=0
[[ -r "$STATE_FILE" ]] && { read -r cursor last_alert pf ps pp < "$STATE_FILE" || true; }
: "${cursor:=$(date -u -d "5 minutes ago" +%Y-%m-%dT%H:%M:%SZ)}"
: "${last_alert:=0}" "${pf:=0}" "${ps:=0}" "${pp:=0}"

# Closed window [cursor, now): --until keeps consecutive windows exact, so a
# line that lands while the scan runs is counted once, in the next window.
# The 2>&1 is load-bearing: the trigger lines are on the container's STDERR
# (see "The trigger lines" above), which docker logs replays on its stderr.
if ! logs=$(docker logs --since "$cursor" --until "$now_rfc" "$CONTAINER" 2>&1); then
  # Monitor is blind. The cursor does NOT advance — the unread window will be
  # scanned when visibility returns. Throttled like any other alert: a dead
  # container is one push per rollup period, not one per five-minute tick.
  if (( now_epoch - last_alert >= ROLLUP_SECS )); then
    if send_pushover "OB1 metadata monitor" \
        "$LABEL: cannot read the mcp container's logs since $cursor — monitor is blind" 1; then
      write_state "$cursor" "$now_epoch" "$pf" "$ps" "$pp"
    else
      echo "ERROR: pushover send failed while blind" >&2
      exit 1
    fi
  fi
  exit 0
fi

fallback=$(grep -c "classified via FALLBACK endpoint" <<<"$logs") || true
stub=$(grep -c "stamping uncategorized stub" <<<"$logs") || true
primfail=$(grep -c "primary endpoint failed" <<<"$logs") || true

pf=$((pf + fallback)); ps=$((ps + stub)); pp=$((pp + primfail))

# Commit cursor + counts together BEFORE any send: from here a crash or failed
# send can at worst repeat an alert — it can no longer lose counted events.
write_state "$now_rfc" "$last_alert" "$pf" "$ps" "$pp"

(( pf + ps + pp == 0 )) && exit 0

if (( now_epoch - last_alert >= ROLLUP_SECS )); then
  msg="$LABEL: capture degradation — fallback=$pf, stub=$ps, primary-fail=$pp since last alert. No content included."
  # fallback may or may not be off-box (that's where FALLBACK_CHAT_API_BASE
  # points); priority-1 errs on the loud side either way.
  prio=0; (( pf > 0 )) && prio=1
  if send_pushover "OB1 metadata degraded" "$msg" "$prio"; then
    write_state "$now_rfc" "$now_epoch" 0 0 0
  else
    echo "ERROR: pushover send failed; counts carried forward" >&2
    exit 1
  fi
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
holds a past degradation, replace the first field (the scan cursor) of
`~/.local/state/ob1-metadata-monitor/state` with an earlier RFC3339 timestamp
and run the script once — it will count the real lines and send a real push.
Otherwise point `CHAT_API_BASE` at a dead port for one capture and restore it.

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
