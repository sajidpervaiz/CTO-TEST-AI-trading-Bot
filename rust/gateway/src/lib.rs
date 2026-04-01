use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::{UdpSocket, TcpListener};
use tokio::sync::{mpsc, RwLock};
use tokio_stream::wrappers::TcpListenerStream;
use tonic::{transport::Server, Request, Response, Status, Code};
use crossbeam_channel::{bounded, Receiver, Sender};
use parking_lot::Mutex;
use prometheus::{Counter, Histogram, Gauge, Registry, TextEncoder, Encoder};
use log::{info, warn, error, debug};
use serde::{Deserialize, Serialize};
use pyo3::{prelude::*, types::PyDict};

pub mod proto {
    include!(concat!(env!("OUT_DIR"), "/bridge.rs"));
}

use proto::bridge_service_server::{BridgeService, BridgeServiceServer};
use proto::{HealthCheckRequest, HealthCheckResponse, OrderRequest, OrderResponse, MarketDataRequest, MarketDataResponse, PingRequest, PingResponse};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayMessage {
    pub timestamp_ns: i64,
    pub message_type: String,
    pub payload: Vec<u8>,
    pub correlation_id: String,
}

#[derive(Debug, Clone)]
pub struct Metrics {
    requests_total: Counter,
    requests_duration: Histogram,
    active_connections: Gauge,
    orders_received: Counter,
    orders_processed: Counter,
    market_data_received: Counter,
}

impl Metrics {
    pub fn new() -> Self {
        let registry = Registry::new();

        Self {
            requests_total: Counter::new("gateway_requests_total", "Total number of requests").unwrap(),
            requests_duration: Histogram::new("gateway_requests_duration_seconds", "Request duration").unwrap(),
            active_connections: Gauge::new("gateway_active_connections", "Active connections").unwrap(),
            orders_received: Counter::new("gateway_orders_received_total", "Total orders received").unwrap(),
            orders_processed: Counter::new("gateway_orders_processed_total", "Total orders processed").unwrap(),
            market_data_received: Counter::new("gateway_market_data_received_total", "Total market data messages").unwrap(),
        }
    }

    pub fn export(&self) -> String {
        let mut buffer = Vec::new();
        let encoder = TextEncoder::new();
        let metric_families = prometheus::gather();
        encoder.encode(&metric_families, &mut buffer).unwrap();
        String::from_utf8(buffer).unwrap()
    }
}

impl Default for Metrics {
    fn default() -> Self {
        Self::new()
    }
}

pub struct UdpMulticastReceiver {
    socket: Arc<UdpSocket>,
    tx: Sender<GatewayMessage>,
    metrics: Arc<Metrics>,
}

impl UdpMulticastReceiver {
    pub async fn new(
        bind_addr: SocketAddr,
        multicast_addr: SocketAddr,
        tx: Sender<GatewayMessage>,
        metrics: Arc<Metrics>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let socket = UdpSocket::bind(bind_addr).await?;
        socket.join_multicast_v4(multicast_addr.ip(), std::net::Ipv4Addr::UNSPECIFIED)?;
        let socket = Arc::new(socket);

        Ok(Self { socket, tx, metrics })
    }

    pub async fn run(&self) -> Result<(), Box<dyn std::error::Error>> {
        let mut buf = vec![0u8; 65536];
        loop {
            match self.socket.recv_from(&mut buf).await {
                Ok((len, src)) => {
                    let payload = buf[..len].to_vec();
                    let message = GatewayMessage {
                        timestamp_ns: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap()
                            .as_nanos() as i64,
                        message_type: "market_data".to_string(),
                        payload,
                        correlation_id: format!("udp-{}-{}", src, Instant::now().elapsed().as_nanos()),
                    };

                    if self.tx.send(message).is_ok() {
                        self.metrics.market_data_received.inc();
                    }
                }
                Err(e) => {
                    error!("UDP receive error: {}", e);
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    }
}

pub struct TcpMarketDataReceiver {
    listener: TcpListener,
    tx: Sender<GatewayMessage>,
    metrics: Arc<Metrics>,
}

impl TcpMarketDataReceiver {
    pub async fn new(
        bind_addr: SocketAddr,
        tx: Sender<GatewayMessage>,
        metrics: Arc<Metrics>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let listener = TcpListener::bind(bind_addr).await?;
        Ok(Self { listener, tx, metrics })
    }

    pub async fn run(&self) -> Result<(), Box<dyn std::error::Error>> {
        let stream = TcpListenerStream::new(self.listener);
        for mut socket in stream {
            let tx = self.tx.clone();
            let metrics = self.metrics.clone();

            tokio::spawn(async move {
                let mut buf = vec![0u8; 65536];
                loop {
                    match socket.read(&mut buf).await {
                        Ok(0) => break,
                        Ok(len) => {
                            let payload = buf[..len].to_vec();
                            let message = GatewayMessage {
                                timestamp_ns: std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap()
                                    .as_nanos() as i64,
                                message_type: "tcp_market_data".to_string(),
                                payload,
                                correlation_id: format!("tcp-{}", Instant::now().elapsed().as_nanos()),
                            };

                            if tx.send(message).is_ok() {
                                metrics.market_data_received.inc();
                            }
                        }
                        Err(e) => {
                            error!("TCP read error: {}", e);
                            break;
                        }
                    }
                }
            });
        }
        Ok(())
    }
}

#[derive(Debug, Default)]
pub struct OrderRouter {
    pending_orders: Arc<RwLock<HashMap<String, OrderRequest>>>,
    order_responses: Arc<RwLock<HashMap<String, OrderResponse>>>,
}

impl OrderRouter {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn submit_order(&self, order: OrderRequest) -> Result<String, Status> {
        let order_id = format!("ord-{}", uuid::Uuid::new_v4().to_string().replace("-", "")[..12].to_string());
        self.pending_orders.write().await.insert(order_id.clone(), order);
        Ok(order_id)
    }

    pub async fn cancel_order(&self, order_id: &str) -> Result<bool, Status> {
        if self.pending_orders.write().await.remove(order_id).is_some() {
            Ok(true)
        } else {
            Err(Status::not_found(format!("Order {} not found", order_id)))
        }
    }

    pub async fn get_order_status(&self, order_id: &str) -> Result<Option<OrderResponse>, Status> {
        Ok(self.order_responses.read().await.get(order_id).cloned())
    }
}

#[derive(Clone)]
pub struct BridgeServiceImpl {
    order_router: Arc<OrderRouter>,
    metrics: Arc<Metrics>,
    tx: Sender<GatewayMessage>,
}

impl BridgeServiceImpl {
    pub fn new(order_router: Arc<OrderRouter>, metrics: Arc<Metrics>, tx: Sender<GatewayMessage>) -> Self {
        Self { order_router, metrics, tx }
    }
}

#[tonic::async_trait]
impl BridgeService for BridgeServiceImpl {
    async fn health_check(&self, _request: Request<HealthCheckRequest>) -> Result<Response<HealthCheckResponse>, Status> {
        self.metrics.requests_total.inc();
        let _timer = self.metrics.requests_duration.start_timer();

        Ok(Response::new(HealthCheckResponse {
            status: "SERVING".to_string(),
            version: "4.0.0".to_string(),
        }))
    }

    async fn submit_order(&self, request: Request<OrderRequest>) -> Result<Response<OrderResponse>, Status> {
        self.metrics.requests_total.inc();
        self.metrics.orders_received.inc();
        let _timer = self.metrics.requests_duration.start_timer();

        let req = request.into_inner();

        let order_id = self.order_router.submit_order(req.clone()).await?;

        let response = OrderResponse {
            order_id: order_id.clone(),
            status: "SUBMITTED".to_string(),
            message: "Order submitted successfully".to_string(),
            filled_quantity: 0.0,
            avg_price: 0.0,
        };

        self.order_router.order_responses.write().await.insert(order_id, response.clone());
        self.metrics.orders_processed.inc();

        Ok(Response::new(response))
    }

    async fn cancel_order(&self, request: Request<proto::CancelOrderRequest>) -> Result<Response<proto::CancelOrderResponse>, Status> {
        self.metrics.requests_total.inc();
        let _timer = self.metrics.requests_duration.start_timer();

        let req = request.into_inner();
        let cancelled = self.order_router.cancel_order(&req.order_id).await?;

        Ok(Response::new(proto::CancelOrderResponse {
            order_id: req.order_id,
            success: cancelled,
            message: if cancelled { "Order cancelled".to_string() } else { "Order not found".to_string() },
        }))
    }

    async fn subscribe_market_data(&self, request: Request<MarketDataRequest>) -> Result<Response<MarketDataResponse>, Status> {
        self.metrics.requests_total.inc();
        let _timer = self.metrics.requests_duration.start_timer();

        let req = request.into_inner();

        let message = GatewayMessage {
            timestamp_ns: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos() as i64,
            message_type: "subscribe".to_string(),
            payload: bincode::serialize(&req).unwrap_or_default(),
            correlation_id: format!("sub-{}", uuid::Uuid::new_v4()),
        };

        let _ = self.tx.send(message);

        Ok(Response::new(MarketDataResponse {
            success: true,
            message: "Subscription request sent".to_string(),
        }))
    }

    async fn ping(&self, _request: Request<PingRequest>) -> Result<Response<PingResponse>, Status> {
        self.metrics.requests_total.inc();
        let _timer = self.metrics.requests_duration.start_timer();

        Ok(Response::new(PingResponse {
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            status: "OK".to_string(),
        }))
    }
}

pub struct TradingGateway {
    metrics: Arc<Metrics>,
    order_router: Arc<OrderRouter>,
    message_tx: Sender<GatewayMessage>,
    message_rx: Receiver<GatewayMessage>,
}

impl TradingGateway {
    pub fn new() -> Self {
        let (tx, rx) = bounded(10000);
        Self {
            metrics: Arc::new(Metrics::new()),
            order_router: Arc::new(OrderRouter::new()),
            message_tx: tx,
            message_rx: rx,
        }
    }

    pub fn metrics(&self) -> Arc<Metrics> {
        self.metrics.clone()
    }

    pub fn message_tx(&self) -> Sender<GatewayMessage> {
        self.message_tx.clone()
    }

    pub fn message_rx(&self) -> Receiver<GatewayMessage> {
        self.message_rx.clone()
    }

    pub fn order_router(&self) -> Arc<OrderRouter> {
        self.order_router.clone()
    }

    pub async fn serve_grpc(&self, addr: SocketAddr) -> Result<(), Box<dyn std::error::Error>> {
        let bridge_service = BridgeServiceImpl::new(
            self.order_router.clone(),
            self.metrics.clone(),
            self.message_tx.clone(),
        );

        info!("gRPC server listening on {}", addr);
        Server::builder()
            .add_service(BridgeServiceServer::new(bridge_service))
            .serve(addr)
            .await?;

        Ok(())
    }

    pub async fn run_udp_receiver(
        &self,
        bind_addr: SocketAddr,
        multicast_addr: SocketAddr,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let receiver = UdpMulticastReceiver::new(bind_addr, multicast_addr, self.message_tx.clone(), self.metrics.clone()).await?;
        info!("UDP multicast receiver listening on {}", bind_addr);
        receiver.run().await
    }

    pub async fn run_tcp_receiver(&self, bind_addr: SocketAddr) -> Result<(), Box<dyn std::error::Error>> {
        let receiver = TcpMarketDataReceiver::new(bind_addr, self.message_tx.clone(), self.metrics.clone()).await?;
        info!("TCP market data receiver listening on {}", bind_addr);
        receiver.run().await
    }

    pub fn run_message_processor(&self) -> impl std::future::Future<Output = ()> + Send {
        let rx = self.message_rx.clone();
        let metrics = self.metrics.clone();

        async move {
            info!("Message processor started");
            for msg in rx {
                debug!("Processing message: {} ({})", msg.message_type, msg.correlation_id);
                metrics.market_data_received.inc();
            }
        }
    }
}

impl Default for TradingGateway {
    fn default() -> Self {
        Self::new()
    }
}

#[pymodule]
fn gateway(_py: Python, m: &PyModule) -> PyResult<()> {
    #[pyclass]
    struct PyGateway {
        gateway: Arc<RwLock<TradingGateway>>,
    }

    #[pymethods]
    impl PyGateway {
        #[new]
        fn new() -> Self {
            Self {
                gateway: Arc::new(RwLock::new(TradingGateway::new())),
            }
        }

        fn get_metrics(&self, py: Python) -> PyResult<String> {
            let gateway = self.gateway.blocking_read();
            Ok(gateway.metrics().export())
        }

        async fn start_grpc_server(&self, host: String, port: u16) -> PyResult<String> {
            let gateway = self.gateway.read().await;
            let addr = format!("{}:{}", host, port).parse().unwrap();
            let gateway_clone = gateway.clone();

            tokio::spawn(async move {
                if let Err(e) = gateway_clone.serve_grpc(addr).await {
                    error!("gRPC server error: {}", e);
                }
            });

            Ok(format!("gRPC server starting on {}:{}", host, port))
        }

        fn start_grpc_server_sync(&self, py: Python, host: String, port: u16) -> PyResult<String> {
            py.allow_threads(|| {
                let runtime = tokio::runtime::Runtime::new().unwrap();
                runtime.block_on(async {
                    self.start_grpc_server(host, port).await
                })
            })
        }
    }

    m.add_class::<PyGateway>()?;
    Ok(())
}
