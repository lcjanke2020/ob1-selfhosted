# Alerting when metadata extraction degrades

The metadata extractor has three operator-relevant degradation outcome classes:
primary failure, fallback classification, and uncategorized stub persistence.
The privacy-sensitive fallback class can mean **a thought's full text left your
network** (whether it did depends on where `FALLBACK_CHAT_API_BASE` points).
The server intentionally never blocks a capture on classification.

`METADATA_FALLBACK_POLICY` decides whether that fallback path may run: `off`
uses the local stub after a primary failure, `alert` permits fallback only with a
configured notification channel, and `allow` permits it without delivery. The
setting is required and has no default.

Server 1.16.0 makes these outcomes durable. Each degraded capture writes a
content-free audit record, every newly captured thought carries a server-owned
classifier stamp, and an optional Pushover/ntfy worker delivers
first-occurrence alerts plus periodic rollups from the database ledger. The
existing stderr lines stay stable for diagnosis and for older log-scraping
monitors, but container logs are no longer the source of truth.

## Durable audit trail

[`db/07-metadata-degradation.sql`](../db/07-metadata-degradation.sql) adds three
relations:

- `metadata_degradation_events` is append-only to the application role. One or
  more rows share a `capture_id` and point at the persisted `thought_id`. If a
  database owner later deletes that thought, the link becomes null while the
  content-free audit survives.
  Failure rows carry the finite reason from `server/metadata.ts` and the HTTP
  status for `non_2xx`; fallback/stub outcome rows make the three alert classes
  directly queryable. Endpoint model and base URL are retained for historical
  audit, but URL userinfo, query parameters, and fragments are stripped before
  insertion so those common credential-bearing components cannot enter the
  table. Do not put a secret in an endpoint path or model name; those fields are
  audit data and remain verbatim.
- `metadata_degradation_outbox` is a durable, content-free pending-delivery
  queue populated in the same transaction as history. Its `created_at` records
  queue age. The worker deletes only committed rows, so concurrent captures that
  commit out of sequence-number order cannot be skipped. A rollback restores a
  claimed row. With delivery disabled, rows intentionally remain queued for a
  later enablement or explicit owner discard.
- `metadata_degradation_notification_state` is a singleton pending-count,
  cooldown, first-occurrence, and latest delivery-attempt ledger. Workers lock
  it with `FOR UPDATE SKIP LOCKED`, so multiple server processes cannot send the
  same batch concurrently.

The thought itself receives versioned `metadata.metadata_extraction` data:

```json
{
  "schema_version": 1,
  "endpoint": "primary | fallback | stub",
  "model": "present for primary/fallback"
}
```

That client-visible JSON describes the latest capture of a deduplicated thought
without disclosing an internal classifier URL. Exact credential-scrubbed
destinations remain in the owner-visible event table. That table is the
application-append-only, capture-by-capture history, so use it for questions
about what happened before a later recapture:

```sql
-- Every thought capture classified by the configured fallback, including the
-- exact credential-scrubbed destination that was active at that time.
SELECT created_at, thought_id, endpoint_model, endpoint_base_url
FROM metadata_degradation_events
WHERE event_type = 'fallback_used'
ORDER BY created_at DESC;

-- Reason distribution for primary failures over the last seven days.
SELECT failure_reason, count(*)
FROM metadata_degradation_events
WHERE event_type = 'primary_failure'
  AND created_at >= now() - interval '7 days'
GROUP BY failure_reason
ORDER BY count(*) DESC;
```

The table deliberately contains no thought content. Intentionally disabled
extraction still stamps `endpoint: "stub"` on the thought but does not create a
degradation event or alert; only a configured path that actually fails produces
`stub_used`. There is no automatic retention window: the point is to preserve
the privacy audit across container replacement and configuration changes. It is
included in normal database backups.

With delivery enabled, successfully accounted-for queue rows are consumed. If
an operator deliberately does not need old stub-only history, the database
owner may then prune already-consumed rows without weakening the off-box audit:

```sql
DELETE FROM metadata_degradation_events AS event
WHERE event.event_type = 'stub_used'
  AND event.created_at < now() - interval '90 days'
  AND NOT EXISTS (
    SELECT 1 FROM metadata_degradation_outbox AS outbox
    WHERE outbox.event_id = event.id
  );
```

Never prune `fallback_used` if historical enumeration of off-box candidates is
required. Deleting an unconsumed event would cascade its outbox row and suppress
the corresponding alert, which is why the guard above is load-bearing.

When `METADATA_NOTIFY_CHANNELS` is blank, no worker consumes the outbox. This
preserves degradation events for delivery if notifications are enabled later,
but the pending queue grows with them. Inspect its depth and oldest age with:

```sql
SELECT count(*) AS pending, min(created_at) AS oldest_pending
FROM metadata_degradation_outbox;
```

An operator choosing permanent audit-only mode may explicitly discard old
delivery intent while retaining history:

```sql
DELETE FROM metadata_degradation_outbox
WHERE created_at < now() - interval '90 days';
```

That action is irreversible for notification purposes: it suppresses future
alerts for the deleted queue entries, including fallback events. Review the
audit first. Afterward, the guarded stub-history prune above can remove matching
stub rows if desired.

Existing databases must apply migration 07 as the database owner and run
`db/03-grants-assertion.sql` last before starting server 1.16.0. The boot probe
fails closed when an audit/outbox relation, required column/constraint, sequence,
or the singleton ledger row is missing. Reapplying migration 07 also converges
the earlier preview schema: because its unsafe sequence cursor cannot reveal
which history rows it skipped, the upgrade requeues all existing history once
and clears old aggregate counts. That may repeat a preview alert, choosing
at-least-once delivery over silent loss.

This release also makes every positive-integer environment setting strict.
Values with trailing text or scientific notation that older `parseInt` behavior
accepted now fail at boot; correct them to complete decimal integers before the
restart.

## Durable notification worker

Delivery is opt-in; real degradation auditing is not. Set
`METADATA_NOTIFY_CHANNELS` to
`pushover`, `ntfy`, or `pushover,ntfy`, then provide the selected adapters'
credentials from the deployment's `0600` `.env` file. The complete variable
set and defaults live in the two deployment `.env.example` files.

```dotenv
METADATA_NOTIFY_CHANNELS=pushover
METADATA_NOTIFY_LABEL=OpenBrain
METADATA_PUSHOVER_APP_TOKEN=<secret>
METADATA_PUSHOVER_USER_KEY=<secret>
```

The label is the only deployment identity sent externally. Keep it generic:
never use a hostname, address, or topology description. For ntfy, the topic is
also treated as a credential; an optional bearer token is supported for
protected/self-hosted topics.

The worker polls every five minutes by default. A trigger class that has never
been delivered bypasses the cooldown; later occurrences accumulate for a
30-minute rollup. A delivery batch uses best-effort fan-out to all selected
adapters and is committed as delivered when at least one succeeds. This is not
independent per-channel guaranteed delivery: a failed channel is recorded in
`last_failed_channels` and logged, but that batch is not retried to it after
another channel accepts it. Configure one channel when delivery through that
specific provider must be durable. If all adapters fail, pending counts are
retained and retried on the next poll without rereading or multiplying events.
The outbox claim and ledger update commit together. A crash after external
delivery but before that commit can repeat an alert—the deliberate at-least-once
failure direction—but cannot silently lose one.

The latest partial/all-channel failure remains queryable without exposing any
credential or provider response:

```sql
SELECT last_delivery_attempt_at, last_failed_channels
FROM metadata_degradation_notification_state
WHERE singleton;
```

Notification construction sees only finite event codes and counts. It never
selects thought content, thought IDs, endpoint bases/models, request data, or
infrastructure identifiers. Fallback counts are labeled `fallback`, not
`off-box`, because the configured fallback may itself be local.

### Deployment and live-fire

Keep any existing log monitor running until the durable path has completed one
real end-to-end delivery:

1. Apply migration 07 and the grant assertion before starting server 1.16.0.
2. Confirm egress **from inside the MCP container** before depending on the
   worker. For Pushover, for example, run

   ```bash
   docker compose exec mcp deno eval \
     'const r = await fetch("https://api.pushover.net"); console.log(r.status)'
   ```

   Any HTTP status proves DNS/TLS reachability; a timeout or DNS error does not.
   Use the configured origin for ntfy. `DOCKER-USER` rules and the app qube's
   Qubes firewall govern this container path, even when a host-side probe works.
3. Put one adapter's credentials and a generic label in the deployment's real
   `0600` `.env`, enable its channel, and recreate the MCP container. Existing
   queued degradation rows may cause the first alert immediately.
4. If no historical alert arrives, make one capture containing only an explicit
   harmless fixture such as `metadata alert live-fire fixture` while the primary
   is enabled but pointed at a known-dead local port and the fallback is blank.
   That deterministically records a primary failure plus a real stub without
   sending text to a fallback. Disabling extraction entirely does not emit a
   degradation event. For a quicker test, temporarily lower the poll and rollup
   intervals, then recreate the container so it reads the new values.
5. Confirm the provider received a content-free alert, the MCP log contains
   `delivered durable alert batch`, and the stub row is queryable in
   `metadata_degradation_events`. Restore the endpoint and interval settings and
   recreate the container again.
6. Only after that success should the legacy log-scraping timer be disabled.

The fixture remains a real thought and audit event by design; never use real or
private content for this test.

## Diagnostic log trigger lines

The boot-time posture line comes from [`server/index.ts`](../server/index.ts):
`[metadata] fallback policy: off|alert|allow`. Verify it after every restart,
but do not count it as a per-capture degradation trigger. The lines below come
from [`server/metadata.ts`](../server/metadata.ts), contain no thought content,
and use the stable substrings shown.

| log line (substring) | what it means | suggested priority |
|---|---|---|
| `classified via FALLBACK endpoint` | Content may have left your network (depends on `FALLBACK_CHAT_API_BASE`). The headline event. | high |
| `stamping uncategorized stub` | Every configured endpoint failed; the thought is stored with placeholder metadata and won't surface under topic/type filters until backfilled. | normal |
| `primary endpoint failed (transport/timeout)` | The request could not complete. On a deployment that keeps a resident local model, recurring firings are an availability signal: diagnose reachability, cold starts, timeouts, and residency (see the [GPU-qube transport doc](../deploy/qubes/gpu-offload-transport.md) §6–7). | normal |
| `primary endpoint failed (non-2xx response)` | The endpoint was reachable but rejected or failed the request. The line appends the final HTTP status (for example, `— HTTP 401`) so authentication/configuration failures, rate limits, and server failures can be distinguished before consulting the endpoint's logs. | normal |
| `primary endpoint returned an invalid response` | The endpoint returned 2xx, but not a usable OpenAI-compatible completion envelope. | normal |
| `primary endpoint returned unparseable metadata` | The completion envelope was usable, but the model's content was not JSON. This is an output-quality signal, not an availability signal. | normal |
| `primary endpoint returned schema-invalid metadata` | The model returned JSON that failed the local runtime schema. A recurring rejection is a model-quality or compatibility regression; when fallback is configured and policy permits it, this can systematically route capture content to that fallback. | high |

**Upgrade note:** if you deployed an earlier revision of the monitor sketch,
replace its `grep -c "primary endpoint failed"` expression when this server
change rolls out. The old expression counts only the two availability forms
and silently misses the three new `primary endpoint returned …` forms. The
fallback-classified and stub counters are unchanged.

The reference monitor deliberately aggregates all five primary failure forms
into one `primary-fail` counter. When schema rejection actually routes content
to a configured, policy-permitted fallback, that capture also emits the
high-priority `classified via FALLBACK endpoint` line; without a fallback, it
stubs locally and remains a normal-priority quality event. That companion signal
is why the sketch does not need a second schema-only counter to honor the table's
priority.

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

## Legacy monitor anti-spam, and failing loudly

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

## Legacy fallback: bash + systemd user timer

The server-side worker is the normal path. Keep this host-side sketch only for
older servers, for an independent process-liveness signal, or during a staged
migration until the durable worker has been live-fired. It remains useful when
the server process itself cannot run its polling loop.

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
  it takes the whole backlog. Either way the log is not an audit trail; use the
  durable database history described above.
- **Egress**: the monitor runs on the *host*, so container-scoped egress
  firewalls (e.g. a `DOCKER-USER` chain) don't apply to it — but check the
  host's own path once: `curl -sI https://api.pushover.net` from the account
  that will run the timer. On a Qubes deployment the knob that actually
  governs that path is the app qube's own Qubes-firewall egress policy —
  check there first if the probe fails.

## Fallback policy

Set `METADATA_FALLBACK_POLICY` to exactly one of:

| value | behavior |
|---|---|
| `off` | Never call `FALLBACK_CHAT_*`. A failed enabled primary records `primary_failure` + `stub_used` and stores placeholder metadata. With no enabled primary, suppressing a configured fallback is an intentional disabled-extraction posture: each thought keeps stub provenance, but no degradation row is emitted. |
| `alert` | Permit the configured fallback, but refuse to boot unless `METADATA_NOTIFY_CHANNELS` contains at least one fully configured adapter. Boot validates configuration, not provider reachability; delivery remains best-effort. |
| `allow` | Permit the configured fallback without requiring delivery. Durable audit rows are still written; this is the privacy-weakest mode. |

There is deliberately no default. Missing or invalid policy values stop the
server at boot, and compose deployments require the variable before rendering
the MCP service. `alert` and `allow` preserve fallback-only deployments where
`CHAT_*` is blank; under `alert`, each successful fallback classification enters
the existing first-occurrence/rollup notification flow. Confirm provider egress
with the live-fire procedure above and watch delivery failures plus
`last_failed_channels`; `alert` does not turn a best-effort provider into a
guaranteed channel. The active policy is printed at boot beside the extraction
posture.

Related reading: [`docs/why-local-only.md`](why-local-only.md) for why the
fallback exists at all, and the [GPU-qube transport
doc](../deploy/qubes/gpu-offload-transport.md) §6–7 for keeping the primary
healthy enough that this monitor stays quiet.
