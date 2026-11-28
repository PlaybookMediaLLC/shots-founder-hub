use thiserror::Error;

pub type Result<T> = std::result::Result<T, SubscriptionError>;

#[derive(Debug, Error)]
pub enum SubscriptionError {
    #[error("Database request failed: {0}")]
    Database(String),
    #[error("Internal error: {0}")]
    Internal(String),
}
