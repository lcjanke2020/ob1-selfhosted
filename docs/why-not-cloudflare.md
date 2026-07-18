# Why not Cloudflare?

If you've read the deployment guides, you've probably asked the obvious question: why Tailscale Funnel for the public door instead of a Cloudflare Tunnel? Fair question — and the honest answer is that for most people, Cloudflare is probably the better choice. This document explains what Cloudflare does better, what the Funnel path buys instead, and sketches how you'd build the Cloudflare variant if it fits your situation better than it fits ours.

## The short version

Cloudflare handles perimeter concerns — DDoS absorption, WAF filtering, bot management, edge rate limiting — before traffic ever reaches your hardware, and it handles them well. The free tier covers everything a deployment like this needs, so cost is not the objection.

This project chose Funnel anyway, for two reasons:

1. **TLS terminates on your hardware, not at a CDN edge.** Funnel's relays are SNI-routed TCP forwarders. The certificate's private key lives on your node, and Tailscale's infrastructure sees only ciphertext in the routine path. Cloudflare Tunnel terminates TLS at Cloudflare's edge, which gives Cloudflare the architectural ability to read every request and response crossing the public door. For a system whose payload is your private thoughts, removing one party with plaintext capability is much of the point of self-hosting. It also preserves the maximal configuration: run local models against the tailnet door and this stack supports a mode in which thoughts exist as plaintext on no hardware but your own. And because TLS terminates on your node, even reaching the public door from your own devices doesn't break that property — a TLS-terminating edge would, the moment any traffic crossed it.

2. **Zero additional vendors.** The dual-door design already requires a Tailscale account for the private door. Funnel reuses it. No new account, no DNS zone, no WAF rules to keep current against rotating upstream IP ranges, no tunnel credentials to rotate. Cloudflare would be a strictly additional operational surface, however inexpensive.

## Who can see what

| Party | Today (Funnel) | With Cloudflare instead |
|---|---|---|
| Your hosted LLM provider | Plaintext of everything the model reads and writes — inherent to using a hosted model | Same |
| Tailscale | Connection metadata on the public door (SNI, timing, volume); no plaintext in the routine path | Tailnet-door metadata only |
| Your identity provider | Identity and auth events; no thought content | Same |
| Cloudflare | — | Plaintext of all public-door traffic |

Run an all-local configuration — local models, your own client devices — and the first row drops out entirely: no party in this table ever sees your thoughts in plaintext, only connection metadata. That configuration is the one this project is built not to foreclose.

This table is about who can *read* your thoughts. For the companion question — who can *reject or alter* a write it never reads — and a case study in why executing MCP through a local runtime removes the hosted-connector edge behind it, see [why-local-only](./why-local-only.md).

## Honest caveats to our own argument

**If a hosted LLM is your client, it already sees everything.** Anthropic, OpenAI, or Google sees your thoughts in plaintext by design — that's what it means to use their models against your memory store. Adding Cloudflare's (hypothetical) ability to read the same bytes may not move your threat model at all. The end-to-end argument bites hardest if you run local models against the tailnet door and keep the public door for occasional hosted-client convenience. If you'll never run a local model, the case for Funnel weakens to "one fewer account."

**"No routine plaintext capability" is not "trustless."** Tailscale controls the `ts.net` domain, so a malicious or legally compelled Tailscale could issue a certificate for your hostname and man-in-the-middle the public door. Certificate Transparency monitoring is the detection control for that scenario, not prevention. The tailnet path has an analogous caveat — peer key distribution runs through Tailscale's coordination plane — which is what Tailnet Lock exists to close if you want the all-local guarantee to hold against a hostile coordination server too. Relatedly, your Funnel hostname lands in public CT logs the moment the certificate is issued — pick a non-descriptive node name *before* enabling HTTPS. The deployment guides assume you did.

**Every request reaches your origin.** Funnel delivers real client IPs in a trustworthy `X-Forwarded-For`, so on-box allowlisting at the reverse proxy works — but the packets have already touched your machine by then. With Cloudflare, junk dies at the edge. At personal scale this distinction is mostly theoretical; under sustained abuse it isn't.

**Both are third-party ingress dependencies.** Funnel is not more independent than a tunnel — just less privileged. If Tailscale's Funnel infrastructure has a bad day, your public door is down either way.

## Which should you pick?

Pick **Cloudflare** if you want edge filtering and DDoS absorption, a custom domain, or you already operate Cloudflare zones — and you're comfortable with the edge terminating TLS. That is a reasonable trade, and if a hosted LLM is in your loop anyway, arguably the pragmatic one.

Pick **Funnel** (this repo's default) if minimizing the set of parties with plaintext capability is a hard requirement, your traffic is personal-scale, and you're already paying the Tailscale cost for the private door — in which case the public door adds zero marginal vendors.

## Sketch: the Cloudflare variant

We designed this variant before choosing Funnel, decided it didn't fit our threat model, and never built it. It should work; treat it as a starting point, not a tested recipe.

- Run `cloudflared` as an **outbound-only tunnel** from a dedicated ingress host (or a dedicated ingress qube, mirroring the Qubes runbook's topology). No inbound ports on your perimeter — the same property Funnel gives you.
- Point a public hostname on your zone at the tunnel, targeting the same Caddy instance this repo ships. **Keep Caddy.** The dual-door auth logic, credential header-strip boundaries, and audit response shaping described in [`security-model.md`](./security-model.md) are ingress-agnostic; the tunnel only replaces the transport in front of them.
- Add a **WAF custom rule** pinning source IPs on that hostname to your LLM provider's published egress ranges, maintained as a Cloudflare IP List — the ranges rotate, so this is an ongoing chore, and it's the edge-side analogue of the on-box allowlist.
- Enable **Authenticated Origin Pulls** (and restrict which hostnames the tunnel will serve) so a request that reaches Cloudflare's edge under your name but outside your tunnel can't reach the origin.
- Do **not** put Cloudflare Access in front of the MCP path. MCP clients expect to run their own OAuth flow against your resource server, and an Access challenge interleaves badly with it. WAF rules plus the OAuth resource server is the combination that works.
- **Cloudflare Logpush** can feed your log pipeline if you want edge-side parity with the audit tables.

If you build this and want to contribute it back, a `deploy/compose-cloudflare/` tier following the structure of `deploy/compose-tailnet/` would be a welcome PR.
