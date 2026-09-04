#!/usr/bin/env bash
#
# Build cvc5 as a WebAssembly library and write dist/.
#
#   ./build.sh                 full build into .build/ and dist/
#   DESIGN=2 ./build.sh        link the persistent-session variant instead
#   JOBS=8 ./build.sh          override the parallelism
#   BUILD_ROOT=... DIST_DIR=...
#
# Everything is downloaded into BUILD_ROOT (default .build/); nothing is
# installed system-wide.  Re-running reuses what is already there.
set -euo pipefail

# --- pinned versions -------------------------------------------------------
CVC5_TAG=cvc5-1.3.4
CVC5_COMMIT=f3b21c4483d3b88dc63cb7cd3e5eb092eee5e341
EMSDK_VERSION=3.1.70

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
build_root=${BUILD_ROOT:-$repo_dir/.build}
dist_dir=${DIST_DIR:-$repo_dir/dist}
emsdk_dir=$build_root/emsdk
cvc5_dir=$build_root/cvc5
cvc5_build=$cvc5_dir/build
# 1 = fresh TermManager/Solver/SymbolManager per call (the shipped design),
# 2 = one session reset between calls.  See README.md.
design=${DESIGN:-1}
# js   = -fexceptions, emscripten's JavaScript-based exceptions (task.md's flag)
# wasm = -fwasm-exceptions, the wasm exception-handling proposal
exceptions=${EXCEPTIONS:-js}
case $exceptions in
  js) exception_flag=-fexceptions ;;
  wasm) exception_flag=-fwasm-exceptions ;;
  *) echo "EXCEPTIONS must be js or wasm, not $exceptions" >&2; exit 1 ;;
esac
jobs=${JOBS:-$( (command -v nproc >/dev/null && nproc) || sysctl -n hw.ncpu || echo 4 )}

msg() { echo "[build.sh] $*"; }

# --- emsdk -----------------------------------------------------------------
install_emsdk() {
  if [ ! -d "$emsdk_dir" ]; then
    msg "cloning emsdk"
    git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$emsdk_dir"
  fi
  if [ ! -e "$emsdk_dir/upstream/emscripten/em++" ] \
     || ! grep -q "$EMSDK_VERSION" "$emsdk_dir/.emscripten" 2>/dev/null; then
    msg "installing emsdk $EMSDK_VERSION"
    (cd "$emsdk_dir" && ./emsdk install "$EMSDK_VERSION" && ./emsdk activate "$EMSDK_VERSION")
  fi
  # shellcheck disable=SC1091
  source "$emsdk_dir/emsdk_env.sh" >/dev/null 2>&1
  msg "$(em++ --version | head -1)"
}

# --- cvc5 sources ----------------------------------------------------------
fetch_cvc5() {
  if [ ! -d "$cvc5_dir" ]; then
    msg "cloning cvc5 $CVC5_TAG"
    git clone --depth 1 --branch "$CVC5_TAG" https://github.com/cvc5/cvc5.git "$cvc5_dir"
  fi
  local have
  have=$(git -C "$cvc5_dir" rev-parse "$CVC5_TAG^{commit}")
  [ "$have" = "$CVC5_COMMIT" ] \
    || { msg "$CVC5_TAG is $have, expected $CVC5_COMMIT"; exit 1; }
}

# --- patches ---------------------------------------------------------------
# cvc5's sources are otherwise untouched; each patch in patches/ carries its
# own rationale, and README.md explains why it is there.  They are committed
# in the checkout rather than left in the worktree, because cvc5 appends
# "-modified" to the version it reports for a dirty tree.
apply_patches() {
  local p applied=()
  for p in "$repo_dir"/patches/*.patch; do
    [ -f "$p" ] || continue
    if git -C "$cvc5_dir" apply --reverse --check "$p" >/dev/null 2>&1; then
      msg "$(basename "$p") already applied"
    elif git -C "$cvc5_dir" apply "$p"; then
      msg "applied $(basename "$p")"
      applied+=("$(basename "$p")")
    else
      msg "failed to apply $(basename "$p")"
      exit 1
    fi
  done
  if [ ${#applied[@]} -gt 0 ]; then
    git -C "$cvc5_dir" \
      -c user.email=build@cvc5-wasm.invalid -c user.name=cvc5-wasm \
      commit -qam "cvc5-wasm patches: ${applied[*]}"
  fi
}

# --- configure and build the static libraries ------------------------------
# cvc5's own wasm CI uses the same configure line (see its .github/workflows);
# -fexceptions is added for C++ because cvc5 reports errors by throwing and
# emscripten drops catch handlers unless it is compiled in.  Only the library
# targets are built: the command-line binary is not needed.
build_cvc5() {
  # No --ninja: LibPoly's CMake defines two rules for libpoly.a when the
  # platform has no shared libraries, which Ninja rejects and Make tolerates.
  if [ ! -f "$cvc5_build/Makefile" ]; then
    msg "configuring cvc5"
    (cd "$cvc5_dir" && ./configure.sh production \
        --static --static-binary --auto-download --wasm=JS \
        "-DCMAKE_CXX_FLAGS=$exception_flag")
  fi
  DEPS_CACHE="$build_root/dlcache" "$repo_dir/tools/prefetch-deps.sh" "$cvc5_build"
  msg "building libcvc5.a and libcvc5parser.a with $jobs jobs"
  (cd "$cvc5_build" && make -j "$jobs" cvc5 cvc5parser)
}

# --- link the wrapper ------------------------------------------------------
emcc_args=()

link_wrapper() {
  local libs=() lib
  # Order matters for static archives: cvc5 before its dependencies, and
  # libpolyxx before libpoly.
  for lib in libcvc5parser.a libcvc5.a; do
    libs+=("$(find "$cvc5_build/src" -name "$lib" | head -1)")
  done
  # LibPoly is built as libpicpoly*.a (static PIC), and its C++ wrapper needs
  # the C library after it.  Anything else --auto-download produced follows.
  for lib in libpolyxx.a libpicpolyxx.a libpoly.a libpicpoly.a \
             libcadical.a libgmpxx.a libgmp.a; do
    [ -f "$cvc5_build/deps/lib/$lib" ] && libs+=("$cvc5_build/deps/lib/$lib")
  done
  for lib in "$cvc5_build"/deps/lib/*.a; do
    case " ${libs[*]} " in *" $lib "*) ;; *) libs+=("$lib") ;; esac
  done

  emcc_args=(
    -O2 "$exception_flag"
    -sMODULARIZE=1 -sEXPORT_NAME=createCvc5
    -sENVIRONMENT=web,worker,node
    -sALLOW_MEMORY_GROWTH=1
    -sEXPORTED_FUNCTIONS=_cvc5_solve,_cvc5_reset,_cvc5_version,_malloc,_free
    -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,UTF8ToString,stringToUTF8,lengthBytesUTF8,HEAPU8
    -sINCOMING_MODULE_JS_API=locateFile,wasmBinary,instantiateWasm,print,printErr,onAbort
    --post-js "$repo_dir/src/post.js"
  )
  [ "$design" = 2 ] && emcc_args+=(-DCVC5_WASM_PERSISTENT_SOLVER)

  mkdir -p "$dist_dir"
  msg "linking dist/cvc5.js (design $design)"
  set -x
  em++ "${emcc_args[@]}" \
    -I "$cvc5_dir/include" -I "$cvc5_build/include" \
    "$repo_dir/src/cvc5_wasm.cpp" "${libs[@]}" \
    -o "$dist_dir/cvc5.js"
  set +x
}

# --- dist/ -----------------------------------------------------------------
write_metadata() {
  local emcc_version
  emcc_version=$(em++ --version | head -1)
  cat > "$dist_dir/VERSION.json" <<JSON
{
  "cvc5": "1.3.4",
  "cvc5_commit": "$CVC5_COMMIT",
  "emsdk": "$EMSDK_VERSION",
  "cvc5_wasm": "$(git -C "$repo_dir" describe --tags --always --dirty 2>/dev/null || echo unknown)",
  "built": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "design": $design,
  "patches": "$(cd "$repo_dir/patches" 2>/dev/null && echo *.patch)",
  "exceptions": "$exception_flag",
  "emcc": "$emcc_version",
  "flags": "em++ ${emcc_args[*]} <objects> -o cvc5.js"
}
JSON
  cp "$cvc5_dir/COPYING" "$dist_dir/LICENSE"
  cp "$repo_dir/README.dist.md" "$dist_dir/README.md"

  # Third-party licences, taken from what --auto-download actually pulled in.
  {
    echo "Third-party components linked into cvc5.wasm"
    echo "============================================"
    echo
    echo "cvc5 $CVC5_TAG ($CVC5_COMMIT) is BSD-3-Clause; see LICENSE."
    echo "The components below were fetched by cvc5's --auto-download and are"
    echo "statically linked into cvc5.wasm, with the sources named here.  Every"
    echo "licence file each one ships follows in full."
    echo
    local d name url
    for d in "$cvc5_build"/deps/src/*-EP; do
      [ -d "$d" ] || continue
      name=$(basename "$d"); name=${name%-EP}
      [ "$name" = Murxla ] && continue
      url=$(sed -n 's/^url(s)=//p' "$d-stamp/$name-EP-urlinfo.txt" 2>/dev/null | head -1)
      printf '  - %-8s %s\n' "$name" "$url"
    done
    for d in "$cvc5_build"/deps/src/*-EP; do
      [ -d "$d" ] || continue
      name=$(basename "$d"); name=${name%-EP}
      [ "$name" = Murxla ] && continue
      local f
      for f in "$d"/LICENSE* "$d"/LICENCE* "$d"/COPYING*; do
        [ -f "$f" ] || continue
        echo
        echo "--------------------------------------------------------------"
        echo "$name -- $(basename "$f")"
        echo "--------------------------------------------------------------"
        cat "$f"
      done
    done
  } > "$dist_dir/THIRD-PARTY-LICENSES"
}

report() {
  local raw gz
  raw=$(wc -c < "$dist_dir/cvc5.wasm")
  gz=$(gzip -9 -c "$dist_dir/cvc5.wasm" | wc -c)
  msg "dist/ contents:"
  ls -l "$dist_dir"
  msg "cvc5.wasm: $raw bytes raw, $gz bytes gzipped"
  msg "cvc5.js:   $(wc -c < "$dist_dir/cvc5.js") bytes"
}

install_emsdk
fetch_cvc5
apply_patches
build_cvc5
link_wrapper
write_metadata
report
msg "done"
