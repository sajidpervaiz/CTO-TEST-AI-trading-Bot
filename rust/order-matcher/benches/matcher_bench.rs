use criterion::{black_box, criterion_group, criterion_main, Criterion};
use order_matcher::{Order, OrderBook, Side};

fn bench_limit_match(c: &mut Criterion) {
    c.bench_function("limit_order_match", |b| {
        b.iter(|| {
            let mut book = OrderBook::new(500);
            for i in 0..50u64 {
                let ask = Order::new_limit(i, Side::Sell, 50100.0 + i as f64 * 10.0, 1.0, i as i64);
                book.add_order(ask);
            }
            let bid = Order::new_limit(100, Side::Buy, 50200.0, 2.0, 100);
            black_box(book.add_order(bid));
        });
    });
}

fn bench_market_order(c: &mut Criterion) {
    c.bench_function("market_order_deep_book", |b| {
        b.iter(|| {
            let mut book = OrderBook::new(500);
            for i in 0..100u64 {
                book.add_order(Order::new_limit(i, Side::Sell, 50000.0 + i as f64, 0.1, i as i64));
            }
            let market = Order::new_market(200, Side::Buy, 5.0, 200);
            black_box(book.add_order(market));
        });
    });
}

criterion_group!(benches, bench_limit_match, bench_market_order);
criterion_main!(benches);
