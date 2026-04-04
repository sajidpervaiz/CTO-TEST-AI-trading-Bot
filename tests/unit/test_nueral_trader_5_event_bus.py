"""Unit tests for the EventBus."""
from __future__ import annotations

import asyncio

import pytest

from core.event_bus import EventBus


@pytest.fixture
def bus() -> EventBus:
    return EventBus()


class TestEventBus:
    @pytest.mark.asyncio
    async def test_subscribe_and_receive(self, bus: EventBus) -> None:
        received: list = []

        async def handler(payload: object) -> None:
            received.append(payload)

        bus.subscribe("TEST", handler)
        await bus.publish("TEST", {"data": 42})

        task = asyncio.create_task(bus.run())
        await asyncio.sleep(0.05)
        await bus.stop()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

        assert received == [{"data": 42}]

    @pytest.mark.asyncio
    async def test_multiple_handlers(self, bus: EventBus) -> None:
        calls: list[str] = []

        async def h1(payload: object) -> None:
            calls.append("h1")

        async def h2(payload: object) -> None:
            calls.append("h2")

        bus.subscribe("EV", h1)
        bus.subscribe("EV", h2)
        await bus.publish("EV", None)

        task = asyncio.create_task(bus.run())
        await asyncio.sleep(0.05)
        await bus.stop()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

        assert "h1" in calls
        assert "h2" in calls

    @pytest.mark.asyncio
    async def test_unsubscribe(self, bus: EventBus) -> None:
        received: list = []

        async def handler(payload: object) -> None:
            received.append(payload)

        bus.subscribe("EV", handler)
        bus.unsubscribe("EV", handler)
        await bus.publish("EV", "should_not_arrive")

        task = asyncio.create_task(bus.run())
        await asyncio.sleep(0.05)
        await bus.stop()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

        assert received == []

    def test_publish_nowait_when_full(self, bus: EventBus) -> None:
        for _ in range(10_001):
            bus.publish_nowait("EV", "x")
