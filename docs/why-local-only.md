# Why an all-local loop? A case study in the connector as the risk

[`why-not-cloudflare`](./why-not-cloudflare.md) argues one axis of the self-hosting choice:
keeping cloud parties from *reading* your plaintext. This note is about a second,
independent axis — a cloud party that can *reject or alter* a write it never reads — and it
separates two things this argument tends to blur: the **transport** your client uses to
reach the store, and where **inference** happens. They are fixed by different moves.

It's grounded in a real, genericized incident, because the abstract case is easy to wave
away until a write you expected to land simply doesn't.

## What happened

The deployment was close to the maximal local configuration this project supports:
embeddings from a local model, metadata classification from a local model on a GPU host,
storage in a local database. Once a request reached the store, no server-side processing
called a third-party model. (A cloud classifier fallback stays wired for when the local model
is unavailable, but it never fired here — and even on failure it only stamps a placeholder; it
can't reject a write.)

The **client**, though, was a hosted model reaching the store's tools through the **vendor's
hosted connector** — the cloud-side path a hosted model uses to call your MCP server, as
opposed to a local agent runtime that executes those calls itself. Most captures went
through. A handful came back with an opaque CDN "you have been blocked" page. The common
factor was their content: bodies carrying **code-like tokens plus long, high-entropy
identifier strings** (keys, fingerprints, IDs) were rejected; plain-prose bodies were not.

## Why we know it wasn't the store

- **The store never saw the failed writes.** In the failure window its logs showed only the
  *successful* captures and their local classifications — no errors, no fallbacks — and the
  database held exactly those rows. The rejected writes left **no log line and no row**.
  They were turned back *before* the store, not by it.
- **The rejection came from the vendor's edge, not the origin.** It was a generic CDN block
  page naming the *vendor's* domain; the reverse proxy in front of the self-hosted store was
  never in the conversation.
- **The same *kind* of failure had been seen on a different connector.** A separate hosted
  connector (an issue tracker's) had previously rejected code-heavy bodies with the identical
  page. That establishes the same *class* of edge-filter behavior on the hosted-connector
  path — not that one shared filter sits in front of both (the two sightings may be two
  different edges; see "not unique to any one vendor" below).

Note the precise shape of the failure: an **opaque rejection from an intermediary, upstream
of everything you host**. The client did get an error — it just got a meaningless one, from
a party in the path it didn't design in and can't configure, while the store recorded
nothing. That is worse than a clean error and worse than a clean success: a non-actionable
"no" about your own data going into your own system.

## Two axes: who can *read*, and who can *reject*

[`why-not-cloudflare`](./why-not-cloudflare.md) tabulates who can *read* your plaintext. The
dual question is who can *reject or alter* a write. The two are independent, and — the part
worth being precise about — they are closed by different moves:

| Configuration | Connector edge filter on the MCP transport? | Hosted model in the loop at inference? | Third party reads your plaintext? |
|---|---|---|---|
| Hosted model **+ hosted connector** (the incident) | **Yes** — the vendor's edge sits on the tool-call transport | Yes | Yes — by design |
| Hosted model **+ local MCP execution** (a local agent runtime over loopback / your tailnet door) | **No** — the connector edge is off the transport | Yes — inference is still hosted | Yes — the hosted model still reads it |
| **Local model + local client** (loopback) | No | **No** | **No** |

The middle row is the one this argument usually misses. **Taking the connector edge off the
transport does not require local inference.** Run the agent as a *local runtime* — a client on
your own box that reaches the MCP server over loopback (`127.0.0.1`) or your private tailnet
door, the way the local-install path already works — and its tool calls never traverse the
vendor's hosted connector, so the specific edge filter that produced this incident is off the
path. The model can still be a hosted one.

But be precise about what that removes. It removes **one** rejection surface: the connector's
content filter on the MCP HTTP transport. It does **not** remove the hosted model provider,
which is still in the loop at inference — it receives your prompt (so it still reads your
plaintext), and it can refuse the request, policy-filter the input or output, omit the tool
call, or return altered arguments. That is a narrower and less arbitrary surface than an
opaque transport WAF, but it is a real one. Only moving inference local removes it too.

So, sorting the wins by where they come from:

- The win against **this incident's failure mode** — the hosted-connector edge filter can no
  longer reject a tool call — comes from executing MCP through a **local runtime** (loopback or
  the tailnet door), not from the model being local. It takes the connector edge off the
  transport; it does not take the hosted provider out of inference.
- The **confidentiality** win — no third party reads your plaintext — comes from **local
  inference**, which also removes the provider's inference-time ability to refuse or alter what
  gets written. See [`why-not-cloudflare`](./why-not-cloudflare.md) and the [threat model](./threat-model.md).
- The **fully local loop** — local model, local client, loopback — is the only configuration
  that removes *both* the connector edge and the inference provider: nothing but your own
  process and disk is in the path.

## Honest caveats to our own argument

**Loopback is not the tailnet, and the tailnet is not "trustless."** A client on the *same
machine* reaches the store over loopback — no third party in the path at all. A client on
*another of your devices* reaches it over the private tailnet door, which removes the hosted
connector but adds your mesh coordinator as an availability dependency and, absent Tailnet
Lock, a party that could in principle re-key a peer. That is the same caveat
[`why-not-cloudflare`](./why-not-cloudflare.md#honest-caveats-to-our-own-argument) documents
for the private door, and it applies here: the tailnet path removes the *content filter* and
normally preserves confidentiality, but it is not the absolute "no one else in the path" that
loopback is. Only the same-box loopback loop gives you that.

**Hosted connectors are convenient, and often the right call.** Reaching your memory from a
hosted client on any device, with nothing running locally, is genuinely useful, and most
prose notes never trip the filter. The argument isn't "never use a connector." It's "keep a
non-connector path — a local runtime — available for the writes that matter, especially the
code- and identifier-heavy ones that are both most worth keeping verbatim and most likely to
be filtered."

**The tempting workaround is the wrong one.** You can often get a rejected note through by
rephrasing it — dropping the commands, breaking up the identifiers. Don't build on that: it
corrupts the record to satisfy a filter that shouldn't be in your path, and it fails exactly
when your notes are most technical. Fix the path, not the payload.

**Not unique to any one vendor.** Any hosted connector fronted by an edge security layer can
do this; the specific vendor is incidental. Treat "there is a CDN between my client and my
store" as the risk, whoever's CDN it is.

## Which path should you use?

- **Hosted model + hosted connector** — most convenient, works from anywhere, nothing local;
  accept that an edge filter may occasionally, opaquely, reject a technical write.
- **Hosted model + local runtime** (loopback or tailnet door) — takes the connector edge off
  the transport, so this incident's failure mode is gone; the hosted model still reads your
  prompt and can refuse or alter at inference. A large reliability gain at no confidentiality
  cost you weren't already paying.
- **Local model + local client** (loopback) — removes both the connector edge and the inference
  provider: no outside party can read *or* reject your writes, and nothing but your own hardware
  is in the path. This is the maximal configuration
  the project keeps first-class — for exactly the notes you least want a stranger's filter to
  have an opinion about.

See also: [`why-not-cloudflare`](./why-not-cloudflare.md) (the confidentiality axis of the
same choice), [`security-model`](./security-model.md) (the loopback binds and dual-door design
that make the local path first-class), and [`threat-model`](./threat-model.md) (the one-page
assembled view).
