# Hybrid thought search

Thought recall combines two independent candidate lists:

1. **Vector leg** — pgvector cosine nearest neighbors, gated by `threshold`.
2. **Lexical leg** — PostgreSQL full-text search plus an escaped literal
   substring fallback.

The server fuses their rank positions with reciprocal rank fusion (RRF). It
does not blend cosine similarity with `ts_rank_cd`: those scores have unrelated
scales, so normalizing or weighting their raw values would make ranking depend
on corpus-specific score distributions.

## Query behavior

The lexical leg uses `websearch_to_tsquery('simple', query)`. The `simple`
configuration intentionally keeps tokens instead of stemming them. Semantic
paraphrases are already the vector leg's job; the lexical leg exists to make
literal recall durable for values such as `OPS-275`, `search_thoughts`, and
error strings. Web-search syntax supports quoted phrases, `OR`, and `-term`.

True full-text hits rank first inside the lexical leg. If that list does not
fill its bounded candidate budget, an `ILIKE '%query%'` substring path fills
the remaining positions. `%`, `_`, and backslash in caller input are escaped,
so they remain literal characters rather than widening the query as SQL
wildcards. The substring predicate is accelerated by a pg_trgm GIN index.

The vector and lexical legs each inspect at least 50 candidates, or the
requested final `limit` when it is larger. Both legs apply the same provenance
include/exclude predicates *before* assigning ranks. The production fusion is:

```text
rrf_score = sum(1 / (60 + rank_in_leg))
```

A thought found by both methods receives both contributions and normally rises
above a comparable single-leg hit. `rrf_score` is a relative ordering value,
not a probability or confidence percentage.

REST results expose both:

- `rrf_score` — the value that orders the hybrid result set;
- `similarity` — cosine similarity retained for compatibility and diagnostics.

`threshold` gates only the vector leg. A strong exact-text hit can therefore be
returned with `similarity` below `threshold`; excluding it would recreate the
literal-token failure hybrid search is meant to fix. The MCP prose output labels
that number as semantic similarity while preserving the RRF result order.

## Database migration

Fresh compose installs run [`db/05-hybrid-search.sql`](../db/05-hybrid-search.sql)
after the base thoughts and sessions schemas. Existing databases must apply it
once as the database owner before deploying the hybrid-query server:

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

Adding the stored column backfills existing rows, and regular GIN index builds
briefly block writes. Use a capture maintenance window for a large corpus. The
migration runs `ANALYZE thoughts` after the transactional schema/index changes
so the planner sees current statistics immediately.

For a native Postgres deployment, run the same SQL file with the local or
tailnet-restricted database-owner connection described by that deployment's
runbook. No live database is migrated merely by updating the repository:
`docker-entrypoint-initdb.d` runs only for a fresh data directory.

## Lineage

The lexical shape follows upstream Open Brain's FSL-1.1-MIT
`schemas/enhanced-thoughts` and `schemas/text-search-trgm` contributions:
token-preserving `websearch_to_tsquery` plus a pg_trgm-backed literal fallback.
RRF fusion follows an independently licensed memory-vault implementation
reference used during design. The implementation here keeps both legs in the
single `server/queries.ts` path shared by MCP and REST.
