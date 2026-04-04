"""Unit tests for the fast backtester."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from engine.fast_backtester import FastBacktester, BacktestResult


@pytest.fixture
def bt() -> FastBacktester:
    return FastBacktester(initial_capital=100_000, commission_pct=0.0004, slippage_pct=0.0002)


def _make_price_df(n: int = 500, seed: int = 42) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    prices = 50000.0 * np.cumprod(1 + rng.normal(0, 0.01, n))
    idx = pd.date_range("2024-01-01", periods=n, freq="1h")
    return pd.DataFrame({"close": prices, "open": prices, "high": prices * 1.001, "low": prices * 0.999}, index=idx)


class TestFastBacktester:
    def test_returns_valid_result(self, bt: FastBacktester) -> None:
        df = _make_price_df()
        signals = pd.Series(0.0, index=df.index)
        signals.iloc[50] = 1.0
        signals.iloc[100] = -1.0
        result = bt.run(df, signals)
        assert isinstance(result, BacktestResult)
        assert isinstance(result.num_trades, int)
        assert 0.0 <= result.win_rate <= 1.0
        assert result.max_drawdown >= 0.0

    def test_no_signals_returns_empty(self, bt: FastBacktester) -> None:
        df = _make_price_df()
        signals = pd.Series(0.0, index=df.index)
        result = bt.run(df, signals)
        assert result.num_trades == 0
        assert result.total_return == 0.0

    def test_alternating_signals(self, bt: FastBacktester) -> None:
        df = _make_price_df()
        signals = pd.Series(0.0, index=df.index)
        for i in range(0, len(df) - 50, 100):
            signals.iloc[i] = 1.0
            signals.iloc[i + 50] = -1.0
        result = bt.run(df, signals)
        assert result.num_trades > 0

    def test_result_to_dict(self, bt: FastBacktester) -> None:
        df = _make_price_df()
        signals = pd.Series(0.0, index=df.index)
        signals.iloc[10] = 1.0
        signals.iloc[50] = -1.0
        result = bt.run(df, signals)
        d = result.to_dict()
        assert "total_return" in d
        assert "sharpe_ratio" in d
        assert "max_drawdown" in d
        assert "num_trades" in d
