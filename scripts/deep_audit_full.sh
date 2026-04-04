#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "============================================="
echo "FULL REPOSITORY DEEP AUDIT"
echo "Repo: NUERAL-TRADER-5"
echo "Date: $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
echo "============================================="

echo "[1/6] Running Tier 2 gate (includes Tier 1 and Tier 0 gates)..."
bash scripts/deep_audit_tier2.sh

echo "[2/6] Running full regression suite..."
pytest -q

echo "[3/6] Verifying critical feature files exist..."
required_files=(
  "core/idempotency.py"
  "core/circuit_breaker.py"
  "core/retry.py"
  "execution/order_manager.py"
  "execution/smart_order_router.py"
  "execution/risk_manager.py"
  "engine/feature_engineering.py"
  "engine/model_trainer.py"
  "engine/ensemble_scorer.py"
  "data_ingestion/funding_feed.py"
  "interface/dashboard_api.py"
  "scripts/deep_audit_tier0.sh"
  "scripts/deep_audit_tier1.sh"
  "scripts/deep_audit_tier2.sh"
)

for f in "${required_files[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "MISSING: $f"
    exit 1
  fi
  echo "OK: $f"
done

echo "[4/6] Verifying API route retention..."
python - <<'PY'
from core.config import Config
from core.event_bus import EventBus
from interface.dashboard_api import build_app

app = build_app(Config("config/settings.yaml"), EventBus())
routes = {getattr(r, "path", None) for r in app.routes}
required = {
    "/health",
    "/orders/place",
    "/orders/open",
    "/orders/{order_id}",
  "/risk/limits",
  "/risk/check",
  "/risk/circuit-breaker",
}
missing = sorted(p for p in required if p not in routes)
if missing:
    raise SystemExit(f"MISSING_ROUTES: {missing}")
print(f"ROUTE_RETENTION_OK routes={len(routes)} verified={len(required)}")
PY

echo "[5/6] Guardrail: ensure no tracked feature file deletions in working tree..."
python - <<'PY'
from pathlib import Path
import subprocess


def deleted_files() -> list[str]:
  out = subprocess.check_output(
    ["git", "diff", "--name-status", "--diff-filter=D"],
    text=True,
  ).strip()
  if not out:
    return []
  deleted: list[str] = []
  for line in out.splitlines():
    parts = line.split("\t")
    if len(parts) == 2 and parts[0] == "D":
      deleted.append(parts[1])
  return deleted


def is_allowed_rename(old_path: str) -> bool:
  p = Path(old_path)
  if p.name.startswith("test_") and p.suffix == ".py" and "tests" in p.parts:
    replacement = p.with_name(f"test_nueral_trader_5_{p.stem[5:]}.py")
    return replacement.exists()

  if old_path == "tests/integration/test_dashboard_api_routes.py":
    return Path("tests/integration/test_nueral_trader_5_dashboard_api_routes.py").exists()

  if old_path == "ts/dex-layer/src/uniswap/executor.test.ts":
    return Path("ts/dex-layer/src/uniswap/test_nueral_trader_5_executor.test.ts").exists()

  return False


deleted = deleted_files()
unexpected = [d for d in deleted if not is_allowed_rename(d)]

if unexpected:
  print("DELETION_DETECTED_UNEXPECTED")
  for item in unexpected:
    print(f"D\t{item}")
  raise SystemExit(1)

print("NO_UNEXPECTED_TRACKED_DELETIONS")
if deleted:
  print(f"ALLOWED_RENAME_DELETIONS={len(deleted)}")
PY

echo "[6/6] Checking Tier 2 recall artifact..."
if [[ -f "TIER2_DEEP_AUDIT_RECALL.md" ]]; then
  echo "RECALL_AUDIT_OK TIER2_DEEP_AUDIT_RECALL.md"
else
  echo "RECALL_AUDIT_MISSING TIER2_DEEP_AUDIT_RECALL.md"
  exit 1
fi

echo "============================================="
echo "FULL REPOSITORY DEEP AUDIT: PASS"
echo "============================================="
