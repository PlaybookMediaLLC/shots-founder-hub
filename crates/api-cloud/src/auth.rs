use anlg_api_auth::{AuthContext, OAuthTokenError};
use axum::{
    extract::{Request, State},
    http::header,
    middleware::Next,
    response::Response,
};
use sha2::{Digest, Sha256};

use crate::{CloudApiError, state::AppState};

pub async fn require_cloud_connector_auth(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Result<Response, CloudApiError> {
    let token = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(anlg_api_auth::AuthState::extract_token)
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
        .ok_or_else(|| unauthorized(&state, None))?;

    if token.starts_with("anl_") {
        return require_api_key(&state, &token, request, next).await;
    }

    let auth = if request.uri().path().starts_with("/mcp") {
        verify_oauth_token(&state, &token).await?
    } else {
        match state.verify_session_token(&token).await {
            Ok(auth) => auth,
            Err(_) => verify_oauth_token(&state, &token).await?,
        }
    };
    if auth.shots.is_some() {
        if !auth.claims.is_pro() {
            return Err(CloudApiError::SubscriptionRequired);
        }
        if !state
            .get_settings(&auth.claims.sub)
            .await
            .map_err(|e| CloudApiError::Internal(e.to_string()))?
            .enabled
        {
            return Err(CloudApiError::NotEnabled);
        }
    } else {
        enforce_user_status(&state, &auth.claims.sub).await?;
    }
    request.extensions_mut().insert(auth);

    Ok(next.run(request).await)
}

async fn verify_oauth_token(state: &AppState, token: &str) -> Result<AuthContext, CloudApiError> {
    state
        .verify_oauth_token(token)
        .await
        .map_err(|error| match error {
            OAuthTokenError::Invalid => unauthorized(
                state,
                Some(("invalid_token", "Access token is invalid or expired")),
            ),
            OAuthTokenError::InsufficientScope => {
                CloudApiError::InsufficientScope(state.oauth().challenge(Some((
                    "insufficient_scope",
                    "Access token is missing a required scope",
                ))))
            }
        })
}

async fn require_api_key(
    state: &AppState,
    token: &str,
    mut request: Request,
    next: Next,
) -> Result<Response, CloudApiError> {
    if token.len() != 68 {
        return Err(unauthorized(state, None));
    }
    let key_hash = Sha256::digest(token.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let central = if let Some(shots) = state.shots() {
        let binding = state
            .lookup_shots_key(&key_hash)
            .await
            .map_err(|error| CloudApiError::Internal(error.to_string()))?
            .ok_or_else(|| unauthorized(state, None))?;
        let auth = shots
            .key_session(&binding.shots_user_id, &binding.shots_session_id)
            .await
            .map_err(|_| unauthorized(state, None))?;
        if auth.claims.sub != binding.user_id {
            return Err(unauthorized(state, None));
        }
        if !auth.claims.is_pro() {
            return Err(CloudApiError::SubscriptionRequired);
        }
        Some(auth)
    } else {
        None
    };
    let verified = state
        .verify_key(&key_hash)
        .await
        .map_err(|error| CloudApiError::Internal(error.to_string()))?
        .ok_or_else(|| unauthorized(state, None))?;

    match verified.status.as_str() {
        "ok" => {}
        "subscription_required" => return Err(CloudApiError::SubscriptionRequired),
        "cloud_api_not_enabled" => return Err(CloudApiError::NotEnabled),
        _ => return Err(unauthorized(state, None)),
    }

    if central
        .as_ref()
        .is_some_and(|auth| auth.claims.sub != verified.user_id)
    {
        return Err(unauthorized(state, None));
    }
    request
        .extensions_mut()
        .insert(central.unwrap_or_else(|| AuthContext {
            shots: None,
            token: String::new(),
            claims: anlg_api_auth::Claims {
                sub: verified.user_id,
                email: None,
                entitlements: vec!["hyprnote_pro".to_string()],
                subscription_status: None,
                trial_end: None,
                has_payment_method: None,
                referral_extension: None,
            },
        }));

    Ok(next.run(request).await)
}

async fn enforce_user_status(state: &AppState, user_id: &str) -> Result<(), CloudApiError> {
    let verified = state
        .verify_user(user_id)
        .await
        .map_err(|error| CloudApiError::Internal(error.to_string()))?;
    match verified.status.as_str() {
        "ok" => Ok(()),
        "subscription_required" => Err(CloudApiError::SubscriptionRequired),
        "cloud_api_not_enabled" => Err(CloudApiError::NotEnabled),
        _ => Err(unauthorized(state, None)),
    }
}

fn unauthorized(state: &AppState, error: Option<(&str, &str)>) -> CloudApiError {
    CloudApiError::Unauthorized(state.oauth().challenge(error))
}
