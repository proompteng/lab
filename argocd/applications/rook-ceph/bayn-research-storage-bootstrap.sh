#!/usr/bin/env bash
set -euo pipefail
umask 077

owner_dir=${1:-/owner}
capture_dir=${2:-/capture}
config_dir=${3:-/config}
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
endpoint=http://rook-ceph-rgw-objectstore.rook-ceph.svc.cluster.local:80
bucket=bayn-research
user=bayn-research-capture
key=captures/v1/_permission-probe/storage-v1.txt
outside_key=_permission-probe/outside-prefix.txt

api() {
  aws --endpoint-url "$endpoint" --cli-connect-timeout 10 --cli-read-timeout 30 "$@"
}

same_content() {
  local expected_hash actual_hash
  expected_hash=$(sha256sum "$1" | cut -d ' ' -f 1)
  actual_hash=$(sha256sum "$2" | cut -d ' ' -f 1)
  if [[ "$expected_hash" != "$actual_hash" ]]; then
    echo 'Content SHA-256 mismatch' >&2
    exit 1
  fi
}

expect_denied() {
  if api "$@" >"$scratch/denied-output" 2>"$scratch/denied-error"; then
    echo "Permission check unexpectedly allowed: $1 $2" >&2
    exit 1
  fi
  if ! grep -q '(AccessDenied)' "$scratch/denied-error"; then
    echo "Permission check failed without AccessDenied: $1 $2" >&2
    exit 1
  fi
  echo "Denied: $1 $2 (AccessDenied)"
}

export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
AWS_ACCESS_KEY_ID=$(cat "$owner_dir/AccessKey")
AWS_SECRET_ACCESS_KEY=$(cat "$owner_dir/SecretKey")
if ! api s3api create-bucket --bucket "$bucket" --acl private >"$scratch/create-output" 2>"$scratch/create-error"; then
  if ! grep -q '(BucketAlreadyOwnedByYou)' "$scratch/create-error"; then
    echo 'Could not create the private research bucket for its dedicated account' >&2
    exit 1
  fi
fi
api s3api put-bucket-acl --bucket "$bucket" --acl private
api s3api put-public-access-block --bucket "$bucket" --public-access-block-configuration \
  'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'
public_block=$(api s3api get-public-access-block --bucket "$bucket" --output text --query \
  '[PublicAccessBlockConfiguration.BlockPublicAcls,PublicAccessBlockConfiguration.IgnorePublicAcls,PublicAccessBlockConfiguration.BlockPublicPolicy,PublicAccessBlockConfiguration.RestrictPublicBuckets]')
[[ "$public_block" == $'True\tTrue\tTrue\tTrue' ]]
owner_id=$(api s3api get-bucket-acl --bucket "$bucket" --query Owner.ID --output text)
[[ "$owner_id" == RGW* ]]
api iam put-user-policy --user-name "$user" --policy-name capture-prefix-v1 --policy-document "file://$config_dir/policy.json"
api iam get-user-policy --user-name "$user" --policy-name capture-prefix-v1 --query PolicyDocument --output json >"$scratch/applied-policy.json"
tr -d '[:space:]' <"$config_dir/policy.json" >"$scratch/expected-policy"
tr -d '[:space:]' <"$scratch/applied-policy.json" >"$scratch/actual-policy"
same_content "$scratch/expected-policy" "$scratch/actual-policy"

printf 'bayn-research-storage-permission-probe-v1\n' >"$scratch/expected"
api s3api put-object --bucket "$bucket" --key "$outside_key" --acl private --body "$scratch/expected" >/dev/null
api s3api get-object --bucket "$bucket" --key "$outside_key" "$scratch/outside-owner" >/dev/null
same_content "$scratch/expected" "$scratch/outside-owner"
echo 'Verified: private bucket, public-access block, exact identity policy, retained off-prefix fixture'

AWS_ACCESS_KEY_ID=$(cat "$capture_dir/AccessKey")
AWS_SECRET_ACCESS_KEY=$(cat "$capture_dir/SecretKey")
api s3api put-object --bucket "$bucket" --key "$key" --acl private --body "$scratch/expected" >/dev/null
api s3api get-object --bucket "$bucket" --key "$key" "$scratch/actual" >/dev/null
same_content "$scratch/expected" "$scratch/actual"
echo "Allowed: private PutObject and exact GetObject, SHA-256 $(sha256sum "$scratch/actual" | cut -d ' ' -f 1)"
expect_denied s3api list-buckets
expect_denied s3api list-objects-v2 --bucket "$bucket" --prefix captures/v1/ --max-keys 1
expect_denied s3api delete-object --bucket "$bucket" --key "$key"
expect_denied s3api get-bucket-policy --bucket "$bucket"
expect_denied iam get-user-policy --user-name "$user" --policy-name capture-prefix-v1
expect_denied s3api get-object --bucket "$bucket" --key "$outside_key" "$scratch/outside-capture"
expect_denied s3api put-object --bucket "$bucket" --key "$outside_key" --acl private --body "$scratch/expected"
expect_denied s3api put-object --bucket "$bucket" --key "$key" --acl public-read --body "$scratch/expected"
expect_denied s3api put-object --bucket "$bucket" --key "$key" --grant-read "id=\"$owner_id\"" --body "$scratch/expected"
expect_denied s3api put-object --bucket "$bucket" --key "$key" --body "$scratch/expected"
expect_denied s3api create-multipart-upload --bucket "$bucket" --key "$key" --acl private
expect_denied s3api get-object --no-sign-request --bucket "$bucket" --key "$key" "$scratch/anonymous"
api s3api get-object --bucket "$bucket" --key "$key" "$scratch/retained" >/dev/null
same_content "$scratch/expected" "$scratch/retained"
echo 'Verified: only private capture Put/Get, global and bucket listing denied, deletion denied, prefix isolated'
