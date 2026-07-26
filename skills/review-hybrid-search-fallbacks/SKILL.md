---
name: review-hybrid-search-fallbacks
description: "Use when writing or reviewing hybrid full-text retrieval that unions an operator-aware query parser with literal, LIKE/ILIKE, regex, or trigram fallbacks, especially before RRF or another fusion step. Audits semantic widening, negation and punctuation behavior, indexability boundaries, and whether candidate limits actually bound database work."
---

# Review Hybrid Search Fallbacks

A safe fallback improves recall without silently defining a second query
language. Review the result-set algebra and the actual database plan before
trusting escaping, indexes, or a final candidate limit.

## When to use

- Full-text search is combined with a literal substring, regex, or trigram leg.
- The query language supports negation, boolean operators, or quoted phrases.
- Separate lexical and semantic lists are fused with RRF or score blending.
- A change claims bounded or index-backed retrieval because each leg has a
  `LIMIT` or an index exists.

## In this repository

Use [`server/queries.ts`](../../server/queries.ts) as the production query
boundary. [`server/queries_hybrid_test.ts`](../../server/queries_hybrid_test.ts)
pins statement shape, parameter order, shared filters, and RRF behavior; its
unit cases also cover literal escaping and indexable-trigram boundaries.
[`db/hybrid-search-smoke.sql`](../../db/hybrid-search-smoke.sql) contains the
current parser/fallback worked examples and production-shape `EXPLAIN` probes,
while [`db/search-filter-plan-smoke.sql`](../../db/search-filter-plan-smoke.sql)
supplies the larger planner fixture. Read
[`docs/hybrid-search.md`](../../docs/hybrid-search.md) for the user-facing query
and cost contract.

## Procedure

1. **Inventory every interpretation of the input.** Record the syntax accepted
   by the API and how each leg parses the same string: full-text operators,
   literal escaping, tokenization, case folding, stemming, and punctuation.
   Include filters or tenancy predicates applied outside those parsers.

2. **Write the result-set contract as sets.** For a primary leg `P(q)` and
   fallback `F(q)`, an `OR` implements `P(q) ∪ F(q)`. Decide explicitly whether
   operators such as `-term` constrain the whole lexical result or only `P`. If
   they constrain the whole result, every row from `F` must independently
   satisfy those constraints; escaping the literal does not establish that.

3. **Build a parser/fallback truth table.** Exercise at least:

   - an ordinary word and a multi-word query;
   - an identifier with internal punctuation, such as `OPS-275` or
     `search_thoughts_v2`;
   - `foo -bar` and a pure `-bar` query;
   - a quoted phrase and `foo OR bar`;
   - literal wildcard/escape characters such as `%`, `_`, and backslash;
   - whitespace-only, punctuation-only, one-character, and two-character input.

   For every case, record both leg decisions and the union. A canonical failure
   is a row containing the literal text `foo -bar`: the parsed leg rejects it
   because `bar` is present, while a raw `%foo -bar%` fallback accepts it and
   the union defeats negation.

4. **Make fallback gating parser-aware.** When a fallback cannot preserve an
   operator, disable it for that parsed form or reapply the operator constraints
   to fallback rows. Do not disable on every hyphen: an internal identifier
   hyphen is data, while unary minus at a token boundary is syntax. Prefer the
   database parser's normalized/query-tree output over a second ad hoc parser
   when the engine exposes one.

5. **Probe indexability at its boundaries.** An index declaration is not proof
   that the production predicate can use it. For PostgreSQL `pg_trgm`, patterns
   without an extractable trigram can make an index scan degenerate into a
   full-index scan or lead the planner to prefer a sequential scan. A
   pure-negative `tsquery` has no positive posting list to drive a GIN scan. An
   `OR` with one unindexable branch can turn the whole lexical predicate into a
   sequential scan even when the other branch has a valid GIN index.

6. **EXPLAIN the exact production shape.** Use representative, analyzed data and
   preserve the real `OR`, filters, `ORDER BY` rank expression, and `LIMIT`.
   Check at least an indexable identifier, a short absent literal, a broad
   common term, a mixed positive/negative query, and a pure-negative query if
   allowed. Probe parameterized execution when the driver prepares statements; a
   plan with inlined constants may not represent the generic prepared plan.

7. **Distinguish candidate count from work.** A `LIMIT 50` after filtering and
   ranking bounds emitted candidates, not rows scanned, posting-list entries
   visited, or rows sorted. State which bound the application actually owns. If
   bounded work is a requirement, enforce a statement timeout, minimum indexable
   input, syntax restriction, or another explicit guard.

8. **Check cross-leg invariants before fusion.** Apply authorization, workspace,
   visibility, deletion, and provenance filters to every leg before ranking.
   Confirm a rejected row cannot re-enter through another leg. Keep raw scores
   in their own domains; if using RRF, fuse rank positions and test ties,
   single-leg hits, deterministic tie-breaks, candidate depth, and final limit.

9. **Exercise the production boundary.** Pair pure fusion/unit tests with a
   real-database test or smoke that executes the emitted predicate. If the DB
   smoke copies SQL, add an application test that pins statement shape and
   parameter order so the two cannot drift independently.

## Anti-patterns

- Treating parameterization and wildcard escaping as proof of semantic safety.
- Assuming a raw literal fallback is harmless because it sorts after full-text
  hits; it can still admit rows the primary language rejects.
- Detecting unary negation with a blanket `query.includes("-")` check.
- Claiming retrieval work is bounded solely because a candidate CTE has `LIMIT`.
- Proving index use only for a long, selective literal and generalizing to all
  accepted inputs.
- Testing RRF arithmetic while never executing the database candidate query.

## Verification

Before accepting the implementation, confirm:

- operator and punctuation truth-table cases match the documented contract;
- fallback rows cannot bypass negation or mandatory filters;
- internal identifier punctuation still reaches the intended exact-text path;
- short and pure-negative inputs have an explicit behavior and cost policy;
- production-shape plans are known for indexable and unindexable boundaries;
- candidate-limit documentation distinguishes returned rows from scan/sort work;
- every retrieval leg applies the same mandatory filters before ranking;
- production-path and real-database regressions cover the discovered boundaries.

## Related

When a hybrid leg uses HNSW, IVF, or another approximate index, combine this
procedure with
[`test-approximate-search-invariants`](../test-approximate-search-invariants/SKILL.md):
lexical set and cost contracts and probabilistic ANN guarantees require separate
tests.
