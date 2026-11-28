use rmcp::{
    ServerHandler,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    },
};

// The gateway forwards MCP requests to the App Platform services `ai` and `sync`,
// which are reachable only inside the app's private network.
const ALLOWED_HTTP_HOSTS: [&str; 5] = ["localhost", "127.0.0.1", "::1", "ai", "sync"];

pub fn create_service<S, F>(factory: F) -> StreamableHttpService<S, LocalSessionManager>
where
    S: ServerHandler + Send + 'static,
    F: Fn() -> Result<S, std::io::Error> + Send + Sync + 'static,
{
    create_service_with_config(
        factory,
        StreamableHttpServerConfig::default().with_allowed_hosts(ALLOWED_HTTP_HOSTS),
    )
}

pub fn create_stateless_service<S, F>(
    factory: F,
    resource_host: &str,
) -> StreamableHttpService<S, LocalSessionManager>
where
    S: ServerHandler + Send + 'static,
    F: Fn() -> Result<S, std::io::Error> + Send + Sync + 'static,
{
    create_service_with_config(
        factory,
        StreamableHttpServerConfig::default()
            .with_allowed_hosts(
                ALLOWED_HTTP_HOSTS
                    .into_iter()
                    .chain(std::iter::once(resource_host)),
            )
            .with_legacy_session_mode(false)
            .with_json_response(true),
    )
}

fn create_service_with_config<S, F>(
    factory: F,
    config: StreamableHttpServerConfig,
) -> StreamableHttpService<S, LocalSessionManager>
where
    S: ServerHandler + Send + 'static,
    F: Fn() -> Result<S, std::io::Error> + Send + Sync + 'static,
{
    StreamableHttpService::new(factory, LocalSessionManager::default().into(), config)
}
