REVOKE ALL ON TABLE founder_hub.e2ee_freshness_events FROM cloud_service;
GRANT SELECT, INSERT ON TABLE founder_hub.e2ee_freshness_events TO cloud_service;

REVOKE ALL ON SEQUENCE founder_hub.e2ee_freshness_events_sequence_seq
  FROM cloud_service;
GRANT USAGE, SELECT ON SEQUENCE founder_hub.e2ee_freshness_events_sequence_seq
  TO cloud_service;
