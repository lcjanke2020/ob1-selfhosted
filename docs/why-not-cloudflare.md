# Why not Cloudflare?

Every review of "a self-hosted service you expose to the public internet" arrives at the same question within the first minute: *why Tailscale Funnel + Caddy instead of a Cloudflare Tunnel?* Cloudflare Tunnel is the default answer in most homelab writeups — free, one binary (`cloudflared`), DDoS protection and a WAF thrown in. So the burden is on us to say why this project deliberately doesn't use it.

Short version: **Cloudflare Tunnel terminates your TLS at Cloudflare's edge, which means a third party sees the plaintext of every memory you capture and every semantic query you run.** That is a direct contradiction of this project's one-sentence pitch — *your data never leaves hardware you own* — so it's disqualifying here regardless of how convenient the rest of Cloudflare is. Everything below is the longer, fairer version, including the cases where Cloudflare *would* be the right call.

## What this project is optimizing for

The trade-off only makes sense against the project's stated goals (see the [README](../README.md) and [`security-model.md`](security-model.md)):

1. **Data sovereignty** — the memory store, the embeddings, and the traffic to reach them stay on hardware you control. No plaintext egress to a vendor.
2. **$0/month, no new account** — no cloud bill, no separate control-plane vendor, no domain to register.
3. **Minimize trusted third parties** — every party that *could* read or inject into the stream is attack surface and a subpoena target. Fewer is better.
4. **A perimeter that lives entirely in git** — a pinned Caddy image + a `Caddyfile`, reproducible from the repo, with no dashboard state to click back together.

Cloudflare Tunnel scores well on convenience and DDoS resilience and poorly on 1 and 3. For a personal memory store, 1 and 3 are the whole point.

## The decisive difference: who can read the plaintext

This is the reason that actually settles it, and it's a genuine architectural difference — not a preference.

| | Tailscale Funnel (this project) | Cloudflare Tunnel |
|---|---|---|
| Where TLS terminates | **On your node.** `tailscaled` holds the Let's Encrypt cert for your `*.ts.net` name and terminates TLS locally, then hands plain HTTP to Caddy on loopback. | **At Cloudflare's edge.** `cloudflared` opens an outbound tunnel; Cloudflare terminates the visitor's TLS, inspects/serves the request, then re-encrypts to your origin. |
| What the intermediary sees | Ciphertext only. Tailscale's relays forward an encrypted TCP stream they cannot read. | **Plaintext.** Cloudflare sees full request and response bodies by design — that's how the WAF, caching, and analytics work. |
| Consequence for this stack | Your captured thoughts and queries are readable only on your own box. | Every `capture_thought` body and every `search` query passes through Cloudflare in the clear. |

For most homelab traffic (a static site, a media server) edge TLS termination is a non-issue — you *want* Cloudflare to cache and filter. For a store whose entire contents are your private memory, "a third party sees every byte in plaintext" is the ballgame. This alone rules Cloudflare Tunnel out for the public-facing paths, independent of every other consideration.

The [MCP architecture](../README.md#architecture) is built around this: `tailscaled` terminates TLS and forwards plain HTTP to Caddy over loopback (`127.0.0.1:9787`), so the reverse proxy — the piece that enforces the Anthropic IP allowlist, the body cap, and credential-redacted logging — runs on your hardware, not a vendor's.

## What Cloudflare would genuinely buy you (and how we cover it)

It would be dishonest to pretend Cloudflare offers nothing. It offers three real things Funnel does not, and this stack answers each differently.

| Cloudflare gives you | Funnel's gap | What this project does instead |
|---|---|---|
| **IP / ASN filtering** at the edge | Funnel has [no native IP filtering or rate limiting](funnel-mcp-perimeter.md#what-funnel-doesnt-give-you) | The one filter that matters here is enforced on-node: Caddy `403`s anything outside Anthropic's egress range `160.79.104.0/21` **before** the backend is touched, and a CI guard fails the build if that CIDR ever disappears from the `Caddyfile`. The public door is scoped to exactly one legitimate source. |
| **DDoS absorption + WAF** | A Funnel endpoint can be flooded; there's no scrubbing tier | Accepted for a personal store. The threat model is "an authenticated memory API for one person," not "a high-value target that must survive a volumetric attack." Availability caveats are documented, not hand-waved — see the [Funnel limitations table](funnel-mcp-perimeter.md#what-funnel-doesnt-give-you). |
| **Rate limiting** | None natively | The IP allowlist collapses the reachable surface to Anthropic's range; app-layer auth (RS256 JWT, pinned issuer/audience/`exp`) is load-bearing behind it, and every auth failure is recorded in an audit table you can alert on. |

Note what the allowlist does to the usual argument for a WAF: when the *only* IPs that can reach your listener are Anthropic's published egress range, the population of potential attackers you'd point a WAF at has already been `403`'d at the network layer. The WAF's job is mostly done by a five-line `client_ip` matcher you can read in the repo.

## The dependency-fit argument

Tailscale is *already in the stack* — the app↔db and ingress↔app hops on the [Qubes path](../deploy/qubes/three-qube-design.md) run over a firewall-scoped tailnet, and every single-box install can reach the server over the same tailnet with `tailscale serve`. Funnel is one more verb on a tool that's already load-bearing here. Adding Cloudflare means:

- a **second control plane** (the Cloudflare dashboard) whose state isn't in git and has to be reproduced by hand on a rebuild;
- a **second vendor account** to create, secure, and not lose access to;
- typically a **domain on Cloudflare DNS**, where Funnel needs no domain at all — the `*.ts.net` name is issued for you.

For a project whose selling point is "reproducible from this repo, no cloud account, $0," each of those is a step in the wrong direction.

## Doesn't Cloudflare hide your URL better?

No — and this project doesn't rely on a secret URL from either side. A Funnel hostname is discoverable via Certificate Transparency logs the moment its cert is minted; a Cloudflare-fronted hostname is equally discoverable. Both stacks must assume scanners arrive on day one. This project [assumes exactly that](funnel-mcp-perimeter.md#what-funnel-doesnt-give-you) and answers with a neutral hostname, an IP allowlist, load-bearing auth, and observability — not obscurity. Cloudflare wouldn't change that calculus; it would just move the plaintext.

## When Cloudflare *is* the right call

To keep this honest: pick Cloudflare Tunnel (or a hosted edge in general) when your priorities differ from this project's.

- **You're serving public, non-sensitive content** — a blog, docs, a status page. Edge TLS termination is a feature, not a leak, and the CDN + WAF are pure upside.
- **You need to survive volumetric DDoS** or you're a genuinely high-value target. A scrubbing tier is worth the trade Funnel can't make.
- **You want a custom domain and edge features** (WAF rules, geo-routing, edge functions) and you accept the vendor in your trust boundary.
- **Your regulatory or org policy** already blesses Cloudflare as a processor, so "a third party sees plaintext" isn't disqualifying for your data class.

None of those describe a single-person, self-hosted, private memory store — which is precisely the thing this repo builds. If your situation matches the list above, front it with Cloudflare and don't look back; the [`funnel-mcp-perimeter.md`](funnel-mcp-perimeter.md) pattern (OAuth resource server, IP allowlist, redacted logs, auth audit) still transfers, you'd just be enforcing it behind a different edge.

## Bottom line

Not using Cloudflare is a deliberate choice, not an oversight. The public edge is Tailscale Funnel + a Caddy perimeter you own because that's the only shape that keeps the plaintext of your memories on your hardware while still letting claude.ai and Claude mobile reach a server on that hardware. We give up a managed WAF and DDoS scrubbing to get there, replace the one network filter that matters with an on-node Anthropic-egress allowlist, and document the residual risks rather than papering over them. For the full perimeter design, see [`security-model.md`](security-model.md) and [`funnel-mcp-perimeter.md`](funnel-mcp-perimeter.md).
