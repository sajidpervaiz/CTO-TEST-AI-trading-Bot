#!/usr/bin/env python3
"""Preflight validation before enabling live auto-trading."""

from __future__ import annotations

import os
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "config" / "settings.live.yaml"
REQUIRED_ENV_VARS = (
    "BINANCE_API_KEY",
    "BINANCE_API_SECRET",
)


def _load(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def _fail(message: str) -> int:
    print(f"FAIL: {message}")
    return 1


def main() -> int:
    cfg_path = Path(os.getenv("NT_CONFIG_PATH", str(DEFAULT_CONFIG))).resolve()
    if not cfg_path.exists():
        return _fail(f"config not found: {cfg_path}")

    data = _load(cfg_path)
    system = data.get("system", {})
    exchanges = data.get("exchanges", {})

    if bool(system.get("paper_mode", True)):
        return _fail("paper_mode is true (live trading disabled)")

    enabled = [
        (name, cfg) for name, cfg in exchanges.items() if isinstance(cfg, dict) and bool(cfg.get("enabled", False))
    ]
    if not enabled:
        return _fail("no enabled exchanges configured")

    bad_testnet = [name for name, cfg in enabled if bool(cfg.get("testnet", True))]
    if bad_testnet:
        return _fail(f"enabled exchanges still using testnet: {', '.join(bad_testnet)}")

    missing_env = [key for key in REQUIRED_ENV_VARS if not os.getenv(key)]
    if missing_env:
        return _fail(f"missing required env vars: {', '.join(missing_env)}")

    print(f"PASS: live preflight checks succeeded for {cfg_path}")
    print("PASS: auto-trading mode can be started with NT_CONFIG_PATH set")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
