CREATE TABLE founder_hub.yc_perk_claims (
  claim_id text PRIMARY KEY CHECK (claim_id ~ '^[a-f0-9]{64}$'),
  promotion_code text NOT NULL UNIQUE
    CHECK (promotion_code ~ '^YC-[A-F0-9]{24}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE founder_hub.yc_perk_claims ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE founder_hub.yc_perk_claims FROM PUBLIC, cloud_anonymous, cloud_member;
GRANT ALL ON TABLE founder_hub.yc_perk_claims TO cloud_service;
