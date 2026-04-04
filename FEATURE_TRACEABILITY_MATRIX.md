# NUERAL-TRADER-5 100 Percent Traceability Matrix

Date: 2026-04-03
Scope: Tier0, Tier1, Tier2, bridge runtime APIs, dashboard runtime APIs, UI backend wiring
Validation basis: deep audit chain plus tests plus build checks

Status labels:
- VALIDATED means implemented and covered by tests and or audit gates
- IMPLEMENTED means code exists but strict gate coverage may be indirect

## Tier0 Core Safety

| Feature | Implementation Anchors | Validation Anchors | Status |
|---|---|---|---|
| Idempotency manager | core/idempotency.py:25, core/idempotency.py:47, core/idempotency.py:75 | tests/unit/test_nueral_trader_5_tier0_production.py:244, scripts/deep_audit_tier0.sh | VALIDATED |
| Circuit breaker | core/circuit_breaker.py:18 | tests/unit/test_nueral_trader_5_tier0_production.py:78, tests/unit/test_nueral_trader_5_tier0_production.py:84, tests/unit/test_nueral_trader_5_tier0_production.py:109, tests/unit/test_nueral_trader_5_tier0_production.py:129 | VALIDATED |
| Retry policy | core/retry.py:12 | tests/unit/test_nueral_trader_5_tier0_production.py:163, tests/unit/test_nueral_trader_5_tier0_production.py:182, scripts/deep_audit_tier0.sh | VALIDATED |
| Order manager lifecycle | execution/order_manager.py:144, execution/order_manager.py:271 | tests/unit/test_nueral_trader_5_tier0_production.py:219, tests/unit/test_nueral_trader_5_tier0_production.py:313, tests/unit/test_nueral_trader_5_tier0_production.py:362, tests/unit/test_nueral_trader_5_tier0_production.py:390 | VALIDATED |
| Risk manager baseline and stress | execution/risk_manager.py:82, execution/risk_manager.py:102, execution/risk_manager.py:195 | tests/integration/test_nueral_trader_5_dashboard_api_routes.py:114, scripts/deep_audit_tier0.sh | VALIDATED |

## Tier1 Revenue and Intelligence

| Feature | Implementation Anchors | Validation Anchors | Status |
|---|---|---|---|
| Smart order router | execution/smart_order_router.py:55 | tests/unit/test_nueral_trader_5_smart_order_router.py:38, tests/unit/test_nueral_trader_5_smart_order_router.py:59, scripts/deep_audit_tier1.sh:17 | VALIDATED |
| Feature engineering | engine/feature_engineering.py:28 | tests/unit/test_nueral_trader_5_feature_engineering.py:26, tests/unit/test_nueral_trader_5_feature_engineering.py:41, scripts/deep_audit_tier1.sh:17 | VALIDATED |
| Model trainer | engine/model_trainer.py:121 | tests/unit/test_nueral_trader_5_model_trainer.py:26, tests/unit/test_nueral_trader_5_model_trainer.py:41, scripts/deep_audit_tier1.sh:17 | VALIDATED |
| Ensemble scorer | engine/ensemble_scorer.py:53 | tests/unit/test_nueral_trader_5_ensemble_scorer.py:26, tests/unit/test_nueral_trader_5_ensemble_scorer.py:42, tests/unit/test_nueral_trader_5_ensemble_scorer.py:59, tests/unit/test_nueral_trader_5_ensemble_scorer.py:79, scripts/deep_audit_tier1.sh:17 | VALIDATED |
| Funding arbitrage detection | data_ingestion/funding_feed.py:51 | tests/unit/test_nueral_trader_5_funding_feed_arbitrage.py:9, tests/unit/test_nueral_trader_5_funding_feed_arbitrage.py:30, scripts/deep_audit_tier1.sh:17 | VALIDATED |
| Dashboard focused integration | interface/dashboard_api.py:113, interface/dashboard_api.py:114, interface/dashboard_api.py:115, interface/dashboard_api.py:116 | tests/integration/test_nueral_trader_5_dashboard_api_routes.py:78, tests/integration/test_nueral_trader_5_dashboard_api_routes.py:114, tests/integration/test_nueral_trader_5_dashboard_api_routes.py:143, tests/integration/test_nueral_trader_5_dashboard_api_routes.py:155, tests/integration/test_nueral_trader_5_dashboard_api_routes.py:176, scripts/deep_audit_tier1.sh:25 | VALIDATED |

## Tier2 Infrastructure and Rust

| Feature | Implementation Anchors | Validation Anchors | Status |
|---|---|---|---|
| Compose service wiring | docker-compose.prod.yml:5, docker-compose.prod.yml:16, docker-compose.prod.yml:28, docker-compose.prod.yml:42, docker-compose.prod.yml:58, docker-compose.prod.yml:75, docker-compose.prod.yml:99, docker-compose.prod.yml:118 | scripts/deep_audit_tier2.sh:32 | VALIDATED |
| Prometheus required jobs | monitoring/prometheus.yml:23, monitoring/prometheus.yml:30, monitoring/prometheus.yml:37 | scripts/deep_audit_tier2.sh:46 | VALIDATED |
| Alertmanager required receivers | monitoring/alertmanager.yml:20, monitoring/alertmanager.yml:25, monitoring/alertmanager.yml:30, monitoring/alertmanager.yml:38, monitoring/alertmanager.yml:42, monitoring/alertmanager.yml:48 | scripts/deep_audit_tier2.sh:51 | VALIDATED |
| Rust workspace membership and compile gate | rust/Cargo.toml, rust/risk-engine/src/lib.rs, rust/order-matcher/src/lib.rs, rust/tick-parser/src/lib.rs, rust/gateway/src/lib.rs | scripts/deep_audit_tier2.sh:64, scripts/deep_audit_tier2.sh:88 | VALIDATED |

## Bridge API Runtime Backend

| Feature | Implementation Anchors | Validation Anchors | Status |
|---|---|---|---|
| Persistent execution orders table | services/bridge-api/src/index.ts:220 | services/bridge-api/src/index.ts build check, runtime API checks during deep audit sequence | VALIDATED |
| Tool selection submit | services/bridge-api/src/index.ts:260 | scripts/deep_audit_tier0.sh route sanity and runtime checks | VALIDATED |
| Latest tool selection | services/bridge-api/src/index.ts:357 | scripts/deep_audit_tier0.sh route sanity and runtime checks | VALIDATED |
| Orders endpoint | services/bridge-api/src/index.ts:380 | runtime endpoint checks plus UI wiring checks | VALIDATED |
| Positions endpoint | services/bridge-api/src/index.ts:407 | runtime endpoint checks plus UI wiring checks | VALIDATED |
| PnL endpoint | services/bridge-api/src/index.ts:423 | runtime endpoint checks plus UI wiring checks | VALIDATED |
| Orderbook endpoint | services/bridge-api/src/index.ts:438 | runtime endpoint checks plus UI wiring checks | VALIDATED |

## Dashboard Config and Runtime API Backend

| Feature | Implementation Anchors | Validation Anchors | Status |
|---|---|---|---|
| Config route dynamic wiring | interface/routes/config.py:21, interface/dashboard_api.py:20, interface/dashboard_api.py:112 | tests/integration/test_nueral_trader_5_dashboard_api_routes.py:78, scripts/deep_audit_tier0.sh | VALIDATED |
| Dynamic algo config endpoints | interface/routes/config.py:141, interface/routes/config.py:161 | tests/integration/test_nueral_trader_5_dashboard_api_routes.py:114 | VALIDATED |
| Dynamic venue config endpoints | interface/routes/config.py:184 | tests/integration/test_nueral_trader_5_dashboard_api_routes.py:78 | VALIDATED |
| Aggregated config snapshot endpoint | interface/routes/config.py:244 | scripts/deep_audit_full.sh:45 route retention and app smoke checks | VALIDATED |
| Dynamic signals endpoint | interface/dashboard_api.py:192 | scripts/deep_audit_tier0.sh app route sanity | IMPLEMENTED |
| Dynamic performance endpoint | interface/dashboard_api.py:217 | scripts/deep_audit_tier0.sh app route sanity | IMPLEMENTED |

## UI to Backend Feature Wiring

| UI Function | UI Anchor | Backend Anchor | Status |
|---|---|---|---|
| Health polling | ui/app/src/App.tsx:118 | services/bridge-api/src/index.ts health route | VALIDATED |
| Latest event polling | ui/app/src/App.tsx:129 | services/bridge-api/src/index.ts:357 | VALIDATED |
| Orders polling | ui/app/src/App.tsx:136 | services/bridge-api/src/index.ts:380 | VALIDATED |
| Positions polling | ui/app/src/App.tsx:143 | services/bridge-api/src/index.ts:407 | VALIDATED |
| Orderbook polling | ui/app/src/App.tsx:151 | services/bridge-api/src/index.ts:438 | VALIDATED |
| Submission action | ui/app/src/App.tsx:193 | services/bridge-api/src/index.ts:260 | VALIDATED |

## Strict Gate Anchors

- scripts/deep_audit_tier1.sh:17
- scripts/deep_audit_tier1.sh:25
- scripts/deep_audit_tier2.sh:88
- scripts/deep_audit_full.sh:16
- scripts/deep_audit_full.sh:45
- scripts/deep_audit_full.sh:68

## Final Verification Snapshot

- Full deep audit command pass: scripts/deep_audit_full.sh
- Regression pass count: 96 tests
- Tier chain pass: Tier0 PASS, Tier1 PASS, Tier2 PASS, Full PASS

Conclusion:
This matrix provides line-level traceability for the currently defined strict audit scope and marks each listed feature as implemented or validated with direct anchors.
