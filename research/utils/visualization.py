"""Plotly-based visualization utilities for research notebooks."""
from __future__ import annotations

from typing import Any

import pandas as pd

try:
    import plotly.graph_objects as go
    from plotly.subplots import make_subplots
    _PLOTLY = True
except ImportError:
    _PLOTLY = False


def candlestick_chart(
    df: pd.DataFrame,
    title: str = "Price Chart",
    show_volume: bool = True,
    indicators: list[str] | None = None,
) -> Any:
    """Create an interactive candlestick chart with optional indicators."""
    if not _PLOTLY:
        raise ImportError("plotly is required for visualization")

    rows = 2 if show_volume else 1
    row_heights = [0.7, 0.3] if show_volume else [1.0]
    fig = make_subplots(
        rows=rows,
        cols=1,
        shared_xaxes=True,
        vertical_spacing=0.03,
        row_heights=row_heights,
    )

    fig.add_trace(
        go.Candlestick(
            x=df.index,
            open=df["open"],
            high=df["high"],
            low=df["low"],
            close=df["close"],
            name="Price",
        ),
        row=1, col=1,
    )

    if indicators:
        colors = ["#2196F3", "#FF9800", "#9C27B0", "#4CAF50", "#F44336"]
        for i, col in enumerate(indicators):
            if col in df.columns:
                fig.add_trace(
                    go.Scatter(
                        x=df.index,
                        y=df[col],
                        name=col,
                        line=dict(color=colors[i % len(colors)], width=1),
                    ),
                    row=1, col=1,
                )

    if show_volume and "volume" in df.columns:
        colors = ["green" if c >= o else "red" for c, o in zip(df["close"], df["open"])]
        fig.add_trace(
            go.Bar(x=df.index, y=df["volume"], name="Volume", marker_color=colors),
            row=2, col=1,
        )

    fig.update_layout(
        title=title,
        xaxis_rangeslider_visible=False,
        template="plotly_dark",
        height=600,
    )
    return fig


def indicator_chart(df: pd.DataFrame, cols: list[str], title: str = "Indicators") -> Any:
    """Plot one or more indicator columns as a line chart."""
    if not _PLOTLY:
        raise ImportError("plotly is required")
    fig = go.Figure()
    for col in cols:
        if col in df.columns:
            fig.add_trace(go.Scatter(x=df.index, y=df[col], name=col))
    fig.update_layout(title=title, template="plotly_dark", height=400)
    return fig


def equity_curve(
    equity: pd.Series,
    title: str = "Equity Curve",
    benchmark: pd.Series | None = None,
) -> Any:
    """Plot an equity curve."""
    if not _PLOTLY:
        raise ImportError("plotly is required")
    fig = go.Figure()
    fig.add_trace(go.Scatter(
        x=equity.index, y=equity, name="Strategy",
        fill="tozeroy", line=dict(color="#2196F3"),
    ))
    if benchmark is not None:
        fig.add_trace(go.Scatter(
            x=benchmark.index, y=benchmark, name="Benchmark",
            line=dict(color="#FF9800", dash="dash"),
        ))
    fig.update_layout(title=title, template="plotly_dark", height=400)
    return fig


def correlation_heatmap(df: pd.DataFrame, title: str = "Feature Correlations") -> Any:
    """Plot a correlation heatmap for numeric columns."""
    if not _PLOTLY:
        raise ImportError("plotly is required")
    numeric = df.select_dtypes("number")
    corr = numeric.corr()
    fig = go.Figure(go.Heatmap(
        z=corr.values,
        x=corr.columns.tolist(),
        y=corr.index.tolist(),
        colorscale="RdBu",
        zmid=0,
    ))
    fig.update_layout(title=title, template="plotly_dark", height=600)
    return fig


def funding_rate_chart(funding_df: pd.DataFrame, symbol: str = "") -> Any:
    """Plot funding rates over time, coloured by sign."""
    if not _PLOTLY:
        raise ImportError("plotly is required")
    if funding_df.empty:
        return go.Figure()
    fig = go.Figure()
    for exchange in funding_df["exchange"].unique() if "exchange" in funding_df.columns else ["all"]:
        mask = funding_df["exchange"] == exchange if "exchange" in funding_df.columns else [True] * len(funding_df)
        sub = funding_df[mask]
        fig.add_trace(go.Scatter(
            x=sub.index,
            y=sub["funding_rate"] * 100,
            name=exchange,
        ))
    fig.add_hline(y=0, line_dash="dash", line_color="gray")
    fig.update_layout(
        title=f"Funding Rate — {symbol}",
        yaxis_title="Rate (%)",
        template="plotly_dark",
        height=400,
    )
    return fig
