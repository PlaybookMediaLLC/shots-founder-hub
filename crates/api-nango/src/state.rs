use anlg_nango::NangoClient;

use crate::config::{NangoConfig, build_nango_client};
use crate::routes::webhook::ForwardHandlerRegistry;
use crate::store::ConnectionStore;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) config: NangoConfig,
    pub(crate) nango: NangoClient,
    pub(crate) store: ConnectionStore,
    pub(crate) forward_handlers: ForwardHandlerRegistry,
}

impl AppState {
    pub(crate) fn new(config: NangoConfig) -> Self {
        Self::with_forward_handlers(config, ForwardHandlerRegistry::new())
    }

    pub(crate) fn with_forward_handlers(
        config: NangoConfig,
        forward_handlers: ForwardHandlerRegistry,
    ) -> Self {
        let nango = build_nango_client(&config).expect("failed to build NangoClient");

        let store = ConnectionStore::new(config.database.clone());

        Self {
            config,
            nango,
            store,
            forward_handlers,
        }
    }
}
