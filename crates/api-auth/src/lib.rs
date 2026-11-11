use anlg_supabase_auth::server::{Error as SupabaseAuthError, SupabaseAuth};
use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};

pub use anlg_supabase_auth::Claims;
mod shots;
mod shots_storage;
pub use shots::{ShotsAuth, ShotsSession, ShotsUser, ShotsWorkspace};
pub use shots_storage::ShotsStorage;

#[derive(Clone)]
pub struct AuthContext {
    pub shots: Option<ShotsSession>,
    pub token: String,
    pub claims: Claims,
}

#[derive(Clone)]
pub struct AuthState {
    inner: SupabaseAuth,
    shots: Option<ShotsAuth>,
    required_entitlements: Option<Vec<String>>,
}

impl AuthState {
    pub fn new(supabase_url: &str) -> Self {
        Self {
            inner: SupabaseAuth::new(supabase_url),
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
        SupabaseAuth::extract_token(auth_header)
    }

    pub async fn verify_token(&self, token: &str) -> Result<Claims, AuthError> {
        if let Some(shots) = &self.shots {
            return shots
                .session(token)
                .await
                .map(|session| session.claims())
                .map_err(AuthError);
        }
        self.inner.verify_token(token).await.map_err(AuthError)
    }

    pub async fn authenticate(&self, token: &str) -> Result<AuthContext, AuthError> {
        if let Some(shots) = &self.shots {
            return shots.authenticate(token).await.map_err(AuthError);
        }
        Ok(AuthContext {
            token: token.to_owned(),
            claims: self.verify_token(token).await?,
            shots: None,
        })
    }

    pub async fn verify_oauth_token(
        &self,
        token: &str,
        resource: &str,
        required_scopes: &[&str],
    ) -> Result<Claims, OAuthTokenError> {
        if self.shots.is_some() {
            return Err(OAuthTokenError::Invalid);
        }
        self.inner
            .verify_oauth_token(token, resource, required_scopes)
            .await
            .map_err(|error| match error {
                SupabaseAuthError::MissingScope(_) => OAuthTokenError::InsufficientScope,
                _ => OAuthTokenError::Invalid,
            })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OAuthTokenError {
    Invalid,
    InsufficientScope,
}

pub struct AuthError(SupabaseAuthError);

impl From<SupabaseAuthError> for AuthError {
    fn from(err: SupabaseAuthError) -> Self {
        Self(err)
    }
}

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        let (status, message) = match self.0 {
            SupabaseAuthError::MissingAuthHeader => {
                (StatusCode::UNAUTHORIZED, "missing_authorization_header")
            }
            SupabaseAuthError::InvalidAuthHeader => {
                (StatusCode::UNAUTHORIZED, "invalid_authorization_header")
            }
            SupabaseAuthError::JwksFetchFailed => {
                (StatusCode::INTERNAL_SERVER_ERROR, "jwks_fetch_failed")
            }
            SupabaseAuthError::InvalidToken => (StatusCode::UNAUTHORIZED, "invalid_token"),
            SupabaseAuthError::MissingOAuthClient => (StatusCode::UNAUTHORIZED, "invalid_token"),
            SupabaseAuthError::MissingScope(_) => (StatusCode::FORBIDDEN, "insufficient_scope"),
            SupabaseAuthError::MissingEntitlement(_) => {
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
        .ok_or(SupabaseAuthError::MissingAuthHeader)?;

    let token = SupabaseAuth::extract_token(auth_header)
        .ok_or(SupabaseAuthError::InvalidAuthHeader)?
        .to_owned();

    let auth = state.authenticate(&token).await?;
    if let Some(entitlements) = &state.required_entitlements {
        if !entitlements
            .iter()
            .any(|entitlement| auth.claims.has_entitlement(entitlement))
        {
            return Err(SupabaseAuthError::MissingEntitlement(entitlements.join(",")).into());
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
        && let Some(token) = SupabaseAuth::extract_token(auth_header)
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
                SupabaseAuthError::MissingAuthHeader,
                StatusCode::UNAUTHORIZED,
            ),
            (
                SupabaseAuthError::InvalidAuthHeader,
                StatusCode::UNAUTHORIZED,
            ),
            (
                SupabaseAuthError::JwksFetchFailed,
                StatusCode::INTERNAL_SERVER_ERROR,
            ),
            (SupabaseAuthError::InvalidToken, StatusCode::UNAUTHORIZED),
            (
                SupabaseAuthError::MissingEntitlement("pro".to_string()),
                StatusCode::FORBIDDEN,
            ),
        ];

        for (error, expected_status) in cases {
            let response = AuthError(error).into_response();
            assert_eq!(response.status(), expected_status);
        }
    }
}
