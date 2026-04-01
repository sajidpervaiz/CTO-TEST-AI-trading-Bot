use criterion::{black_box, criterion_group, criterion_main, Criterion, BenchmarkId};
use tick_parser::TickParser;

fn bench_add_tick(c: &mut Criterion) {
    let mut parser = TickParser::new(60);
    let mut ts: i64 = 1_700_000_000_000_000;
    let mut price = 50_000.0f64;

    c.bench_function("add_tick_same_bucket", |b| {
        b.iter(|| {
            let result = parser.add_tick(
                black_box("binance"),
                black_box("BTC/USDT"),
                black_box(ts),
                black_box(price),
                black_box(0.1),
            );
            ts += 1_000_000;
            price += 0.1;
            result
        });
    });
}

fn bench_parse_batch(c: &mut Criterion) {
    let sizes = [10, 100, 1000];
    let mut group = c.benchmark_group("parse_batch");

    for size in sizes {
        let ticks: Vec<String> = (0..size)
            .map(|i| format!(
                r#"{{"symbol":"BTC/USDT","price":{:.1},"volume":1.0,"timestamp_us":{},"side":"buy","trade_id":"{}"}}"#,
                50000.0 + i as f64,
                1_700_000_000_000_000i64 + i as i64 * 1_000,
                i,
            ))
            .collect();
        let json = format!("[{}]", ticks.join(","));

        group.bench_with_input(
            BenchmarkId::from_parameter(size),
            &json,
            |b, json| {
                b.iter(|| TickParser::parse_batch(black_box("binance"), black_box(json)));
            },
        );
    }
    group.finish();
}

criterion_group!(benches, bench_add_tick, bench_parse_batch);
criterion_main!(benches);
