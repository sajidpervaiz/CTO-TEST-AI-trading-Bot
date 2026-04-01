"""Unit tests for the regime detector."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from analysis.regime import RegimeDetector, MarketRegime


@pytest.fixture
def detector() -> RegimeDetector:
    return RegimeDetector(adx_threshold=25.0, vol_threshold=0.6)


def _make_df(n: int = 200, trend: float = 0.0, noise: float = 0.01) -> pd.DataFrame:
    rng = np.random.default_rng(42)
    prices = 50000.0 * np.cumprod(1 + trend / n + rng.normal(0, noise, n))
    df = pd.DataFrame({
        "close": prices,
        "high": prices * 1.002,
        "low": prices * 0.998,
        "open": np.roll(prices, 1),
        "volume": rng.uniform(100, 1000, n),
    })
    return df


class TestRegimeDetector:
    def test_short_series_returns_unknown(self, detector: RegimeDetector) -> None:
        df = _make_df(n=10)
        state = detector.detect(df)
        assert state.regime == MarketRegime.UNKNOWN

    def test_returns_valid_regime(self, detector: RegimeDetector) -> None:
        df = _make_df(n=200)
        state = detector.detect(df)
        assert state.regime in list(MarketRegime)
        assert 0.0 <= state.confidence <= 1.0
        assert state.adx >= 0.0

    def test_high_volatility_detected(self, detector: RegimeDetector) -> None:
        df = _make_df(n=200, noise=0.10)
        state = detector.detect(df)
        assert state.realized_vol > 0.0

    def test_regime_has_timestamp(self, detector: RegimeDetector) -> None:
        df = _make_df(n=100)
        state = detector.detect(df)
        assert state.timestamp > 0
