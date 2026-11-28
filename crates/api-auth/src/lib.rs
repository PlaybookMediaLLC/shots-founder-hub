use anlg_session_auth::server::Error as SessionAuthError;
use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};

pub use anlg_session_auth::Claims;
mod shots;
mod shots_authority;
pub use shots::{ShotsAuth, ShotsSession, ShotsUser, ShotsWorkspace};
pub use shots_authority::ShotsAuthority;

#[derive(Clone)]
pub struct AuthContext {
    pub shots: Option<ShotsSession>,
    pub token: String,
    pub claims: Claims,
}

impl AuthContext {
    pub fn principal(&self) -> Result<anlg_cloud_db::Principal, AuthError> {
        self.shots
            .as_ref()
            .map(ShotsSession::principal)
            .ok_or_else(|| SessionAuthError::InvalidToken.into())
    }
}

#[derive(Clone)]
pub struct AuthState {
    shots: Option<ShotsAuth>,
    required_entitlements: Option<Vec<String>>,
}

impl AuthState {
    pub fn new() -> Self {
        Self {
            shots: None,
            required_entitlements: None,
        }
    }

    pub fn with_shots(mut self, shots: Option<ShotsAuth>) -> Self {
        self.shots = shots;
        self
    }

    pub fn shots(&self) -> Option<&ShotsAuth> {
        self.shots.as_ref()
    }

    pub fn with_required_entitlement(mut self, entitlement: impl Into<String>) -> Self {
        self.required_entitlements = Some(vec![entitlement.into()]);
        self
    }

    pub fn with_required_entitlements(mut self, entitlements: Vec<String>) -> Self {
        self.required_entitlements = Some(entitlements);
        self
    }

    pub fn extract_token(auth_header: &str) -> Option<&str> {
        auth_header
            .strip_prefix("Bearer ")
            .or_else(|| auth_header.strip_prefix("bearer "))
            .or_else(|| auth_header.strip_prefix("Token "))
            .or_else(|| auth_header.strip_prefix("token "))
            .filter(|token| !token.is_empty())
    }

    pub async fn verify_token(&self, token: &str) -> Result<Claims, AuthError> {
        if let Some(shots) = &self.shots {
            return shots
                .session(token)
                .await
                .map(|session| session.claims())
                .map_err(AuthError);
        }
        Err(SessionAuthError::AuthorityUnavailable.into())
    }

    pub async fn authenticate(&self, token: &str) -> Result<AuthContext, AuthError> {
        if let Some(shots) = &self.shots {
            return shots.authenticate(token).await.map_err(AuthError);
        }
        Err(SessionAuthError::AuthorityUnavailable.into())
    }
}

impl Default for AuthState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OAuthTokenError {
    Invalid,
    InsufficientScope,
}

#[derive(Debug, thiserror::Error)]
#[error(transparent)]
pub struct AuthError(SessionAuthError);

impl From<SessionAuthError> for AuthError {
    fn from(err: SessionAuthError) -> Self {
        Self(err)
    }
}

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        let (status, message) = match self.0 {
            SessionAuthError::MissingAuthHeader => {
                (StatusCode::UNAUTHORIZED, "missing_authorization_header")
            }
            SessionAuthError::InvalidAuthHeader => {
                (StatusCode::UNAUTHORIZED, "invalid_authorization_header")
            }
            SessionAuthError::AuthorityUnavailable => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "session_authority_unavailable",
            ),
            SessionAuthError::InvalidToken => (StatusCode::UNAUTHORIZED, "invalid_token"),
            SessionAuthError::MissingOAuthClient => (StatusCode::UNAUTHORIZED, "invalid_token"),
            SessionAuthError::MissingScope(_) => (StatusCode::FORBIDDEN, "insufficient_scope"),
            SessionAuthError::MissingEntitlement(_) => {
                (StatusCode::FORBIDDEN, "subscription_required")
            }
        };
        (status, message).into_response()
    }
}

pub async fn require_auth(
    State(state): State<AuthState>,
    mut request: Request,
    next: Next,
) -> Result<Response, AuthError> {
    let auth_header = request
        .headers()
        .get("Authorization")
        .and_then(|h| h.to_str().ok())
        .ok_or(SessionAuthError::MissingAuthHeader)?;

    let token = AuthState::extract_token(auth_header)
        .ok_or(SessionAuthError::InvalidAuthHeader)?
        .to_owned();

    let auth = state.authenticate(&token).await?;
    if let Some(entitlements) = &state.required_entitlements {
        if !entitlements
            .iter()
            .any(|entitlement| auth.claims.has_entitlement(entitlement))
        {
            return Err(SessionAuthError::MissingEntitlement(entitlements.join(",")).into());
        }
    }

    request.extensions_mut().insert(auth);

    Ok(next.run(request).await)
}

pub async fn optional_auth(
    State(state): State<AuthState>,
    mut request: Request,
    next: Next,
) -> Response {
    if let Some(auth_header) = request
        .headers()
        .get("Authorization")
        .and_then(|h| h.to_str().ok())
        && let Some(token) = AuthState::extract_token(auth_header)
    {
        let token = token.to_owned();
        if let Ok(auth) = state.authenticate(&token).await {
            request.extensions_mut().insert(auth);
        }
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_errors_map_to_http_status() {
        let cases = [
            (
                SessionAuthError::MissingAuthHeader,
                StatusCode::UNAUTHORIZED,
            ),
            (
                SessionAuthError::InvalidAuthHeader,
                StatusCode::UNAUTHORIZED,
            ),
            (
                SessionAuthError::AuthorityUnavailable,
                StatusCode::INTERNAL_SERVER_ERROR,
            ),
            (SessionAuthError::InvalidToken, StatusCode::UNAUTHORIZED),
            (
                SessionAuthError::MissingEntitlement("pro".to_string()),
                StatusCode::FORBIDDEN,
            ),
        ];

        for (error, expected_status) in cases {
            let response = AuthError(error).into_response();
            assert_eq!(response.status(), expected_status);
        }
    }
}
