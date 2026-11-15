REVOKE EXECUTE ON FUNCTION
  founder_hub.read_my_session_share_snapshot(uuid),
  founder_hub.read_my_session_share_snapshot_v2(uuid),
  founder_hub.read_my_session_share_snapshot_with_attachments(uuid),
  founder_hub.list_my_session_share_snapshots(),
  founder_hub.list_my_session_share_snapshots_with_attachments(),
  founder_hub.list_my_session_share_snapshot_page(uuid, integer),
  founder_hub.list_my_session_share_snapshot_page_v2(uuid, integer),
  founder_hub.list_my_session_share_snapshot_page_with_attachments(uuid, integer),
  founder_hub.read_session_share_link_snapshot(uuid, text),
  founder_hub.read_public_session_share_snapshot(text)
FROM cloud_service;
