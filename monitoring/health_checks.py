"""
Health checks for service monitoring.
"""

from typing import Dict, List, Optional
from dataclasses import dataclass
from enum import Enum
import asyncio
import time
from loguru import logger


class HealthStatus(Enum):
    HEALTHY = "HEALTHY"
    DEGRADED = "DEGRADED"
    UNHEALTHY = "UNHEALTHY"
    UNKNOWN = "UNKNOWN"


@dataclass
class ComponentHealth:
    component: str
    status: HealthStatus
    latency_ms: float
    message: str
    last_check: float
    details: Optional[Dict] = None


@dataclass
class HealthCheckResult:
    overall_status: HealthStatus
    timestamp: float
    components: Dict[str, ComponentHealth]
    uptime_seconds: float
    version: str


class HealthChecker:
    """
    Health check system for all components.

    Monitors:
    - Database connectivity
    - Redis connectivity
    - Venue APIs
    - Message queues
    - Internal services
    """

    def __init__(
        self,
        component_timeout: float = 5.0,
        check_interval: int = 30,
    ):
        self.component_timeout = component_timeout
        self.check_interval = check_interval

        self.components: Dict[str, ComponentHealth] = {}
        self.start_time = time.time()
        self.version = "4.0.0"

        self._running = False
        self._check_task: Optional[asyncio.Task] = None

    async def register_component(
        self,
        name: str,
        check_func: callable,
    ) -> None:
        """Register a component for health checking."""
        self.components[name] = ComponentHealth(
            component=name,
            status=HealthStatus.UNKNOWN,
            latency_ms=0.0,
            message="Not yet checked",
            last_check=0.0,
        )

        logger.info(f"Registered health check component: {name}")

    async def check_component_health(
        self,
        name: str,
        check_func: callable,
    ) -> ComponentHealth:
        """Check health of a specific component."""
        start_time = time.time()

        try:
            result = await asyncio.wait_for(
                check_func(),
                timeout=self.component_timeout,
            )

            latency_ms = (time.time() - start_time) * 1000

            if isinstance(result, bool):
                status = HealthStatus.HEALTHY if result else HealthStatus.UNHEALTHY
                message = "OK" if result else "Failed"
            elif isinstance(result, dict):
                status = HealthStatus(result.get("status", "HEALTHY"))
                message = result.get("message", "OK")
            else:
                status = HealthStatus.HEALTHY
                message = str(result)

            return ComponentHealth(
                component=name,
                status=status,
                latency_ms=latency_ms,
                message=message,
                last_check=time.time(),
                details=result if isinstance(result, dict) else None,
            )

        except asyncio.TimeoutError:
            return ComponentHealth(
                component=name,
                status=HealthStatus.UNHEALTHY,
                latency_ms=self.component_timeout * 1000,
                message=f"Timeout after {self.component_timeout}s",
                last_check=time.time(),
            )

        except Exception as e:
            return ComponentHealth(
                component=name,
                status=HealthStatus.UNHEALTHY,
                latency_ms=(time.time() - start_time) * 1000,
                message=str(e),
                last_check=time.time(),
            )

    async def check_all_components(self) -> HealthCheckResult:
        """Check health of all registered components."""
        component_checks = []

        for name in self.components:
            # In production, each component would have its own check function
            # For now, we'll create dummy checks
            async def dummy_check():
                await asyncio.sleep(0.01)
                return True

            check_task = asyncio.create_task(
                self.check_component_health(name, dummy_check)
            )
            component_checks.append(check_task)

        results = await asyncio.gather(*component_checks, return_exceptions=True)

        for result in results:
            if isinstance(result, Exception):
                logger.error(f"Health check error: {result}")
            elif isinstance(result, ComponentHealth):
                self.components[result.component] = result

        # Determine overall status
        statuses = [c.status for c in self.components.values()]

        if HealthStatus.UNHEALTHY in statuses:
            overall_status = HealthStatus.UNHEALTHY
        elif HealthStatus.DEGRADED in statuses:
            overall_status = HealthStatus.DEGRADED
        elif HealthStatus.UNKNOWN in statuses:
            overall_status = HealthStatus.UNKNOWN
        else:
            overall_status = HealthStatus.HEALTHY

        return HealthCheckResult(
            overall_status=overall_status,
            timestamp=time.time(),
            components=self.components.copy(),
            uptime_seconds=time.time() - self.start_time,
            version=self.version,
        )

    async def start_periodic_checks(self) -> None:
        """Start periodic health checks."""
        self._running = True

        async def _check_loop():
            while self._running:
                result = await self.check_all_components()
                logger.info(
                    f"Health check: {result.overall_status.value} - "
                    f"{len(result.components)} components checked"
                )
                await asyncio.sleep(self.check_interval)

        self._check_task = asyncio.create_task(_check_loop())
        logger.info("Periodic health checks started")

    async def stop_periodic_checks(self) -> None:
        """Stop periodic health checks."""
        self._running = False
        if self._check_task:
            self._check_task.cancel()
            try:
                await self._check_task
            except asyncio.CancelledError:
                pass
        logger.info("Periodic health checks stopped")

    async def get_health_status(self) -> HealthCheckResult:
        """Get current health status."""
        if not self.components:
            return HealthCheckResult(
                overall_status=HealthStatus.UNKNOWN,
                timestamp=time.time(),
                components={},
                uptime_seconds=0.0,
                version=self.version,
            )

        # Use last known results if recent
        now = time.time()
        stale_threshold = self.check_interval * 2

        any_stale = any(
            now - c.last_check > stale_threshold
            for c in self.components.values()
        )

        if any_stale:
            return await self.check_all_components()

        return HealthCheckResult(
            overall_status=self._determine_overall_status(),
            timestamp=now,
            components=self.components.copy(),
            uptime_seconds=now - self.start_time,
            version=self.version,
        )

    def _determine_overall_status(self) -> HealthStatus:
        """Determine overall status from components."""
        statuses = [c.status for c in self.components.values()]

        if HealthStatus.UNHEALTHY in statuses:
            return HealthStatus.UNHEALTHY
        elif HealthStatus.DEGRADED in statuses:
            return HealthStatus.DEGRADED
        elif HealthStatus.UNKNOWN in statuses:
            return HealthStatus.UNKNOWN
        else:
            return HealthStatus.HEALTHY

    def register_builtin_checks(self) -> None:
        """Register standard health checks."""
        # Database
        async def check_database():
            # Placeholder - would check actual database
            return True

        asyncio.create_task(self.register_component("database", check_database))

        # Redis
        async def check_redis():
            # Placeholder - would check actual Redis
            return True

        asyncio.create_task(self.register_component("redis", check_redis))

        # Trading engine
        async def check_trading_engine():
            # Placeholder - would check trading engine
            return True

        asyncio.create_task(self.register_component("trading_engine", check_trading_engine))


# Global health checker instance
_health_checker: Optional[HealthChecker] = None


def init_health_checker(
    component_timeout: float = 5.0,
    check_interval: int = 30,
) -> HealthChecker:
    """Initialize global health checker."""
    global _health_checker

    if _health_checker is None:
        _health_checker = HealthChecker(component_timeout, check_interval)
        _health_checker.register_builtin_checks()

    return _health_checker


def get_health_checker() -> Optional[HealthChecker]:
    """Get global health checker."""
    return _health_checker
