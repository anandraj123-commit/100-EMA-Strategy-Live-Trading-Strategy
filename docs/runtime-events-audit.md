# Runtime event recorder — audit and implementation report

## Audit performed before implementation

The existing application uses the native MongoDB driver, not Mongoose. No dependencies or connection architecture were changed.

| Area | Authoritative files and flow |
| --- | --- |
| Decision generation | `worker.ts`: `refreshCandlesIfNeeded`, `cycle`, `strategyLifecycleLog`, `upsertUiLog`, `recordDecisionLogEvent`, `decisionLogRuntime`. New completed candles create presentation rows; later polls and execution events merge updates into those rows. |
| Decision presentation | `lib/decision-log.ts`, `components/DecisionLogRow.tsx`, `lib/state.ts`, `lib/settings/status.ts`, `app/api/status/route.ts`. The worker writes portfolio status files containing up to 60 decision rows. Existing UI/API behavior is unchanged. |
| Strategy | `lib/strategy.ts`: `emaSeries`, `evaluateSetup`; `lib/pending.ts`: `pendingEntryEligible`, `pendingSetupExpired`; worker breakout/risk gates and `lib/runtime/final-preorder.ts`. These remain authoritative and unchanged. |
| Execution | Worker entry branch, `lib/entry-intents/identity.ts`, `service.ts`, `repository.ts`, and `lib/delta.ts`. Prepared intent, final pre-order guards, market submission, response, durable ownership, protection. |
| Permanent trades | `models/Trade.ts`, `lib/trades/persistence.ts`, `lifecycle.ts`, `reconciliation.ts`, `repository.ts`, `fill-claims.ts`. Existing weighted averages, attributed fills, execution metrics, financials, CAS lifecycle updates, and fill claims remain authoritative. |
| Synchronization | Worker `refreshPosition`, `syncManualLifecycleLedger`, stale bot/manual reconciliation and attribution retry. Position and protection refresh intervals are 5 seconds; wallet refresh is 30 seconds; stale reconciliation/attribution retry use 60 seconds. Existing ticker polling remains configurable. |
| Protection | `lib/trades/protection.ts`, `protection-reconciliation.ts`, worker `syncExchangeBracket`, repository protection mutations. Existing exchange inspection, ownership, trigger methods, submission claims, repair barriers and verification are preserved. Repeated successful observations occur without changes. |
| Robot | `app/api/control/route.ts`, `lib/state.ts`, settings repository and worker control handling. STOP clears executable pending setups. Contrary to a possible assumption in the task examples, this application deliberately continues completed-candle analysis while stopped, plus position/protection monitoring. |
| MongoDB / modes | `lib/db/mongodb.ts`, `lib/app-mode.ts`, `lib/config.ts`. One shared existing client; immutable APP_MODE selects suffixed URI/database settings. No new client, environment selection, or fallback was introduced. |
| Portfolios/settings | `models/Portfolio.ts`, `models/RuntimeSettings.ts`, respective repositories. Portfolio ObjectIds, portfolio settings IDs, portfolio child workers and existing leases remain unchanged. |

Candle identity is the exchange candle's opening timestamp in seconds. A completed candle satisfies the existing worker completion filter; publication grace and resolution remain unchanged. New decision frequency follows the configured resolution, default 5m. Multiple patches can update the same row within one poll, and polls can update the same candle repeatedly.

Complete rows include `candleTime`, `loggedAt`, OHLC, `price`, `ema`, `buy`, `sell`, `setup`, `strategyLifecycle`, `pending`, `account`, `decision`, and, when emitted, `runtimeObservation`, `breakout`, `risk`, `order`, `executionDecision`, `observationBlockReason`, `entryStage`, `entryProgress`, and `entryEvent`. The logger copies the entire row rather than a field whitelist, so additional useful fields are retained.

Existing correlation identities include portfolio ID, environment/product/symbol, signal candle timestamp, entry intent ID, client order ID, exchange order/fill IDs, and stable permanent trade ID. There is no universal existing setup/lifecycle ID. Logging correlation strings use existing signal/candle identities and do not change any trading ID.

Existing tests inspected cover strategy contracts, pending expiry, final pre-order races, entry intents, decision presentation, trade lifecycle/fill attribution, protection repair/hardening, robot restart/control, APP_MODE, portfolios, and real MongoDB persistence. No protected test or strategy expectation was modified.

No unrelated application bug was confirmed during this work. No unrelated bug fix was made.

## Files and passive attachments

Created:

- `models/RuntimeEvent.ts`: TypeScript document interface and six event categories.
- `lib/runtime-events/logger.ts`: snapshotting, meaningful-state projection, identity, bounded queue, asynchronous persistence.
- `lib/runtime-events/sanitizer.ts`: centralized recursive sanitization.
- `lib/runtime-events/repository.ts`: collection, atomic writes, index initialization and verification.
- `tests/runtime-events.test.ts`, `tests/runtime-events-mongo.test.ts`.
- This report and `docs/runtime-event-examples.json`.

Modified:

- `worker.ts`: observe merged decision rows, existing trade events, entry submission results, position reconciliation, execution-enabled observations and caught cycle errors.
- `lib/state.ts`: observe actual successful control transitions; re-export the observer through the existing state boundary.
- `lib/trades/repository.ts`: observe successful existing lifecycle CAS mutations and their protection state. The returned record, CAS filter/update and permanent indexes remain unchanged. Naming the existing return object is the only small structural adjustment.
- `lib/trades/persistence.ts`: observe already-attributed close fills and already-calculated open execution patches with their associated fills.
- `tests/active-trade-lifecycle.test.ts`: register the new logger dependency in its VM fixture, backed by a failing persistence sink. All existing assertions remain unchanged. The first validation attempt's 47 failures were missing fixture dependency errors, not changed outcomes.

No UI, API contract, strategy, Delta request implementation, settings behavior, polling interval or permanent trade schema changed.

## MongoDB schema and indexes

Collection: **`runtime_events`**, shared by portfolios inside the existing APP_MODE-selected database.

Common fields: `portfolioId`, optional `symbol`, `eventType`, `event`, optional `eventKey`, `streamKey`, `correlationId`, `tradeId`, `orderId`, `createdAt`, `updatedAt`.

Decision fields: `resolution`, `candleStartTime`, complete `current`, initial `settingsSnapshot`, meaningful `history` entries `{at,state}`, and `stateSignature`.

Other event documents contain complete sanitized observation `data`, including contextual snapshots when available. Raw exchange/fill timestamps retain their original representation; existing Date values remain Dates. `candleStartTime` is a UTC BSON Date converted from the existing numeric identity. Existing `loggedAt`/observation strings are preserved verbatim. Logger timestamps describe recording time, not invented exchange acceptance/fill times.

Indexes, in addition to MongoDB's `_id` index:

| Name | Key / options |
| --- | --- |
| `runtime_ttl` | `{createdAt:1}`, `expireAfterSeconds:604800` |
| `decision_identity` | `{portfolioId:1,symbol:1,resolution:1,candleStartTime:1}`, unique, partial filter `{eventType:'DECISION'}` |
| `runtime_event_identity` | `{portfolioId:1,eventKey:1}`, unique, partial filter `{eventKey:{$type:'string'}}` |
| `runtime_portfolio_time` | `{portfolioId:1,createdAt:-1}` |
| `runtime_symbol_time` | `{portfolioId:1,symbol:1,createdAt:-1}` |
| `runtime_type_time` | `{eventType:1,createdAt:-1}` |
| `runtime_trade` | `{tradeId:1}`, sparse |
| `runtime_correlation` | `{correlationId:1}`, sparse |

All requested query patterns were evaluated and indexed. Initialization follows the existing repository pattern, then reads `listIndexes()` and verifies key, TTL, uniqueness, sparse and partial-filter options. Runtime writes reacquire the existing database handle, including after reconnects. No permanent trade index is modified.

Expiration is approximately seven days from original document creation. Updates never reset that origin. MongoDB performs asynchronous per-document TTL deletion; it is not a weekly collection purge. See [MongoDB TTL documentation](https://www.mongodb.com/docs/manual/core/index-ttl/).

## Decision behavior

Atomic aggregation-pipeline upserts use the portfolio/symbol/resolution/candle identity. The partial unique index also protects concurrent first inserts; duplicate-key races retry against the existing document.

`current` is replaced with the complete sanitized merged row. `history` appends only when the meaningful state signature differs from the stored signature. It preserves lifecycle, decision/guard reasons, pending/setup, order and entry stages, and meaningful runtime position/exit state. Live prices and observation timestamps do not generate history. Consecutive queued price-only updates can be coalesced while retaining the newest full row; queued meaningful transitions remain separate.

The initial settings snapshot is taken synchronously with the real observation using the existing `runtimeConfigSnapshot()` plus revision IDs, then preserved on updates. A bounded cache retains the original row's resolution/settings when later observations occur. Final entry settings, risk and sizing are additionally recorded from the actual prepared intent and submission result. Historical settings are never retrieved later and assigned retroactively.

Subsequent completed candles remain separate decision documents, matching the UI's real rows. Signal correlation links a setup across those rows. The logger does not merge later candles into T0 or rewrite old decisions to imply the worker updated them.

Finalization is deliberately **not implemented**: the application has no universal authoritative terminal marker for a presentation row, and an active setup may cross candle boundaries. No timestamp-based finalization is invented.

## Lifecycle events and duplicate control

- Existing trade-event names/details are preserved; categories are assigned centrally. A name such as `ENTRY_SUBMISSION_STARTED` retains its existing meaning, which precedes the final dispatch guards; it is not relabeled as proof of exchange acceptance.
- `ENTRY_SUBMISSION_RESULT` stores the existing intent and result, including confirmed/ambiguous/rejected status and available response information.
- `TRADE_LIFECYCLE_UPDATED` captures useful permanent lifecycle snapshots, including fills, partial exits, entry/exit prices, risk/fees and financial updates. It does not recalculate them.
- `EXECUTION_FILL_EVIDENCE` and `CLOSED_TRADE_FILL_EVIDENCE` preserve existing attributed evidence. Open evidence includes only fills whose IDs belong to that execution patch, not unrelated account fills.
- `POSITION_RECONCILED` captures previous quantity, exchange quantity/entry, attribution and reconciliation-pending state, with available exchange/local context. Unchanged checks do not create repeated documents. Existing mismatch/action/reconciliation events are also recorded.
- Protection observations include state, current SL/TP, exchange order IDs, trigger methods, submissions and modification histories. Existing repair, verification failure and protection failure events are retained.
- Successful control changes emit `ROBOT_STARTED`/`ROBOT_STOPPED`. Rewriting the same control state emits neither. A UUID is generated once per actual transition because there is no existing control-event ID; this also distinguishes rapid start/stop/start transitions within one millisecond. Execution-enabled observations are separate from control transitions.
- Important errors preserve sanitized messages/context. Identical errors are limited to one event per five-minute bucket; changed details remain distinguishable.

Hashes use event name, portfolio/symbol scope, authoritative event details and available trade/signal identity. Presentation-only random UI IDs and timestamps are excluded from deduplication. Stable MongoDB event keys protect repeated durable observations across worker restarts. State streams compare their latest stored signature and anchor a new event key to the previous event, preserving genuine A → B → A changes rather than suppressing every historical repeat. Raw context remains available even when volatile context is excluded from identity. The in-memory duplicate cache is bounded to 1,024 entries.

No new independent market polling, reconciliation or protection observation loop was added.

## Failure isolation and limits

No runtime write is awaited by trading, protection, reconciliation, control or permanent persistence. Observation snapshotting/enqueueing is synchronous bounded work; database writes drain later, serially. The queue allows up to 512 pending operations / 8 MiB, and rejects individual operations larger than 512 KiB. Settings/dedup caches are bounded. Database operations use a 2-second server execution limit; connection selection still follows existing connection configuration. There is no additional database client.

Observer errors and rejected writes are caught internally. Diagnostics are exposed as `runtimeRecorder.diagnostics` (`written`, `failed`, `dropped`). No logger failure is fed back into trading decisions, robot state or existing error guards.

This is **best-effort asynchronous recording**, not a durable message broker. A crash, prolonged outage, oversized observation or saturated queue can lose pending records. There is no blocking shutdown flush or unlimited retry spool. MongoDB/storage/CPU resources are shared; no claim of literally zero computational overhead is made. These limits preserve the requirement that logging cannot become a trading prerequisite.

Sanitization removes credential-like fields recursively, redacts configured secret values in strings, MongoDB URIs, bearer tokens, Telegram token patterns and credential assignments. Errors are reduced to safe name/message fields. There is no environment/config dump. Oversized records are dropped, not silently presented as complete truncated records.

The logger does not persist global supervisor errors without a portfolio identity. It does not invent missing exchange timestamps, fill events, candle close fields or lifecycle terminal states. Samples are synthetic, not production observations.

Seven days of retention is not a guarantee that arbitrarily many portfolios fit within 512 MB. Complete decisions, compact transition history, deduplicated synchronization and bounded raw evidence avoid routine duplication; actual capacity depends on portfolio count, resolution and event volume.

## Validation results

Final command (with `TRADE_TEST_MONGODB_URI` and `AUTH_TEST_MONGODB_URI` supplied externally for the isolated test database):

```sh
npm run validate
```

**838 tests passed, 0 failed, 0 skipped.** Typecheck, production build, secret scan and diff checks passed. All MongoDB tests used isolated temporary test databases on a local test server; production was not queried or changed.

Dedicated protected suite: `node --import tsx --test tests/strategy-regression/*.test.ts` — **53 passed**. The subsequent combined contract/new-unit run passed **62 tests**. The full final validation includes those same suites.

Added coverage includes full snapshots/immutability, settings, timestamps, live-only history suppression, bounded/hanging/failing queues, category/idempotency/isolation tests, real worker order/protection comparison under logging failure, stopped open-position monitoring, sanitizer tests, robot transitions including same-millisecond restarts, real MongoDB concurrent upserts, restart deduplication, partial uniqueness, retained TTL origin, all index options, permanent trades without TTL, and reconnect behavior.

Existing executable lifecycle tests now also run with a failing audit sink; their expected trading behavior remains unchanged. Existing decision, execution, pending, protection, reconciliation, portfolio, APP_MODE, backtesting and trade persistence tests passed in full validation.

## Verified safety checklist

```text
Existing strategy logic changed: NO
Existing BUY/SELL rules changed: NO
Existing EMA/slope logic changed: NO
Existing pending logic changed: NO
Existing breakout logic changed: NO
Existing entry-valid-candle behavior changed: NO
Existing execution guards changed: NO
Existing order execution changed: NO
Existing risk calculation changed: NO
Existing position sizing changed: NO
Existing RR calculation changed: NO
Existing SL/TP behavior changed: NO
Existing protection behavior changed: NO
Existing reconciliation behavior changed: NO
Existing synchronization frequency changed: NO
Existing AUTO_TRADE behavior changed: NO
Existing robot START behavior changed: NO
Existing robot STOP behavior changed: NO
Existing open-position monitoring changed: NO
Existing permanent trades behavior changed: NO
Existing Decision Logs UI behavior changed: NO
Existing APP_MODE behavior changed: NO
Existing portfolio isolation changed: NO
Existing backtesting behavior changed: NO

runtime_events collection added: YES
Complete decision logs persisted: YES
Meaningful trade logs persisted: YES
Meaningful synchronization logs persisted: YES
Meaningful protection logs persisted: YES
Robot lifecycle logs persisted: YES
Important error logs persisted: YES
7-day TTL applied to runtime_events: YES
TTL applied to permanent trades: NO
Duplicate decision documents prevented: YES
Repeated identical sync flooding prevented: YES
Secrets protected: YES
Runtime logging can block trading: NO awaited persistence dependency
Runtime logging failure can alter trading result: NO control-flow dependency; exercised with failing writes
```

The persistence statements describe normal successful operation, not guaranteed delivery during the explicitly documented failure/overflow cases. TTL/indexes were verified on the isolated MongoDB; deployment initializes/verifies them on first queued runtime write using its own existing APP_MODE database.

## Six sanitized sample documents

See [`runtime-event-examples.json`](runtime-event-examples.json) for DECISION, TRADE, SYNC, PROTECTION, ROBOT and ERROR documents generated from the implemented recorder's write payloads. `_id` is omitted; JSON serializes BSON Date fields as ISO strings. The examples demonstrate the actual schema with small synthetic observations. Production `current`/`data` retain all supplied useful fields, not only those illustrated.
