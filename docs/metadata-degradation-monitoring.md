# Alerting when metadata extraction degrades

The metadata extractor has three operator-relevant degradation outcome classes,
and every event is announced on the mcp container's **stderr** — which nobody
reads. Primary-attempt failures additionally carry a reason-specific line so
endpoint availability and model-output quality no longer look identical. The
privacy-sensitive fallback class can mean **a thought's full text left your
network** (whether it did depends on where `FALLBACK_CHAT_API_BASE` points).
The server intentionally never blocks a capture on classification, so without
an operator-side alert the only "detection" is noticing, days later, that topic
filters miss recent thoughts — or that your GPU's fans stayed quiet when they
shouldn't have.

Until a durable in-server signal exists (see [Where this should go
eventually](#where-this-should-go-eventually)), a small log-scraping monitor
gives the operator a push notification within minutes. This doc sketches one
against [Pushover](https://pushover.net/); [ntfy](https://ntfy.sh/) is
analogous. An earlier revision was built and live-fire tested on the Qubes
three-qube deployment; the state protocol below was then hardened in review
(verified under a stub harness, not yet live-fired). Nothing in it is
Qubes-specific — any host that can run `docker logs` and a systemd user
timer can carry it.

## The trigger lines

All lines below come from [`server/metadata.ts`](../server/metadata.ts) and
contain no thought content; grep for the stable substrings shown.

| log line (substring) | what it means | suggested priority |
|---|---|---|
| `classified via FALLBACK endpoint` | Content may have left your network (depends on `FALLBACK_CHAT_API_BASE`). The headline event. | high |
| `stamping uncategorized stub` | Every configured endpoint failed; the thought is stored with placeholder metadata and won't surface under topic/type filters until backfilled. | normal |
| `primary endpoint failed (transport/timeout)` | The request could not complete. On a deployment that keeps a resident local model, recurring firings are an availability signal: diagnose reachability, cold starts, timeouts, and residency (see the [GPU-qube transport doc](../deploy/qubes/gpu-offload-transport.md) §6–7). | normal |
| `primary endpoint failed (non-2xx response)` | The endpoint was reachable but rejected or failed the request. The line appends the final HTTP status (for example, `— HTTP 401`) so authentication/configuration failures, rate limits, and server failures can be distinguished before consulting the endpoint's logs. | normal |
| `primary endpoint returned an invalid response` | The endpoint returned 2xx, but not a usable OpenAI-compatible completion envelope. | normal |
| `primary endpoint returned unparseable metadata` | The completion envelope was usable, but the model's content was not JSON. This is an output-quality signal, not an availability signal. | normal |
| `primary endpoint returned schema-invalid metadata` | The model returned JSON that failed the local runtime schema. A recurring rejection is a model-quality or compatibility regression; when fallback is configured it can systematically route capture content to that fallback. | high |

**Upgrade note:** if you deployed an earlier revision of the monitor sketch,
replace its `grep -c "primary endpoint failed"` expression when this server
change rolls out. The old expression counts only the two availability forms
and silently misses the three new `primary endpoint returned …` forms. The
fallback-classified and stub counters are unchanged.

The reference monitor deliberately aggregates all five primary failure forms
into one `primary-fail` counter. When schema rejection actually routes content
to a configured fallback, that capture also emits the high-priority
`classified via FALLBACK endpoint` line; without a fallback, it stubs locally
and remains a normal-priority quality event. That companion signal is why the
sketch does not need a second schema-only counter to honor the table's priority.

These are all `console.warn` lines, which Deno emits on **stderr**; only the
healthy `classified via primary endpoint` confirmation goes to stdout. The
sketch below sees them because `docker logs` replays the container's stderr
onto its own and the `2>&1` merges it into the scanned text — that redirect is
load-bearing, not error plumbing. If you adapt the sketch to anything that
splits the streams — `docker logs` piped without `2>&1`, journald forwarding, a
log shipper — make sure the stderr leg survives, or the monitor goes silent on
exactly the lines it exists to catch.

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
  skipping — throttled at the rollup cadence on its **own** stamp (a dead
  container is one push per rollup period, not one per timer tick, and
  neither alert class delays the other's first push), and **without advancing
  the scan cursor**, so the unread window is scanned once visibility returns.
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
# One atomically-replaced record: scan cursor, per-class last-alert times,
# pending counts. A single file means a crash can never separate the cursor
# from the counts. The blind stamp sits last so an older 5-field state file
# still parses (the missing field defaults to 0).
STATE_FILE="$STATE_DIR/state"  # "<cursor-rfc3339> <last-alert-epoch> <fallback> <stub> <primaryfail> <last-blind-epoch>"

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

write_state() { # $1=cursor $2=last_alert $3..$5=counts $6=last_blind — tmp+mv, never half-written
  printf '%s %s %s %s %s %s\n' "$1" "$2" "$3" "$4" "$5" "$6" > "$STATE_FILE.tmp" &&
    mv -f "$STATE_FILE.tmp" "$STATE_FILE"
}

cursor=""; last_alert=0; pf=0; ps=0; pp=0; last_blind=0
[[ -r "$STATE_FILE" ]] && { read -r cursor last_alert pf ps pp last_blind < "$STATE_FILE" || true; }
: "${cursor:=$(date -u -d "5 minutes ago" +%Y-%m-%dT%H:%M:%SZ)}"
: "${last_alert:=0}" "${pf:=0}" "${ps:=0}" "${pp:=0}" "${last_blind:=0}"

# Bounded window: --until stops the scan at now_rfc, so a line landing while
# the scan runs is picked up next run. Note docker includes events whose
# timestamp EQUALS either bound, so an event landing exactly on the stored
# bound can be counted in two adjacent scans — a rare duplicate, which is the
# preferred failure direction here.
# The 2>&1 is load-bearing: the trigger lines are on the container's STDERR
# (see "The trigger lines" above), which docker logs replays on its stderr.
if ! logs=$(docker logs --since "$cursor" --until "$now_rfc" "$CONTAINER" 2>&1); then
  # Monitor is blind. The cursor does NOT advance — the unread window will be
  # scanned when visibility returns. Throttled on its OWN stamp: a dead
  # container is one push per rollup period, not one per five-minute tick,
  # and a recent degradation alert never delays the first blind push (nor
  # vice versa).
  if (( now_epoch - last_blind >= ROLLUP_SECS )); then
    if send_pushover "OB1 metadata monitor" \
        "$LABEL: cannot read the mcp container's logs since $cursor — monitor is blind" 1; then
      write_state "$cursor" "$last_alert" "$pf" "$ps" "$pp" "$now_epoch"
    else
      echo "ERROR: pushover send failed while blind" >&2
      exit 1
    fi
  fi
  exit 0
fi

fallback=$(grep -c "classified via FALLBACK endpoint" <<<"$logs") || true
stub=$(grep -c "stamping uncategorized stub" <<<"$logs") || true
primfail=$(grep -Ec "primary endpoint (failed|returned (an invalid response|unparseable metadata|schema-invalid metadata))" <<<"$logs") || true

pf=$((pf + fallback)); ps=$((ps + stub)); pp=$((pp + primfail))

# Commit cursor + counts together BEFORE any send: from here a crash or failed
# send can at worst repeat an alert — it can no longer lose counted events.
write_state "$now_rfc" "$last_alert" "$pf" "$ps" "$pp" "$last_blind"

(( pf + ps + pp == 0 )) && exit 0

if (( now_epoch - last_alert >= ROLLUP_SECS )); then
  msg="$LABEL: capture degradation — fallback=$pf, stub=$ps, primary-fail=$pp since last alert. No content included."
  # fallback may or may not be off-box (that's where FALLBACK_CHAT_API_BASE
  # points); priority-1 errs on the loud side either way.
  prio=0; (( pf > 0 )) && prio=1
  if send_pushover "OB1 metadata degraded" "$msg" "$prio"; then
    write_state "$now_rfc" "$now_epoch" 0 0 0 "$last_blind"
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

Enable, as the account *already* authorized to access the Docker daemon — do
not grant Docker-socket access solely for this monitor (on rootful Docker,
`docker`-group membership is root-equivalent; rootless Docker is the genuinely
unprivileged case):

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
  the container, not a mere restart). Everything since the last *successful*
  scan is lost with it — normally one five-minute window, but a blind spell
  or a stopped timer stretches the unread interval, and a recreation during
  it takes the whole backlog. Either way the log is not an audit trail. See
  the next section.
- **Egress**: the monitor runs on the *host*, so container-scoped egress
  firewalls (e.g. a `DOCKER-USER` chain) don't apply to it — but check the
  host's own path once: `curl -sI https://api.pushover.net` from the account
  that will run the timer. On a Qubes deployment the knob that actually
  governs that path is the app qube's own Qubes-firewall egress policy —
  check there first if the probe fails.

## Where this should go eventually

Log scraping is the cheap interim, not the destination. Its source of truth
resets on every container replacement, and nothing durable records *which*
thoughts were classified by *which* endpoint — so "which of my thoughts have
ever been sent off-box?" is unanswerable after the fact. The better shape,
sketched here so the interim doesn't calcify:

- the server records each degradation event durably (the auth-audit table
  pattern already in [`db/`](../db/) is the in-repo precedent), and/or stamps
  the classifying endpoint into the thought's stored metadata at capture time;
- the alerter reads that record instead of scraping container logs, and grows
  pluggable
  delivery (Pushover / ntfy / SMTP) rather than one hardcoded transport;
- an operator-selected fallback policy (`off` / `alert` / `allow`) makes the
  privacy stance explicit instead of emergent from which env vars happen to be
  set — with `alert` refusing to boot when no channel is configured.

Related reading: [`docs/why-local-only.md`](why-local-only.md) for why the
fallback exists at all, and the [GPU-qube transport
doc](../deploy/qubes/gpu-offload-transport.md) §6–7 for keeping the primary
healthy enough that this monitor stays quiet.
