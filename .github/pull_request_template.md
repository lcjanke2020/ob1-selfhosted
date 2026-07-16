## Summary

<!-- One or two sentences: what this changes and why. -->

## Checklist

- [ ] The local leak guard is enabled on my clone (`git config core.hooksPath .githooks` — see [.githooks/README.md](https://github.com/lcjanke2020/ob1-selfhosted/blob/main/.githooks/README.md)), and the diff contains no internal ticket ids, private or tailnet IPs, real tailnet hostnames, or credentials.
- [ ] `cd server && deno task test` passes (if `server/` was touched).
- [ ] Docs updated in the same PR if behavior, a trust boundary, or a control changed ([README.md](https://github.com/lcjanke2020/ob1-selfhosted/blob/main/README.md), [docs/security-model.md](https://github.com/lcjanke2020/ob1-selfhosted/blob/main/docs/security-model.md), [docs/threat-model.md](https://github.com/lcjanke2020/ob1-selfhosted/blob/main/docs/threat-model.md)).
- [ ] All triggered CI checks are green, including the Leak gate (path-filtered checks that were skipped are fine).
- [ ] I license this contribution under [FSL-1.1-MIT](https://github.com/lcjanke2020/ob1-selfhosted/blob/main/LICENSE.md) (inbound = outbound; see [CONTRIBUTING.md](https://github.com/lcjanke2020/ob1-selfhosted/blob/main/CONTRIBUTING.md)).
