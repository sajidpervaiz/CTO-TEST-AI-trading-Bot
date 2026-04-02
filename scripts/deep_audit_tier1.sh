#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

echo "============================================="
echo "TIER 1 DEEP AUDIT"
echo "Repo: CTO-TEST-AI-trading-Bot"
echo "Date: $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
echo "============================================="

echo "[1/4] Verifying Tier 0 baseline gate..."
bash scripts/deep_audit_tier0.sh

echo "[2/4] Running Tier 1 unit validation suite..."
pytest -q \
  tests/unit/test_smart_order_router.py \
  tests/unit/test_feature_engineering.py \
  tests/unit/test_model_trainer.py \
  tests/unit/test_ensemble_scorer.py \
  tests/unit/test_funding_feed_arbitrage.py

echo "[3/4] Running focused integration gate..."
pytest -q tests/integration/test_dashboard_api_routes.py

echo "[4/4] Static file existence sanity checks..."
required_files=(
  "execution/smart_order_router.py"
  "engine/feature_engineering.py"
  "engine/model_trainer.py"
  "engine/ensemble_scorer.py"
  "data_ingestion/funding_feed.py"
)

for f in "${required_files[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "MISSING: $f"
    exit 1
  fi
  echo "OK: $f"
done

echo "============================================="
echo "TIER 1 DEEP AUDIT: PASS"
echo "============================================="
