---
name: test-approximate-search-invariants
description: "Use when writing or reviewing CI and regression tests for approximate nearest-neighbor or probabilistic search indexes such as HNSW or IVF, especially when a test asserts exact recall, monotonic improvement from a tuning setting, or stable neighbors across index rebuilds. Separates deterministic application guarantees from statistical search-quality claims and provides a stable validation procedure."
---

# Test Approximate Search Invariants

Approximate search may vary with graph construction, insertion order, traversal,
ties, and scan bounds. Keep blocking CI on guarantees the application owns; put
recall quality in a seeded, statistical benchmark.

## When to use

- A blocking CI or regression test exercises an HNSW, IVF, or other approximate
  search path.
- A test assumes exact neighbors, stable ordering, a fixed result count, or
  monotonic improvement from a search setting.
- An application-level search contract must be separated from raw-engine recall
  behavior and search-quality measurement.

## Core distinction

Treat these as deterministic when the application or database contract makes them
so:

- filter semantics against an exact reference query;
- transaction or request scoping of search settings;
- restoration of pooled-connection state after success and failure;
- parameter binding and statement ordering in the application query path;
- every returned row satisfying mandatory filters;
- an application-level result-count or fallback guarantee the product explicitly
  owns;
- an intended index appearing in a deliberately stabilized planner fixture, when
  index use is itself a performance contract.

Treat these as statistical unless the engine explicitly guarantees otherwise:

- a raw approximate index scan returning exactly `LIMIT` rows merely because enough
  eligible rows exist;
- exact neighbor identities or ordering, especially among ties;
- one approximate scan returning at least as many rows as another;
- recall improving monotonically after a tuning change;
- identical results after rebuilding an ANN graph.

## Procedure

1. **Write the owned contract first.** List the behavior supplied by application
   code separately from the behavior delegated to the approximate engine. Cite the
   engine documentation for any claimed recall guarantee; absence of a guarantee
   means the raw-engine assertion is statistical. An application can still own a
   deterministic promise to return `k` eligible results through iterative scanning,
   overfetching, or an exact fallback; test that promise at the application boundary.

2. **Split correctness, planning, and quality fixtures.**
   - Use a small exact fixture or exact reference query for boolean filter counts
     and eligible-row existence.
   - Force any distance-ordered reference query through the engine's documented
     exact mode and assert its plan contains no approximate index. Do not infer
     exactness from an `ORDER BY <distance> LIMIT ...` SQL shape. For pgvector, use
     `SET LOCAL enable_indexscan = off` in a transaction and verify the reference
     plan does not use HNSW or IVFFlat.
   - Use a separately sized and analyzed fixture for `EXPLAIN` plan checks.
   - Do not use either as proof of recall quality.

3. **Exercise the real application boundary.** Prefer an integration test that
   invokes the production query path. If a database smoke test copies the SQL shape,
   pair it with an application test that pins parameter order and transaction
   sequencing; copied SQL alone cannot prove the application emitted it.

4. **Verify scoped configuration as state, not recall.** Capture the preexisting
   setting, enable the ANN option in the same transaction or request scope used by
   production, assert it is active while the query runs, then assert the original
   value returns after both commit and rollback.

   ```text
   before = read_setting()
   begin
   set_local(approximate_scan_option)
   assert read_setting() == requested_value
   run_filtered_search()
   commit
   assert read_setting() == before
   ```

5. **Separate raw ANN validity from application cardinality.** At the raw ANN
   boundary, assert that every returned row satisfies required inclusion,
   exclusion, tenancy, visibility, and deletion predicates. Prove separately with
   the forced exact reference path that the fixture contains eligible rows. Do not
   fail blocking CI merely because the raw approximate scan returned fewer than
   `LIMIT` unless the engine promises otherwise. If the application promises `k`
   eligible results, exercise the production boundary and require it to satisfy
   that count through its iterative scan, overfetch, or exact-fallback behavior.

6. **Stabilize planner assertions independently.** Load enough data, flush pending
   index work where applicable, refresh statistics, and make selectivity deliberate.
   Assert only the index or plan property the product depends on. Keep planner output
   out of semantic correctness assertions. If the plan still changes across the
   supported environments after deliberate fixture stabilization, move the assertion
   out of blocking CI instead of pinning unrelated planner knobs to force a pass.

7. **Rebuild and replay before trusting the test.** Recreate or reindex the ANN
   structure several times and rerun the smoke. This is a fragility probe, not proof
   of determinism: any outcome-dependent assertion that changes across rebuilds must
   leave blocking CI or be replaced with an owned invariant.

8. **Measure recall in a benchmark when it matters.** Compare ANN results with
   ground truth obtained through the forced and plan-verified exact mode from step 2.
   Use multiple seeds or rebuilds, record index version and settings, and report
   recall-at-k as a distribution or threshold with a justified tolerance. Keep that
   evaluation distinct from the deterministic regression suite.

## Anti-patterns

- Building adversarial tied vectors and asserting an exact ANN row count.
- Comparing two approximate scans and assuming the tuned scan must be greater than
  or equal to the baseline on every run.
- Rebuilding the index between baseline and treatment, then attributing the delta
  solely to the setting under test.
- Hard-coding the post-transaction default instead of restoring and comparing with
  the captured preexisting value.
- Treating repeated green runs as a mathematical guarantee.
- Letting an empty result make a returned-row filter assertion look meaningful;
  always pair it with exact evidence that eligible rows exist.
- Calling a reference query exact because its SQL looks exact without checking that
  the planner avoided the ANN index.
- Dropping an application-owned result-count contract merely because its first-stage
  ANN scan may underfill.

## Verification

Before accepting the test, confirm:

- exact filter semantics and recall ground truth run through a forced, plan-verified
  non-ANN path;
- the production query path applies and scopes the intended setting;
- commit and rollback both restore prior connection state;
- every returned ANN row satisfies all mandatory predicates;
- any application-owned result-count or fallback contract passes at the production
  boundary;
- the intended plan property survives repeated index rebuilds;
- no blocking raw-engine assertion depends on exact recall or neighbor identity;
- any recall claim lives in a seeded, ground-truthed statistical evaluation.

## Related

This procedure complements ordinary service and SQL integration testing. It does not
replace engine-specific tuning guidance or performance benchmarking.
