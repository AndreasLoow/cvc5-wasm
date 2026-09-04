#!/usr/bin/env bash
#
# Populate cvc5's dependency download directory before `ninja` runs.
#
# cvc5's --auto-download pulls GMP, CaDiCaL, SymFPU and LibPoly as tarballs
# from github.com.  Networks that allow git but not those download endpoints
# (some corporate proxies, and the sandbox this project was developed in) make
# the build fail with HTTP 403.  For each dependency this script therefore:
#
#   1. skips it if the tarball is already there with the SHA256 cvc5 pins;
#   2. tries the exact URL cvc5 pins;
#   3. falls back to a mirror reachable over plain git or raw.githubusercontent
#      -- GitHub's /archive/ tarballs are reproducible as
#      `git archive --format=tar --prefix=<name>/ <ref> | gzip -n`.
#
# Everything is checked against cvc5's pinned SHA256, so a wrong guess fails
# here instead of quietly building different sources.  Running this in a
# network without restrictions is a no-op beyond the downloads cvc5 would do
# anyway.
#
# Set DEPS_CACHE to a directory to keep the tarballs across build trees, so
# reconfiguring from scratch does not fetch them again.
#
# Usage: prefetch-deps.sh <cvc5-build-dir>
set -euo pipefail

build_dir=${1:?usage: prefetch-deps.sh <cvc5-build-dir>}
cache_dir=${DEPS_CACHE:-}
src_dir="$build_dir/deps/src"
[ -d "$src_dir" ] || { echo "no such directory: $src_dir" >&2; exit 1; }

msg() { echo "[prefetch-deps] $*"; }

sha256() { sha256sum "$1" | cut -d' ' -f1; }

# git-archive a single ref of a GitHub repository into a tarball that is
# byte-identical to https://github.com/<owner>/<repo>/archive/<ref>.tar.gz
github_archive() {
  local owner=$1 repo=$2 ref=$3 prefix=$4 out=$5
  local tmp
  tmp=$(mktemp -d)
  git init -q "$tmp"
  git -C "$tmp" remote add origin "https://github.com/$owner/$repo.git"
  git -C "$tmp" fetch -q --depth 1 origin "$ref"
  git -C "$tmp" archive --format=tar --prefix="$prefix/" FETCH_HEAD | gzip -n > "$out"
  rm -rf "$tmp"
}

# Rebuild one dependency tarball from a git-reachable mirror of its URL.
from_mirror() {
  local url=$1 out=$2 owner repo ref prefix path
  case $url in
    # A file committed in a repository, e.g. cvc5-deps/gmp-6.3.0.tar.bz2.
    https://github.com/*/blob/*)
      owner=$(echo "$url" | cut -d/ -f4)
      repo=$(echo "$url" | cut -d/ -f5)
      ref=$(echo "$url" | cut -d/ -f7)
      path=$(echo "$url" | cut -d/ -f8- | sed 's/?.*//')
      curl -fsSL -o "$out" "https://raw.githubusercontent.com/$owner/$repo/$ref/$path"
      ;;
    # A tag or commit archive.
    https://github.com/*/archive/*)
      owner=$(echo "$url" | cut -d/ -f4)
      repo=$(echo "$url" | cut -d/ -f5)
      ref=$(basename "$url" .tar.gz)
      # GitHub names the archive's top directory <repo>-<ref>, with a leading
      # "v" dropped from version tags.
      prefix="$repo-$(echo "$ref" | sed -E 's/^v([0-9])/\1/')"
      github_archive "$owner" "$repo" "$ref" "$prefix" "$out"
      ;;
    *)
      return 1
      ;;
  esac
}

for info in "$src_dir"/*-EP-stamp/*-urlinfo.txt; do
  name=$(basename "$(dirname "$info")")
  name=${name%-EP-stamp}
  # Murxla is cvc5's fuzzer; nothing we build depends on it.
  [ "$name" = Murxla ] && continue

  url=$(sed -n 's/^url(s)=//p' "$info" | head -1)
  want=$(sed -n 's/^hash=SHA256=//p' "$info" | head -1)
  [ -n "$url" ] && [ -n "$want" ] || { msg "$name: no url/hash in $info, skipping"; continue; }
  file="$src_dir/$(basename "${url%%\?*}")"

  if [ -s "$file" ] && [ "$(sha256 "$file")" = "$want" ]; then
    msg "$name: already present"
    continue
  fi

  if [ -n "$cache_dir" ] && [ -s "$cache_dir/$(basename "$file")" ] \
     && [ "$(sha256 "$cache_dir/$(basename "$file")")" = "$want" ]; then
    cp "$cache_dir/$(basename "$file")" "$file"
    msg "$name: taken from $cache_dir"
    continue
  fi

  rm -f "$file"
  if curl -fsSL --retry 3 -o "$file" "$url" && [ "$(sha256 "$file")" = "$want" ]; then
    msg "$name: downloaded from $url"
    continue
  fi

  rm -f "$file"
  msg "$name: $url unusable, rebuilding from a git mirror"
  from_mirror "$url" "$file"
  got=$(sha256 "$file")
  if [ "$got" != "$want" ]; then
    rm -f "$file"
    msg "$name: mirror gave SHA256 $got, cvc5 pins $want"
    exit 1
  fi
  msg "$name: mirrored"
done

if [ -n "$cache_dir" ]; then
  mkdir -p "$cache_dir"
  for info in "$src_dir"/*-EP-stamp/*-urlinfo.txt; do
    url=$(sed -n 's/^url(s)=//p' "$info" | head -1)
    file="$src_dir/$(basename "${url%%\?*}")"
    [ -s "$file" ] && cp -n "$file" "$cache_dir/" || true
  done
fi
