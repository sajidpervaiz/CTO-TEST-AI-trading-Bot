#!/usr/bin/env python3
"""Generate a live-trading config from settings.yaml with explicit safety toggles."""

from __future__ import annotations

from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
BASE_CONFIG = ROOT / "config" / "settings.yaml"
LIVE_CONFIG = ROOT / "config" / "settings.live.yaml"


def _load_yaml(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def _save_yaml(path: Path, data: dict) -> None:
    with path.open("w", encoding="utf-8") as fh:
        yaml.safe_dump(data, fh, sort_keys=False)


def _to_live_config(data: dict) -> dict:
    out = dict(data)

    system = dict(out.get("system", {}))
    system["paper_mode"] = False
    out["system"] = system

    exchanges = dict(out.get("exchanges", {}))
    for name, cfg in exchanges.items():
        if not isinstance(cfg, dict):
            continue
        if bool(cfg.get("enabled", False)):
            cfg = dict(cfg)
            cfg["testnet"] = False
            exchanges[name] = cfg
    out["exchanges"] = exchanges

    return out


def main() -> int:
    data = _load_yaml(BASE_CONFIG)
    live = _to_live_config(data)
    _save_yaml(LIVE_CONFIG, live)
    print(f"Generated {LIVE_CONFIG}")
    print("Live mode prepared: system.paper_mode=false, enabled exchanges testnet=false")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
