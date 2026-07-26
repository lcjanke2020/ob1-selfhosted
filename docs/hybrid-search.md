# Hybrid thought search

Thought recall combines two independent candidate lists:

1. **Vector leg** — pgvector cosine nearest neighbors, gated by `threshold`.
2. **Lexical leg** — PostgreSQL full-text search plus an escaped literal
   substring fallback.

The server fuses their rank positions with reciprocal rank fusion (RRF), using
the method from Cormack, Clarke, and Büttcher's SIGIR 2009 paper,
[“Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning
Methods”](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf). It does not
blend cosine similarity with `ts_rank_cd`: those scores have unrelated scales,
so normalizing or weighting their raw values would make ranking depend on
corpus-specific score distributions.

## Query behavior

The lexical leg uses `websearch_to_tsquery('simple', query)`. The `simple`
configuration intentionally keeps tokens instead of stemming them. Semantic
paraphrases are already the vector leg's job; the lexical leg exists to make
literal recall durable for values such as `OPS-275`, `search_thoughts`, and
error strings. Web-search syntax supports quoted phrases, `OR`, and `-term`.

True full-text and `ILIKE '%query%'` substring predicates are evaluated in one
bounded lexical candidate query. True full-text hits have source priority, so
literal-only matches rank behind them rather than acting as a second query
phase. `%`, `_`, and backslash in caller input are escaped, so they remain
literal characters rather than widening the query as SQL wildcards.

The substring predicate runs only when the parsed `tsquery` contains no NOT
operator and the literal contains an indexable alphanumeric trigram. This keeps
`OPS-275` on the literal path, prevents `foo -bar` from re-admitting a row that
full-text search excluded, and avoids full-index scans for one- or two-character
fragments. A pure-negative or otherwise unindexable full-text expression skips
the lexical leg; the vector leg still runs.

`-term` is lexical web-search syntax, not a global deny filter: the vector leg
can still return a semantically relevant row containing that term. Use
`filter.exclude` for provenance constraints that must apply to both legs. Search
queries are limited to 8 KiB of UTF-8 input before embedding or SQL parsing.

The vector and lexical legs each inspect at least 50 candidates, or the
requested final `limit` when it is larger. Each search raises transaction-local
`hnsw.ef_search` to that candidate depth; filtered searches also enable
`hnsw.iterative_scan = strict_order`. Both legs apply the same provenance
include/exclude predicates *before* assigning ranks. The production fusion is:

```text
rrf_score = sum(1 / (60 + rank_in_leg))
```

A thought found by both methods receives both contributions and normally rises
above a comparable single-leg hit. When a vector-only row and true full-text row
have equal RRF scores, the full-text row wins before UUID supplies the final
deterministic tie-break. `rrf_score` is a relative ordering value, not a
probability or confidence percentage.

REST results expose both:

- `rrf_score` — the value that orders the hybrid result set;
- `similarity` — cosine similarity retained for compatibility and diagnostics.

`threshold` gates only the vector leg. A strong exact-text hit can therefore be
returned with `similarity` below `threshold`; excluding it would recreate the
literal-token failure hybrid search is meant to fix. This is an intentional
behavior change from vector-only search. MCP prose labels a below-threshold
lexical result as an exact-text match instead of presenting its low cosine score
as the reason it matched, while preserving RRF order.

## Testing

The production query boundary is [`server/queries.ts`](../server/queries.ts).
[`db/hybrid-search-smoke.sql`](../db/hybrid-search-smoke.sql) exercises exact-reference
and hybrid-fusion behavior, while
[`db/search-filter-plan-smoke.sql`](../db/search-filter-plan-smoke.sql) provides the
larger filtered-ANN and planner fixture. When changing full-text/literal composition,
fallback gating, or lexical candidate plans, follow
[`review-hybrid-search-fallbacks`](../skills/review-hybrid-search-fallbacks/SKILL.md).
When adding approximate-index assertions or changing search settings, follow the
deterministic-versus-statistical split in
[`test-approximate-search-invariants`](../skills/test-approximate-search-invariants/SKILL.md).

## Database migration

Fresh compose installs run [`db/05-hybrid-search.sql`](../db/05-hybrid-search.sql)
after the base thoughts and sessions schemas. Existing deployments require both
pgvector 0.8.0 or newer (for filtered iterative scans) and this migration.
Verify `SELECT extversion FROM pg_extension WHERE extname = 'vector';`, upgrade
the extension if needed, and apply the migration as the database owner before
deploying the hybrid-query server:

```bash
docker compose exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d openbrain \
  < ../../db/05-hybrid-search.sql
```

The migration is idempotent and adds:

- the `pg_trgm` extension;
- stored generated column `thoughts.content_tsv` using the `simple` config;
- GIN index `idx_thoughts_content_tsv`;
- trigram GIN index `idx_thoughts_content_trgm`.

Adding the stored column takes an access-exclusive table lock. Because the
column and both regular GIN indexes are built in one transaction, that lock is
held until commit and blocks searches and captures for the migration's duration.
Plan a full application maintenance window for a large corpus and ensure disk
headroom for the stored `tsvector` plus both indexes. The migration runs
`ANALYZE thoughts` after the transactional schema/index changes so the planner
sees current statistics immediately.

The server's boot probe checks both hybrid-search indexes and refuses to start
with guidance to apply `db/05-hybrid-search.sql` when they are absent. This
turns a missed migration into an operator-facing startup failure rather than a
raw error on every search.

For a native Postgres deployment, run the same SQL file with the local or
tailnet-restricted database-owner connection described by that deployment's
runbook. No live database is migrated merely by updating the repository:
`docker-entrypoint-initdb.d` runs only for a fresh data directory.

## Lineage

The lexical shape follows upstream Open Brain's FSL-1.1-MIT
`schemas/enhanced-thoughts` and `schemas/text-search-trgm` contributions:
token-preserving `websearch_to_tsquery` plus a pg_trgm-backed literal fallback.
The RRF helper was written for this repository from the standard SIGIR 2009
algorithm cited above. The implementation keeps both legs in the single
`server/queries.ts` path shared by MCP and REST.
