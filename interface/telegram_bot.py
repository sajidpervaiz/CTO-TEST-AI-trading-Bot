from __future__ import annotations

import asyncio
from typing import Any

from loguru import logger

try:
    from telegram import Bot
    from telegram.error import TelegramError
    _TELEGRAM = True
except ImportError:
    _TELEGRAM = False

from core.config import Config
from core.event_bus import EventBus


class TelegramNotifier:
    def __init__(self, config: Config, event_bus: EventBus) -> None:
        self.config = config
        self.event_bus = event_bus
        self._bot: Any = None
        self._chat_id: str = ""
        self._running = False
        self._queue: asyncio.Queue[str] = asyncio.Queue(maxsize=100)

    async def _init_bot(self) -> bool:
        tg_cfg = self.config.get_value("monitoring", "telegram") or {}
        if not tg_cfg.get("enabled", False):
            return False
        if not _TELEGRAM:
            logger.warning("python-telegram-bot not installed")
            return False
        token = tg_cfg.get("token", "")
        self._chat_id = str(tg_cfg.get("chat_id", ""))
        if not token or not self._chat_id:
            return False
        try:
            self._bot = Bot(token=token)
            await self._bot.get_me()
            return True
        except Exception as exc:
            logger.warning("Telegram init failed: {}", exc)
            return False

    async def send(self, message: str) -> None:
        if self._bot is None:
            return
        try:
            await self._bot.send_message(chat_id=self._chat_id, text=message, parse_mode="HTML")
        except Exception as exc:
            logger.debug("Telegram send error: {}", exc)

    async def _handle_signal(self, payload: Any) -> None:
        signal = payload
        msg = (
            f"📊 <b>Signal</b> [{signal.exchange}/{signal.symbol}]\n"
            f"Direction: {signal.direction.upper()}\n"
            f"Score: {signal.score:.2f}\n"
            f"Price: {signal.price:.4f}\n"
            f"SL: {signal.stop_loss:.4f} | TP: {signal.take_profit:.4f}\n"
            f"Regime: {signal.regime}"
        )
        await self._queue.put(msg)

    async def _handle_order(self, payload: Any) -> None:
        order = payload
        paper = "📝 PAPER" if order.is_paper else "🔴 LIVE"
        msg = (
            f"{paper} <b>Order Filled</b>\n"
            f"{order.exchange}/{order.symbol} {order.direction.upper()}\n"
            f"Price: {order.price:.4f} | Qty: {order.quantity:.4f}"
        )
        await self._queue.put(msg)

    async def _drain_queue(self) -> None:
        while self._running:
            try:
                msg = await asyncio.wait_for(self._queue.get(), timeout=1.0)
                await self.send(msg)
            except asyncio.TimeoutError:
                continue
            except Exception as exc:
                logger.debug("Telegram drain error: {}", exc)

    async def run(self) -> None:
        self._running = True
        if not await self._init_bot():
            logger.info("Telegram notifier disabled")
            while self._running:
                await asyncio.sleep(10)
            return

        self.event_bus.subscribe("SIGNAL", self._handle_signal)
        self.event_bus.subscribe("ORDER_FILLED", self._handle_order)
        logger.info("Telegram notifier started")
        await self._drain_queue()

    async def stop(self) -> None:
        self._running = False
        self.event_bus.unsubscribe("SIGNAL", self._handle_signal)
        self.event_bus.unsubscribe("ORDER_FILLED", self._handle_order)
