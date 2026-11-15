GRANT SELECT (id, invoice_settings, default_source)
ON TABLE stripe.customers
TO cloud_identity_admin;
