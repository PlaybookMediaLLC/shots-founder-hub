use super::*;
fn test_source_hash(client_ip: Option<&str>) -> String {
    let state = SharedNotesState::new(
        crate::SharedNotesConfig::new(
            crate::test_support::database(),
            crate::test_support::storage(),
            "test-signing-key-at-least-thirty-two-bytes".into(),
        )
        .unwrap(),
    );
    let mut headers = HeaderMap::new();
    if let Some(client_ip) = client_ip {
        headers.insert(CLIENT_IP_HEADER, client_ip.parse().unwrap());
    }
    state.handoff_source_hash(&headers)
}
#[test]
fn handoff_source_hashes_are_canonical_and_do_not_expose_client_ips() {
    let canonical = test_source_hash(Some("2001:db8::1"));
    let expanded = test_source_hash(Some("2001:0db8:0000:0000:0000:0000:0000:0001"));
    let other = test_source_hash(Some("2001:db8::2"));

    assert_eq!(canonical, expanded);
    assert_ne!(canonical, other);
    assert_eq!(canonical.len(), 64);
    assert!(canonical.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert!(!canonical.contains("2001"));
}
