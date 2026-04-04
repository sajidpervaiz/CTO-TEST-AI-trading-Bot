from __future__ import annotations

import time
from collections import defaultdict
from typing import Any

from loguru import logger

try:
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.staticfiles import StaticFiles
    from fastapi.responses import FileResponse
    import uvicorn
    _FASTAPI = True
except ImportError:
    _FASTAPI = False

from pathlib import Path

from core.config import Config
from core.event_bus import EventBus
from interface.routes.config import router as config_router, configure_config_routes
from interface.routes.orders import router as orders_router, configure_order_routes
from interface.routes.positions import router as positions_router, configure_positions_routes
from interface.routes.risk import router as risk_router, configure_risk_routes


def build_app(
    config: Config,
    event_bus: EventBus,
    risk_manager: Any = None,
    data_manager: Any = None,
    order_manager: Any = None,
    db_handler: Any = None,
    cache: Any = None,
) -> Any:
    if not _FASTAPI:
        return None

    app = FastAPI(
        title="NUERAL-TRADER-5",
        description="Hybrid Rust+TypeScript+Python trading engine",
        version="4.0.0",
    )
    app.state.started_at = int(time.time())
    static_dir = Path(__file__).resolve().parent / "static"
    static_index = static_dir / "index.html"

    dashboard_cfg = config.get_value("monitoring", "dashboard_api", default={}) or {}
    cors_origins = dashboard_cfg.get("allow_origins") or ["http://localhost", "http://127.0.0.1"]
    auth_cfg = dashboard_cfg.get("auth", {}) if hasattr(dashboard_cfg, "get") else {}
    if not isinstance(auth_cfg, dict):
        auth_cfg = {}

    require_api_key = bool(auth_cfg.get("require_api_key", False))
    api_key = str(auth_cfg.get("api_key", "") or "").strip()
    rate_limit_per_min = int(auth_cfg.get("rate_limit_per_min", 120))
    allow_unauthenticated_non_paper = bool(auth_cfg.get("allow_unauthenticated_non_paper", False))

    # Secure-by-default posture: non-paper mode requires API auth unless explicitly overridden.
    if not config.paper_mode and not require_api_key and not allow_unauthenticated_non_paper:
        require_api_key = True
        logger.warning(
            "Enabling API key requirement automatically for non-paper mode; "
            "set monitoring.dashboard_api.auth.allow_unauthenticated_non_paper=true to override"
        )
    exempt_paths = {
        "/",
        "/health",
        "/docs",
        "/openapi.json",
        "/redoc",
    }

    # In-memory limiter is sufficient for single-instance Tier 0 deployments.
    ip_rate_state: dict[str, dict[str, int]] = defaultdict(lambda: {"window_start": 0, "count": 0})

    @app.middleware("http")
    async def api_guard(request: Request, call_next):
        path = request.url.path
        if path not in exempt_paths:
            if rate_limit_per_min > 0:
                ip = request.client.host if request.client else "unknown"
                now = int(time.time())
                state = ip_rate_state[ip]
                if now - state["window_start"] >= 60:
                    state["window_start"] = now
                    state["count"] = 0
                state["count"] += 1
                if state["count"] > rate_limit_per_min:
                    return JSONResponse(status_code=429, content={"detail": "rate_limit_exceeded"})

            if require_api_key and api_key:
                provided = request.headers.get("x-api-key")
                if not provided:
                    auth_header = request.headers.get("authorization", "")
                    if auth_header.lower().startswith("bearer "):
                        provided = auth_header[7:].strip()
                if provided != api_key:
                    return JSONResponse(status_code=401, content={"detail": "unauthorized"})
            elif require_api_key and not api_key:
                return JSONResponse(status_code=503, content={"detail": "api_auth_misconfigured"})

        return await call_next(request)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    if static_dir.exists():
        app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

    configure_order_routes(order_manager)
    configure_risk_routes(risk_manager)
    configure_positions_routes(risk_manager)
    configure_config_routes(config, risk_manager, order_manager)
    app.include_router(config_router)
    app.include_router(orders_router)
    app.include_router(positions_router)
    app.include_router(risk_router)

    @app.get("/")
    async def root() -> Any:
        if static_index.exists():
            return FileResponse(str(static_index))
        return {
            "message": "NUERAL-TRADER-5 Dashboard",
            "docs": "/docs",
            "health": "/health",
            "positions": "/positions",
            "config": "/config/summary",
        }

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

    @app.get("/features")
    async def features_status() -> dict[str, Any]:
        dex_config = config.get_value("dex") or {}
        return {
            "enabled": {
                "cex_trading": True,
                "dex_trading": dex_config.get("enabled", False),
                "uniswap": dex_config.get("uniswap", {}).get("enabled", False),
                "sushiswap": dex_config.get("sushiswap", {}).get("enabled", False),
                "pancakeswap": dex_config.get("pancakeswap", {}).get("enabled", False),
                "dydx": dex_config.get("dydx", {}).get("enabled", False),
                "ts_dex_layer": config.get_value("ts_dex_layer", "enabled", False),
                "funding_rates": config.get_value("macro", "funding_rates", {}).get("enabled", False),
                "open_interest": config.get_value("macro", "open_interest", {}).get("enabled", False),
                "vix_proxy": config.get_value("macro", "vix_proxy", {}).get("enabled", False),
            },
            "chains": ["ethereum", "bsc", "arbitrum", "dydx_chain"] if dex_config.get("enabled") else [],
            "protocols": ["uniswap_v3", "sushiswap", "pancakeswap_v3", "dydx_perpetuals"],
        }

    @app.get("/signals/recent")
    async def recent_signals() -> dict[str, Any]:
        signals: list[dict[str, Any]] = []
        if order_manager is not None:
            recent_orders = sorted(order_manager.orders.values(), key=lambda o: o.created_at, reverse=True)[:25]
            for order in recent_orders:
                signals.append(
                    {
                        "symbol": order.symbol,
                        "direction": "long" if str(order.side.value).lower() == "buy" else "short",
                        "score": float(order.metadata.get("score", 0.7)),
                        "confidence": float(order.metadata.get("confidence", 0.75)),
                        "timestamp": int(order.created_at),
                        "technical_score": float(order.metadata.get("technical_score", 0.7)),
                        "ml_score": float(order.metadata.get("ml_score", 0.7)),
                        "sentiment_score": float(order.metadata.get("sentiment_score", 0.5)),
                        "source": "order_flow",
                    }
                )
        return {
            "signals": signals[:20],
            "total_today": len(signals),
            "win_rate": None,
        }

    @app.get("/performance")
    async def performance_metrics() -> dict[str, Any]:
        pnl_total = 0.0
        pnl_pct = 0.0
        trades_total = 0
        trades_closed = 0
        trades_open = 0
        total_fees = 0.0
        if risk_manager is not None:
            pnl_total = float(sum(p.pnl for p in risk_manager.positions.values()))
            equity = float(max(1.0, risk_manager.equity))
            pnl_pct = float((pnl_total / equity) * 100.0)
        if order_manager is not None:
            stats = order_manager.get_stats()
            trades_total = int(stats.get("total_orders", 0))
            trades_open = int(stats.get("open_orders", 0))
            trades_closed = int(stats.get("filled_orders", 0))
            total_fees = float(stats.get("total_fees", 0.0))
        return {
            "pnl_total": pnl_total,
            "pnl_pct": pnl_pct,
            "win_rate": None,
            "trades_total": trades_total,
            "trades_closed": trades_closed,
            "trades_open": trades_open,
            "sharpe_ratio": None,
            "max_drawdown_pct": None,
            "daily_pnl": pnl_total,
            "total_fees": total_fees,
        }

    @app.get("/system/stats")
    async def system_stats() -> dict[str, Any]:
        db_connected = bool(getattr(db_handler, "available", False))
        cache_connected = bool(getattr(cache, "available", False))
        now = int(time.time())
        started_at = int(getattr(app.state, "started_at", now))
        feeds_connected = 0
        if data_manager is not None:
            feeds_connected = len(getattr(data_manager, "_aggregators", {}))

        websockets_active = 0
        if event_bus is not None:
            websockets_active = int(getattr(event_bus, "_queue", None).qsize()) if hasattr(getattr(event_bus, "_queue", None), "qsize") else 0
        return {
            "uptime_seconds": max(0, now - started_at),
            "feeds_connected": feeds_connected,
            "websockets_active": websockets_active,
            "db_connected": db_connected,
            "cache_connected": cache_connected,
            "timestamp": now,
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
