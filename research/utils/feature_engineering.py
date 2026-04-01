"""Feature engineering utilities for research notebooks."""
from __future__ import annotations

import numpy as np
import pandas as pd


def add_all_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """Add all technical indicators to a candle DataFrame."""
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).parent.parent.parent))
    from analysis.technical import TechnicalIndicators
    ti = TechnicalIndicators()
    return ti.compute_all(df)


def add_returns(df: pd.DataFrame, periods: list[int] | None = None) -> pd.DataFrame:
    """Add return columns for multiple look-back periods."""
    df = df.copy()
    if periods is None:
        periods = [1, 5, 10, 20, 60]
    close = df["close"]
    for p in periods:
        df[f"ret_{p}"] = close.pct_change(p)
        df[f"log_ret_{p}"] = np.log(close / close.shift(p))
    return df


def add_volatility_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add realized volatility features at multiple windows."""
    df = df.copy()
    ret = df["close"].pct_change()
    for w in [5, 10, 20, 60]:
        df[f"rvol_{w}"] = ret.rolling(w).std() * np.sqrt(252)
    df["rvol_ratio"] = df["rvol_5"] / df["rvol_20"].replace(0, np.nan)
    return df


def add_regime_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add regime-detection features (ADX, Hurst approximation)."""
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).parent.parent.parent))
    from analysis.regime import RegimeDetector
    df = df.copy()
    detector = RegimeDetector()
    regime = detector.detect(df)
    df["regime"] = regime.regime.value
    df["regime_confidence"] = regime.confidence
    df["adx"] = regime.adx
    df["hurst"] = regime.hurst_exponent
    return df


def add_funding_features(df: pd.DataFrame, funding_df: pd.DataFrame) -> pd.DataFrame:
    """Merge funding rate features into price DataFrame."""
    if funding_df.empty:
        df["funding_rate"] = np.nan
        df["funding_cumsum"] = np.nan
        return df

    funding_resampled = funding_df["funding_rate"].resample(
        pd.infer_freq(df.index) or "15min"
    ).last().ffill()
    df = df.copy()
    df["funding_rate"] = funding_resampled.reindex(df.index, method="ffill")
    df["funding_cumsum"] = df["funding_rate"].cumsum()
    df["funding_zscore"] = (
        df["funding_rate"] - df["funding_rate"].rolling(48).mean()
    ) / df["funding_rate"].rolling(48).std().replace(0, np.nan)
    return df


def compute_feature_importance(
    df: pd.DataFrame, target_col: str = "ret_1", top_n: int = 20
) -> pd.DataFrame:
    """Compute feature importance using LightGBM."""
    try:
        import lightgbm as lgb
    except ImportError:
        return pd.DataFrame()

    feature_cols = [c for c in df.columns if c != target_col and df[c].dtype in [np.float64, np.float32, float]]
    data = df[feature_cols + [target_col]].dropna()
    if len(data) < 100:
        return pd.DataFrame()

    X = data[feature_cols]
    y = (data[target_col] > 0).astype(int)
    model = lgb.LGBMClassifier(n_estimators=100, random_state=42, verbose=-1)
    model.fit(X, y)
    importance = pd.DataFrame({
        "feature": feature_cols,
        "importance": model.feature_importances_,
    }).sort_values("importance", ascending=False).head(top_n)
    return importance
