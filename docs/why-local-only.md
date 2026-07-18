# Why an all-local loop? A case study in the connector as the risk

The [why-not-cloudflare](./why-not-cloudflare.md) note argues one axis: keeping cloud
parties from *reading* your plaintext. This note is about the other axis — a cloud
party that can silently *interfere* with your writes — and it's grounded in a real
incident, because the abstract argument for running an all-local loop is easy to wave
away until something concrete breaks.

The short version: a fully self-hosted memory system, doing everything right on its own
hardware, still failed to record certain notes — not because of any bug in the system,
but because the *client's path to it* ran through a hosted-LLM vendor's connector, and
an edge content filter on that connector silently dropped the writes before they ever
arrived.

## What happened

The deployment was the all-local configuration this project is built to support:
embeddings from a local model, metadata classification from a local model on a GPU
host, storage in a local database. Nothing in the write path touched a third-party LLM.

The *client*, though, was a hosted agent — a cloud LLM reaching the memory store's tools
through the vendor's **agent connector** (the mechanism a hosted model uses to call your
MCP server). Most of the time this is seamless. But a handful of captures failed,
returning an opaque CDN "you have been blocked" page instead of a result.

The tell was what the failures had in common: their content. Notes written in plain
prose went through. Notes whose body carried **code-like tokens plus long, high-entropy
identifier strings** (keys, fingerprints, device IDs) were rejected — every time, on the
way *out*, not on the way back.

## Why we know it wasn't the store

The instinct is to blame the server, or the classifier, or the model. The evidence ruled
all of that out:

- **The server never saw the failed writes.** In the failure window its logs showed only
  the *successful* captures and their local classifications — no errors, no fallbacks.
  The database held exactly those successful rows. The failed writes left **no log line
  and no row**. They didn't fail at the store; they never reached it.
- **The block page came from the vendor's edge, not the origin.** It was a generic CDN
  WAF challenge referencing the *vendor's* domain — the reverse proxy in front of the
  self-hosted store was never in the conversation.
- **The same filter had been seen on a different connector.** A separate hosted connector
  (an issue tracker's) had previously rejected code-heavy issue bodies with the identical
  page. One filter, sitting in front of the whole class of the vendor's connectors,
  false-positive on content that looks like an injection payload — which any honest note
  full of commands, config, and identifiers will.

So the failing component was a **content filter on the connector transport, upstream of
everything you host** — a party in the path you didn't design in and can't configure.

## The general point: a connector can interfere, not just observe

`why-not-cloudflare` tabulates who can *see* your plaintext. The dual of that table is who
can *interfere* with a request — silently drop it, delay it, rate-limit it, or mangle it —
and a hosted connector belongs in that column whether or not it ever reads your data:

| Path a client uses | Who can silently block/alter a write | All-local guarantee |
|---|---|---|
| Hosted LLM → vendor connector → your MCP server | The vendor's edge (WAF/content filter), plus everyone in [why-not-cloudflare](./why-not-cloudflare.md)'s read table | **No** — an opaque intermediary sits in the write path |
| Local model / local client → private-door → your MCP server | Only your own hardware and your tailnet's transport | **Yes** — no cloud party can inspect or drop the write |

The failure here was a false positive, not an attack. That's the point worth sitting with:
you don't need a hostile intermediary for an intermediary to hurt you. An automated filter
tuned for someone else's threat model, applied to your private notes, is enough to make
your own data undeliverable — with an error that tells you nothing and a write that simply
vanishes.

## Why the all-local loop is immune

Run the loop the way this stack is built to allow it — a **local model**, a **local
client**, talking to the MCP server over the **private (tailnet) door** — and the entire
table above collapses to its last row. There is no vendor connector in the path, so there
is no vendor edge to filter it. Your notes go from your client to your store over transport
only your own devices and your tailnet touch. Nothing in the middle can read them (the
confidentiality argument) *and* nothing in the middle can drop them (the integrity/
availability argument this incident makes concrete).

That second property is the one you can't get any other way. You can encrypt around a
reader; you cannot encrypt around a filter that blocks based on shape and returns a CDN
error. The only structural fix is to remove the filter from the path — which means removing
the connector from the path — which means an all-local loop.

## Honest caveats to our own argument

**Hosted clients are convenient, and often the right call.** Reaching your memory from a
cloud agent on any device, with no local GPU, is genuinely useful, and for a lot of notes
the connector filter never fires. The argument here isn't "never use a hosted client." It's
"keep an all-local path available, and route the writes that matter through it" — the same
posture `why-not-cloudflare` takes toward the public door.

**If a hosted model is your client, it already sees everything.** As that note says, using
a hosted model against your store hands it your plaintext by design. This incident adds a
second reason to prefer the local loop when you can — but if you're already all-in on a
hosted client, the connector filter is an availability annoyance layered on a
confidentiality exposure you'd already accepted.

**The tempting workaround is the wrong one.** You can often sneak a blocked note through by
rephrasing it — dropping the commands, breaking up the identifiers. Don't build on that.
It corrupts the record to satisfy a filter that shouldn't be in your path, and it fails
exactly when your notes are most technical and most worth keeping verbatim. Fix the path,
not the payload.

**This is not unique to any one vendor.** Any hosted connector fronted by an edge security
layer can do this; the specific vendor is incidental. Treat "there is a CDN between my
client and my store" as the risk, independent of whose CDN it is.

## Which path should you use?

Use a **hosted client through a connector** when convenience wins and your notes are mostly
prose — accepting that an edge filter may occasionally, silently, refuse a technical one.

Use the **all-local loop** (local model, local client, private door) when you want writes
that can't be read *or* dropped by anyone but you — especially for the code-, config-, and
identifier-heavy notes that are both the most valuable to capture verbatim and the most
likely to trip a content filter. This project keeps that path first-class precisely so it's
there when you need it.

See also: [why-not-cloudflare](./why-not-cloudflare.md) (the confidentiality axis of the
same choice) and [security-model](./security-model.md) (the dual-door design that makes the
local path first-class).
