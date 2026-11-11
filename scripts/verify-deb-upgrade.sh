#!/usr/bin/env bash
set -euo pipefail

deb_path="$1"
binary_path="$2"
package_name="${binary_path##*/}"
actual_name=$(dpkg-deb --field "$deb_path" Package)
if [[ "$actual_name" != "$package_name" ]]; then
  echo "Expected Debian package $package_name, got $actual_name" >&2
  exit 1
fi

# An older package must already own the binary to catch rename/file conflicts.
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
mkdir -p "$fixture_dir/old/DEBIAN" "$fixture_dir/old$(dirname "$binary_path")"
printf '%s\n' "Package: $package_name" "Version: 0~upgrade-smoke" \
  "Architecture: $(dpkg-deb --field "$deb_path" Architecture)" \
  'Maintainer: Shots Founder Hub' 'Description: Legacy package upgrade fixture' \
  > "$fixture_dir/old/DEBIAN/control"
printf '%s\n' 'legacy binary' > "$fixture_dir/old$binary_path"
dpkg-deb --build "$fixture_dir/old" "$fixture_dir/old.deb"
apt-get install -y "$fixture_dir/old.deb"
apt-get install -y "$deb_path"

expected_version=$(dpkg-deb --field "$deb_path" Version)
installed_version=$(dpkg-query --show --showformat='${Version}' "$package_name")
[[ "$installed_version" == "$expected_version" ]]
[[ -x "$binary_path" ]]
! grep -qx 'legacy binary' "$binary_path"
