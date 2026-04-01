from __future__ import annotations

import time
from typing import Any

from loguru import logger

try:
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware
    import uvicorn
    _FASTAPI = True
except ImportError:
    _FASTAPI = False

from core.config import Config
from core.event_bus import EventBus


def build_app(
    config: Config,
    event_bus: EventBus,
    risk_manager: Any = None,
    data_manager: Any = None,
) -> Any:
    if not _FASTAPI:
        return None

    app = FastAPI(
        title="Neural Trader v4",
        description="Hybrid Rust+TypeScript+Python trading engine",
        version="4.0.0",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "paper_mode": config.paper_mode,
            "timestamp": int(time.time()),
        }

    @app.get("/positions")
    async def get_positions() -> dict[str, Any]:
        if risk_manager is None:
            return {"positions": [], "equity": 0.0}
        positions = risk_manager.positions
        return {
            "positions": [
                {
                    "exchange": p.exchange,
                    "symbol": p.symbol,
                    "direction": p.direction,
                    "size": p.size,
                    "entry_price": p.entry_price,
                    "current_price": p.current_price,
                    "pnl": p.pnl,
                    "pnl_pct": p.pnl_pct,
                }
                for p in positions.values()
            ],
            "equity": risk_manager.equity,
            "count": len(positions),
        }

    @app.get("/config/summary")
    async def config_summary() -> dict[str, Any]:
        return {
            "paper_mode": config.paper_mode,
            "enabled_exchanges": [
                k for k, v in (config.get_value("exchanges") or {}).items()
                if v.get("enabled", False)
            ],
            "dex_enabled": config.get_value("dex", "enabled") or False,
            "rust_enabled": config.get_value("rust_services", "enabled") or False,
            "ts_dex_enabled": config.get_value("ts_dex_layer", "enabled") or False,
        }

    return app


async def run_dashboard(config: Config, app: Any) -> None:
    if not _FASTAPI or app is None:
        return
    api_cfg = config.get_value("monitoring", "dashboard_api") or {}
    host = api_cfg.get("host", "0.0.0.0")
    port = int(api_cfg.get("port", 8000))
    server_config = uvicorn.Config(app, host=host, port=port, log_level="warning")
    server = uvicorn.Server(server_config)
    logger.info("Dashboard API starting on http://{}:{}", host, port)
    await server.serve()
