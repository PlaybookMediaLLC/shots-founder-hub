pub mod transcription_job {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "transcription_jobs", schema_name = "founder_hub")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub user_id: Uuid,
        pub file_id: String,
        pub provider: String,
        pub status: String,
        pub provider_request_id: Option<String>,
        pub raw_result: Option<Json>,
        pub error: Option<String>,
        pub created_at: DateTimeWithTimeZone,
        pub updated_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
}

pub mod file_upload {
    use sea_orm::entity::prelude::*;
    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "file_uploads", schema_name = "founder_hub_private")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub bucket: String,
        pub object_key: String,
        pub owner_user_id: Uuid,
        pub token_hash: String,
        pub upload_id: String,
        pub content_type: String,
        pub metadata: Json,
        pub size_bytes: i64,
        pub status: String,
        pub expires_at: DateTimeWithTimeZone,
        pub created_at: DateTimeWithTimeZone,
    }
    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
}

pub mod device_enrollment {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(
        table_name = "e2ee_device_enrollment_requests",
        schema_name = "founder_hub"
    )]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub user_id: Uuid,
        pub device_fingerprint: String,
        pub device_name: Option<String>,
        pub recipient_public_key: String,
        pub ephemeral_public_key: Option<String>,
        pub nonce: Option<String>,
        pub ciphertext: Option<String>,
        pub created_at: DateTimeWithTimeZone,
        pub expires_at: DateTimeWithTimeZone,
        pub sealed_at: Option<DateTimeWithTimeZone>,
        pub consumed_at: Option<DateTimeWithTimeZone>,
    }
    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
}

pub mod nango_connection {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "nango_connections", schema_name = "founder_hub")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub user_id: Uuid,
        pub integration_id: String,
        pub connection_id: String,
        pub provider: String,
        pub created_at: DateTimeWithTimeZone,
        pub updated_at: DateTimeWithTimeZone,
        pub status: String,
        pub last_error_type: Option<String>,
        pub last_error_description: Option<String>,
        pub last_error_at: Option<DateTimeWithTimeZone>,
    }
    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
}

pub mod profile {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "profiles", schema_name = "founder_hub")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub stripe_customer_id: Option<String>,
        pub trial_reservation_id: Option<Uuid>,
        pub trial_reservation_channel: Option<String>,
        pub trial_reserved_until: Option<DateTimeWithTimeZone>,
    }
    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
}

pub mod sync_device {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "sync_devices", schema_name = "founder_hub")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub user_id: Uuid,
        pub device_fingerprint: String,
        pub device_name: Option<String>,
        pub created_at: DateTimeWithTimeZone,
        pub last_seen_at: DateTimeWithTimeZone,
    }
    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
}

pub mod sync_transport_override {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "sync_transport_overrides", schema_name = "founder_hub")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub user_id: Uuid,
        pub transport: String,
        pub note: Option<String>,
        pub created_at: DateTimeWithTimeZone,
        pub updated_at: DateTimeWithTimeZone,
    }
    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
}

pub mod workspace_membership {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "workspace_memberships", schema_name = "founder_hub")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub workspace_id: Uuid,
        pub user_id: Uuid,
        pub role: String,
        pub created_at: DateTimeWithTimeZone,
        pub updated_at: DateTimeWithTimeZone,
        pub deleted_at: Option<DateTimeWithTimeZone>,
    }
    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {
        #[sea_orm(
            belongs_to = "super::workspace::Entity",
            from = "Column::WorkspaceId",
            to = "super::workspace::Column::Id"
        )]
        Workspace,
    }
    impl Related<super::workspace::Entity> for Entity {
        fn to() -> RelationDef {
            Relation::Workspace.def()
        }
    }
    impl ActiveModelBehavior for ActiveModel {}
}

pub mod workspace {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "workspaces", schema_name = "founder_hub")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub owner_user_id: Uuid,
        pub kind: String,
        pub name: String,
        pub created_at: DateTimeWithTimeZone,
        pub updated_at: DateTimeWithTimeZone,
        pub deleted_at: Option<DateTimeWithTimeZone>,
        pub e2ee_key_id: Option<String>,
        pub e2ee_freshness_initialized_at: Option<DateTimeWithTimeZone>,
        pub stripe_customer_id: Option<String>,
        pub seat_limit: Option<i32>,
        pub share_slug: Option<String>,
        pub logo_data: Option<String>,
        pub e2ee_cloud_authority_after: Option<i64>,
    }
    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
}

pub mod yc_perk_claim {
    use sea_orm::entity::prelude::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
    #[sea_orm(table_name = "yc_perk_claims", schema_name = "founder_hub")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub claim_id: String,
        pub promotion_code: String,
        pub created_at: DateTimeWithTimeZone,
    }
    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
}

pub mod identity_user {
    use sea_orm::entity::prelude::*;
    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(schema_name = "founder_hub_identity", table_name = "users")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub aud: Option<String>,
        pub role: Option<String>,
        pub email: Option<String>,
        pub email_confirmed_at: Option<DateTimeWithTimeZone>,
        pub phone_confirmed_at: Option<DateTimeWithTimeZone>,
        pub confirmed_at: Option<DateTimeWithTimeZone>,
        pub created_at: DateTimeWithTimeZone,
        pub updated_at: DateTimeWithTimeZone,
        pub last_sign_in_at: Option<DateTimeWithTimeZone>,
        pub is_anonymous: bool,
        pub raw_app_meta_data: Json,
        pub raw_user_meta_data: Json,
    }
    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
}
