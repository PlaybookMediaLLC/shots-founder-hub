mod ai;
mod core;
mod sync;

pub(super) use ai::router as ai;
pub(super) use core::router as core;
#[cfg(test)]
pub(super) use sync::build_sync_routes;
pub(super) use sync::router as sync;
