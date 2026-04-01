use std::sync::atomic::{AtomicU64, AtomicF64, Ordering};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use crossbeam_epoch::{self as epoch, Atomic, Owned, Shared};
use crossbeam_utils::CachePadded;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Side { Buy, Sell }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RiskCheck { InsufficientMargin, ExposureLimit, PositionLimit, VelocityLimit, ConcentrationRisk }

#[derive(Debug, Error)]
pub enum RiskError {
    #[error("Insufficient margin: required={required}, available={available}")]
    InsufficientMargin { required: f64, available: f64 },
    #[error("Position limit exceeded: symbol={symbol}, current={current}, limit={limit}")]
    PositionLimitExceeded { symbol: String, current: f64, limit: f64 },
    #[error("Velocity limit exceeded: orders={orders}, limit={limit}")]
    VelocityLimitExceeded { orders: u64, limit: u64 },
    #[error("Concentration risk: asset={asset}, allocation={alloc}, limit={limit}")]
    ConcentrationRisk { asset: String, alloc: f64, limit: f64 },
    #[error("Order size exceeds maximum: size={size}, max={max}")]
    OrderSizeExceeded { size: f64, max: f64 },
}

pub type Result<T> = std::result::Result<T, RiskError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub symbol: String,
    pub side: Side,
    pub quantity: f64,
    pub avg_price: f64,
    pub unrealized_pnl: f64,
}

#[derive(Debug, Clone)]
pub struct RiskLimits {
    pub max_position_value: f64,
    pub max_order_size: f64,
    pub max_orders_per_sec: u64,
    pub max_concentration: f64,
    pub leverage_limit: f64,
    pub stop_loss_pct: f64,
}

impl Default for RiskLimits {
    fn default() -> Self {
        Self {
            max_position_value: 1_000_000.0,
            max_order_size: 10_000.0,
            max_orders_per_sec: 100,
            max_concentration: 0.3,
            leverage_limit: 10.0,
            stop_loss_pct: 0.05,
        }
    }
}

pub struct PriceLevel {
    price: u64,
    total_quantity: AtomicF64,
    order_count: AtomicU64,
}

impl PriceLevel {
    fn new(price: u64) -> Self {
        Self {
            price,
            total_quantity: AtomicF64::new(0.0),
            order_count: AtomicU64::new(0),
        }
    }
}

struct OrderNode {
    id: u64,
    side: Side,
    quantity: f64,
    remaining: f64,
    price: u64,
    timestamp: i64,
    next: Atomic<OrderNode>,
}

struct LockFreeOrderBook {
    symbol: String,
    bids: crossbeam_skiplist::SkipMap<u64, CachePadded<AtomicF64>>,
    asks: crossbeam_skiplist::SkipMap<u64, CachePadded<AtomicF64>>,
    best_bid: CachePadded<Atomic<u64>>,
    best_ask: CachePadded<Atomic<u64>>,
}

impl LockFreeOrderBook {
    fn new(symbol: String) -> Self {
        Self {
            symbol,
            bids: crossbeam_skiplist::SkipMap::new(),
            asks: crossbeam_skiplist::SkipMap::new(),
            best_bid: CachePadded::new(Atomic::new(0)),
            best_ask: CachePadded::new(Atomic::new(u64::MAX)),
        }
    }

    fn best_bid(&self) -> Option<u64> {
        self.bids.peek_max().map(|entry| *entry.key())
    }

    fn best_ask(&self) -> Option<u64> {
        self.asks.peek_min().map(|entry| *entry.key())
    }

    fn mid_price(&self) -> Option<f64> {
        match (self.best_bid(), self.best_ask()) {
            (Some(b), Some(a)) if b < a => Some(((b as f64 + a as f64) / 2.0) / 1_000_000.0),
            _ => None,
        }
    }
}

pub struct RiskEngine {
    limits: RiskLimits,
    positions: dashmap::DashMap<String, Position>,
    order_counts: dashmap::DashMap<String, CachePadded<AtomicU64>>,
    order_books: dashmap::DashMap<String, LockFreeOrderBook>,
    total_exposure: CachePadded<AtomicF64>,
    margin_available: CachePadded<AtomicF64>,
    account_balance: CachePadded<AtomicF64>,
}

impl RiskEngine {
    pub fn new(limits: RiskLimits, account_balance: f64) -> Self {
        Self {
            limits,
            positions: dashmap::DashMap::new(),
            order_counts: dashmap::DashMap::new(),
            order_books: dashmap::DashMap::new(),
            total_exposure: CachePadded::new(AtomicF64::new(0.0)),
            margin_available: CachePadded::new(AtomicF64::new(account_balance)),
            account_balance: CachePadded::new(AtomicF64::new(account_balance)),
        }
    }

    pub fn pre_trade_check(&self, symbol: &str, side: Side, quantity: f64, price: f64) -> Result<()> {
        let order_value = quantity * price;

        if order_value > self.limits.max_order_size * price {
            return Err(RiskError::OrderSizeExceeded {
                size: quantity,
                max: self.limits.max_order_size,
            });
        }

        let current_position = self.get_position(symbol);
        let new_exposure = self.total_exposure.load(Ordering::Relaxed) + order_value;

        if new_exposure > self.limits.max_position_value {
            return Err(RiskError::InsufficientMargin {
                required: new_exposure,
                available: self.limits.max_position_value,
            });
        }

        let counter = self.order_counts.entry(symbol.to_string()).or_insert_with(|| {
            CachePadded::new(AtomicU64::new(0))
        });
        let count = counter.value().fetch_add(1, Ordering::Relaxed);
        if count >= self.limits.max_orders_per_sec {
            return Err(RiskError::VelocityLimitExceeded {
                orders: count + 1,
                limit: self.limits.max_orders_per_sec,
            });
        }

        let current_qty = current_position.map(|p| p.quantity).unwrap_or(0.0);
        let new_qty = match side {
            Side::Buy => current_qty + quantity,
            Side::Sell => current_qty - quantity,
        };

        if new_qty.abs() > self.limits.max_position_value / price {
            return Err(RiskError::PositionLimitExceeded {
                symbol: symbol.to_string(),
                current: current_qty,
                limit: self.limits.max_position_value / price,
            });
        }

        if order_value > self.limits.max_concentration * self.account_balance.load(Ordering::Relaxed) {
            return Err(RiskError::ConcentrationRisk {
                asset: symbol.to_string(),
                alloc: order_value / self.account_balance.load(Ordering::Relaxed),
                limit: self.limits.max_concentration,
            });
        }

        Ok(())
    }

    pub fn get_position(&self, symbol: &str) -> Option<Position> {
        self.positions.get(symbol).map(|p| p.clone())
    }

    pub fn update_position(&self, symbol: &str, side: Side, quantity: f64, price: f64) {
        let entry = self.positions.entry(symbol.to_string()).or_insert_with(|| Position {
            symbol: symbol.to_string(),
            side,
            quantity: 0.0,
            avg_price: price,
            unrealized_pnl: 0.0,
        });

        let mut pos = entry.value_mut();
        let qty_change = match side {
            Side::Buy => quantity,
            Side::Sell => -quantity,
        };

        if pos.quantity.signum() == qty_change.signum() || pos.quantity == 0.0 {
            let total_cost = pos.quantity.abs() * pos.avg_price + qty_change.abs() * price;
            pos.quantity += qty_change;
            if pos.quantity != 0.0 {
                pos.avg_price = total_cost / pos.quantity.abs();
            }
        } else {
            let closing_qty = qty_change.abs().min(pos.quantity.abs());
            let closing_pnl = closing_qty * (price - pos.avg_price) * pos.quantity.signum() as f64;
            pos.unrealized_pnl += closing_pnl;
            pos.quantity += qty_change;
            if pos.quantity == 0.0 {
                pos.avg_price = price;
            }
        }

        let exposure_change = quantity * price;
        self.total_exposure.fetch_add(exposure_change, Ordering::Relaxed);
    }

    pub fn reset_order_counts(&self) {
        for counter in self.order_counts.iter() {
            counter.value().store(0, Ordering::Relaxed);
        }
    }

    pub fn get_margin_available(&self) -> f64 {
        self.margin_available.load(Ordering::Relaxed)
    }

    pub fn get_total_exposure(&self) -> f64 {
        self.total_exposure.load(Ordering::Relaxed)
    }

    pub fn register_order_book(&self, symbol: String) {
        if !self.order_books.contains_key(&symbol) {
            self.order_books.insert(symbol.clone(), LockFreeOrderBook::new(symbol));
        }
    }

    pub fn update_order_book_price(&self, symbol: &str, side: Side, price: f64, quantity: f64) {
        if let Some(book) = self.order_books.get(symbol) {
            let price_key = (price * 1_000_000.0) as u64;
            let map = if side == Side::Buy { &book.bids } else { &book.asks };

            if let Some(entry) = map.get(&price_key) {
                entry.value().store(quantity, Ordering::Relaxed);
            } else {
                let entry = map.entry(price_key).or_insert_with(|| CachePadded::new(AtomicF64::new(0.0)));
                entry.value().store(quantity, Ordering::Relaxed);
            }

            if side == Side::Buy {
                if let Some(best) = book.best_bid() {
                    book.best_bid.store(best, Ordering::Relaxed);
                }
            } else {
                if let Some(best) = book.best_ask() {
                    book.best_ask.store(best, Ordering::Relaxed);
                }
            }
        }
    }

    pub fn get_market_price(&self, symbol: &str) -> Option<f64> {
        self.order_books.get(symbol).and_then(|book| book.mid_price())
    }
}

impl Default for RiskEngine {
    fn default() -> Self {
        Self::new(RiskLimits::default(), 1_000_000.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pre_trade_check_success() {
        let engine = RiskEngine::new(RiskLimits::default(), 1_000_000.0);
        let result = engine.pre_trade_check("BTC/USDT", Side::Buy, 1.0, 50_000.0);
        assert!(result.is_ok());
    }

    #[test]
    fn test_order_size_exceeded() {
        let mut limits = RiskLimits::default();
        limits.max_order_size = 5_000.0;
        let engine = RiskEngine::new(limits, 1_000_000.0);
        let result = engine.pre_trade_check("BTC/USDT", Side::Buy, 6.0, 50_000.0);
        assert!(matches!(result, Err(RiskError::OrderSizeExceeded { .. })));
    }

    #[test]
    fn test_position_tracking() {
        let engine = RiskEngine::default();
        engine.update_position("BTC/USDT", Side::Buy, 2.0, 50_000.0);
        let pos = engine.get_position("BTC/USDT").unwrap();
        assert_eq!(pos.quantity, 2.0);
        assert_eq!(pos.avg_price, 50_000.0);
    }

    #[test]
    fn test_concentration_risk() {
        let engine = RiskEngine::new(RiskLimits::default(), 100_000.0);
        let result = engine.pre_trade_check("BTC/USDT", Side::Buy, 2.0, 50_000.0);
        assert!(matches!(result, Err(RiskError::ConcentrationRisk { .. })));
    }
}
