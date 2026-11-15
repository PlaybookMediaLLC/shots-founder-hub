use crate::PAID_ENTITLEMENTS;
use crate::{auth, env::RuntimeConfig};
use axum::{Router, middleware};
use std::sync::Arc;

pub(crate) fn router(
    env: &RuntimeConfig,
    _analytics: Arc<anlg_analytics::AnalyticsClient>,
) -> Router {
    let auth_state = env.auth_state();
    let auth_state_paid = auth_state.clone().with_required_entitlements(
        PAID_ENTITLEMENTS
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
    );
    let auth_state_basic = auth_state.clone();
    let nango_config = env
        .nango
        .as_ref()
        .map(|nango| anlg_api_nango::NangoConfig::new(nango, env.database.clone()));
    use anlg_api_nango::NangoIntegrationId;
    let nango_webhook_routes = match nango_config.clone() {
        Some(config) => {
            let mut forward_handlers = anlg_api_nango::ForwardHandlerRegistry::new();
            forward_handlers.insert(
                anlg_api_nango::Linear::ID.to_string(),
                anlg_api_nango::forward_handler(anlg_linear::webhook::handle),
            );
            Router::new().nest(
                "/nango",
                anlg_api_nango::webhook_router(config, forward_handlers),
            )
        }
        None => Router::new(),
    };

    let integration_routes = match nango_config.clone() {
        Some(config) => {
            let nango_connection_state = anlg_api_nango::NangoConnectionState::from_config(&config);
            Router::new()
                .nest("/calendar", anlg_api_calendar::router())
                .nest("/mail", anlg_api_mail::router())
                .nest("/messenger", anlg_api_messenger::router())
                .nest("/notion", anlg_api_notion::router())
                .nest("/ticket", anlg_api_ticket::router())
                .nest("/zoom", anlg_api_zoom::router())
                .nest("/crm", anlg_api_crm::router())
                .merge(anlg_api_meeting_import::router())
                .nest("/nango", anlg_api_nango::session_router(config))
                .layer(axum::Extension(nango_connection_state))
                .route_layer(middleware::from_fn(auth::sentry_and_analytics))
                .route_layer(middleware::from_fn_with_state(
                    auth_state_paid,
                    auth::require_auth,
                ))
        }
        None => Router::new(),
    };

    let integration_management_routes = match nango_config {
        Some(config) => Router::new()
            .nest("/nango", anlg_api_nango::management_router(config))
            .route_layer(middleware::from_fn(auth::sentry_and_analytics))
            .route_layer(middleware::from_fn_with_state(
                auth_state_basic.clone(),
                auth::require_auth,
            )),
        None => Router::new(),
    };

    Router::new()
        .merge(nango_webhook_routes)
        .merge(integration_routes)
        .merge(integration_management_routes)
}
