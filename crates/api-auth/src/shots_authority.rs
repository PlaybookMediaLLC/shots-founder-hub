use anlg_cloud_db::{Database, Principal};
use anlg_session_auth::server::Error;
use serde_json::{Value, json};

use crate::ShotsSession;

#[derive(Clone)]
pub struct ShotsAuthority(Database);

impl ShotsAuthority {
    pub fn new(database: Database) -> Self {
        Self(database)
    }

    pub async fn project(&self, session: &ShotsSession) -> Result<(), Error> {
        self.0
            .rpc::<Value>(
                &Principal::Service,
                "project_shots_authority",
                &json!({ "p_snapshot": session }),
            )
            .await
            .map_err(|_| Error::AuthorityUnavailable)?;
        Ok(())
    }
}
