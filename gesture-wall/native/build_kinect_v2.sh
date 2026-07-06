#!/usr/bin/env bash
# =============================================================================
# build_kinect_v2.sh -- compile the Gesture Wall Kinect v2 bridge (macOS)
# =============================================================================
#
# Builds native/kinect_v2_bridge.cc into bin/kinect-v2-bridge, which
# gesturewall/kinect.py (KinectV2Source) spawns as a subprocess.
#
# REQUIRES libfreenect2 installed + a physical Kinect v2. This script CANNOT
# succeed in the gesture-wall dev environment (no libfreenect2, no hardware).
# See the header of native/kinect_v2_bridge.cc and KINECT.md for the full
# macOS prerequisites. In short:
#
#   xcode-select --install
#   brew install git cmake pkg-config libusb glfw3 jpeg-turbo
#   git clone https://github.com/OpenKinect/libfreenect2.git
#   cd libfreenect2 && mkdir build && cd build
#   cmake .. -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$HOME/.local"
#   cmake --build . -j"$(sysctl -n hw.ncpu)" && cmake --install .
#   export PKG_CONFIG_PATH="$HOME/.local/lib/pkgconfig:$PKG_CONFIG_PATH"
#   export DYLD_LIBRARY_PATH="$HOME/.local/lib:$DYLD_LIBRARY_PATH"
#
# Usage:
#   native/build_kinect_v2.sh
# =============================================================================

set -euo pipefail

# Resolve repo root from this script's location so it works from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

SRC="${SCRIPT_DIR}/kinect_v2_bridge.cc"
OUT_DIR="${ROOT_DIR}/bin"
OUT="${OUT_DIR}/kinect-v2-bridge"

if ! command -v pkg-config >/dev/null 2>&1; then
  echo "error: pkg-config not found. brew install pkg-config" >&2
  exit 1
fi

if ! pkg-config --exists freenect2; then
  echo "error: pkg-config cannot find 'freenect2'." >&2
  echo "       Build/install libfreenect2 and export PKG_CONFIG_PATH, e.g.:" >&2
  echo '       export PKG_CONFIG_PATH="$HOME/.local/lib/pkgconfig:$PKG_CONFIG_PATH"' >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"

# shellcheck disable=SC2046  # we want word-splitting on the pkg-config output
clang++ -std=c++17 -O2 -Wall \
  "${SRC}" \
  -o "${OUT}" \
  $(pkg-config --cflags --libs freenect2)

echo "Built ${OUT}"
