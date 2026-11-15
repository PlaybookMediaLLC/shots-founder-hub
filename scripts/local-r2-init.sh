#!/bin/sh
set -eu
sign() {
  curl --fail --silent --show-error --aws-sigv4 'aws:amz:us-east-1:s3' --user "${RUSTFS_ACCESS_KEY}:${RUSTFS_SECRET_KEY}" "$@"
}
for bucket in shots-local founder-hub; do
  url="${R2_INIT_ENDPOINT:-http://rustfs:9000}/$bucket"
  if ! sign --head "$url" >/dev/null 2>&1; then sign --request PUT "$url" >/dev/null; fi
  printf '%s' "<CORSConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><CORSRule><AllowedOrigin>${R2_BROWSER_ORIGIN}</AllowedOrigin><AllowedOrigin>${HUB_BROWSER_ORIGIN}</AllowedOrigin><AllowedOrigin>http://localhost:1422</AllowedOrigin><AllowedOrigin>tauri://localhost</AllowedOrigin><AllowedOrigin>http://tauri.localhost</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>" | sign --request PUT --header 'Content-Type: application/xml' --data-binary @- "${url}?cors" >/dev/null
  printf '%s' '<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Rule><ID>abort-incomplete-uploads</ID><Filter><Prefix></Prefix></Filter><Status>Enabled</Status><AbortIncompleteMultipartUpload><DaysAfterInitiation>1</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule></LifecycleConfiguration>' | sign --request PUT --header 'Content-Type: application/xml' --data-binary @- "${url}?lifecycle" >/dev/null
done
