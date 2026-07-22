// =============================================================================
// kinect_v2_bridge.cc  --  Gesture Wall Kinect v2 depth bridge (macOS)
// =============================================================================
//
// Opens the default Kinect v2 (Xbox One sensor) via libfreenect2, captures
// Color + Depth, and uses libfreenect2::Registration::apply to produce a
// 512x424 REGISTERED color image and an UNDISTORTED depth image that are
// pixel-for-pixel ALIGNED (depth pixel (px,py) and color pixel (px,py) look at
// the same point in the scene). It emits these to stdout using a tiny binary
// protocol that gesturewall/kinect.py (KinectV2Source / parse_frames) parses.
//
// There is NO Microsoft skeleton / body-tracking SDK on macOS; libfreenect2
// gives only registered color + undistorted depth + the IR camera intrinsics.
// Pose is recovered downstream by running MediaPipe on the registered color and
// reading depth from the aligned map (see gesturewall/depth.py).
//
// -----------------------------------------------------------------------------
// STDOUT BINARY PROTOCOL  (all multi-byte integers/floats little-endian, LE)
// -----------------------------------------------------------------------------
//   ONCE, before any frame -- intrinsics control frame:
//     magic   : 4 bytes ASCII  "K2IN"
//     fx      : float32 LE      (IR camera params, for the 512x424 frame)
//     fy      : float32 LE
//     cx      : float32 LE
//     cy      : float32 LE
//     width   : uint32  LE      (always 512)
//     height  : uint32  LE      (always 424)
//
//   PER FRAME -- registered color + undistorted depth:
//     magic   : 4 bytes ASCII  "K2RG"
//     timestamp : uint32 LE     (frame sequence/time counter)
//     width     : uint32 LE     (512)
//     height    : uint32 LE     (424)
//     color   : 512*424*3 bytes uint8   BGR  (registered color)
//     depth   : 512*424   float32 LE    depth in MILLIMETERS (libfreenect2 native)
//
// IMPORTANT: stdout carries raw binary frames. ALL logging goes to stderr.
// The Python side converts depth mm -> metres at its boundary; this bridge
// emits the native libfreenect2 millimetres unchanged.
//
// -----------------------------------------------------------------------------
// macOS BUILD PREREQUISITES  (from the libfreenect2 reference playbook)
// -----------------------------------------------------------------------------
// Kinect v2 needs a real USB 3.0 path + the Xbox One Kinect Adapter (power +
// USB 3.0). Avoid passive/cheap hubs and VMs (USB 3.0 isochronous transfer is
// delicate). Then:
//
//   1. Xcode command-line tools:
//        xcode-select --install
//   2. Homebrew (https://brew.sh) if not present, then build dependencies:
//        brew update
//        brew install git cmake pkg-config libusb glfw3 jpeg-turbo
//   3. Build + install libfreenect2 from source:
//        git clone https://github.com/OpenKinect/libfreenect2.git
//        cd libfreenect2 && mkdir build && cd build
//        cmake .. -DCMAKE_BUILD_TYPE=Release \
//                 -DCMAKE_INSTALL_PREFIX="$HOME/.local"
//        cmake --build . -j"$(sysctl -n hw.ncpu)"
//        cmake --install .
//   4. Make pkg-config + the dynamic loader find it (add to your shell rc):
//        export PKG_CONFIG_PATH="$HOME/.local/lib/pkgconfig:$PKG_CONFIG_PATH"
//        export DYLD_LIBRARY_PATH="$HOME/.local/lib:$DYLD_LIBRARY_PATH"
//   5. Verify the sensor first:
//        ./bin/Protonect            # upstream test viewer
//        # USB troubleshooting:  LIBUSB_DEBUG=3 ./bin/Protonect
//   6. Keep architecture consistent on Apple Silicon (do not mix arm64 brew libs
//      with an x86_64/Rosetta toolchain).
//
// Build THIS bridge with native/build_kinect_v2.sh (uses pkg-config freenect2).
//
// NOTE: This file CANNOT be compiled or tested in the gesture-wall dev
// environment -- it requires libfreenect2 installed AND the physical Kinect v2
// hardware. It is built + run only on the deployment Mac. See KINECT.md.
// =============================================================================

#include <atomic>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <string>

#include <libfreenect2/libfreenect2.hpp>
#include <libfreenect2/frame_listener_impl.h>
#include <libfreenect2/registration.h>
#include <libfreenect2/packet_pipeline.h>
#include <libfreenect2/logger.h>

// The registered/undistorted frames are always this size on Kinect v2.
static constexpr uint32_t kWidth = 512;
static constexpr uint32_t kHeight = 424;

static std::atomic<bool> g_running{true};

static void handle_signal(int) {
  g_running.store(false);
}

// ---- little-endian writers -------------------------------------------------

static void write_u32_le(uint32_t value) {
  unsigned char b[4];
  b[0] = static_cast<unsigned char>(value & 0xff);
  b[1] = static_cast<unsigned char>((value >> 8) & 0xff);
  b[2] = static_cast<unsigned char>((value >> 16) & 0xff);
  b[3] = static_cast<unsigned char>((value >> 24) & 0xff);
  std::fwrite(b, 1, 4, stdout);
}

static void write_f32_le(float value) {
  // Reinterpret the float's bits as a uint32 and emit little-endian. This is
  // correct regardless of host endianness.
  uint32_t bits;
  std::memcpy(&bits, &value, sizeof(bits));
  write_u32_le(bits);
}

// ---- intrinsics control frame ("K2IN") -------------------------------------

static void write_intrinsics(const libfreenect2::Freenect2Device::IrCameraParams& ir) {
  std::fwrite("K2IN", 1, 4, stdout);
  write_f32_le(ir.fx);
  write_f32_le(ir.fy);
  write_f32_le(ir.cx);
  write_f32_le(ir.cy);
  write_u32_le(kWidth);
  write_u32_le(kHeight);
  std::fflush(stdout);
}

// ---- per-frame registered color + depth ("K2RG") ---------------------------

static void write_frame(uint32_t timestamp,
                        const libfreenect2::Frame* registered,
                        const libfreenect2::Frame* undistorted) {
  // registered: BGRX (4 bytes/pixel) per libfreenect2; we emit BGR (3 bytes).
  // undistorted: float32 depth in millimetres, kWidth*kHeight.
  std::fwrite("K2RG", 1, 4, stdout);
  write_u32_le(timestamp);
  write_u32_le(kWidth);
  write_u32_le(kHeight);

  // Registered color: pack BGRX -> BGR (drop the 4th byte) row by row.
  const size_t pixel_count = static_cast<size_t>(kWidth) * kHeight;
  const unsigned char* src = registered->data;  // 4 bytes per pixel (BGRX)
  // Stream pixel-by-pixel into a small stack buffer to avoid a large heap alloc.
  unsigned char bgr[3];
  for (size_t i = 0; i < pixel_count; ++i) {
    const unsigned char* p = src + i * 4;
    bgr[0] = p[0];  // B
    bgr[1] = p[1];  // G
    bgr[2] = p[2];  // R
    std::fwrite(bgr, 1, 3, stdout);
  }

  // Undistorted depth: float32 millimetres, kWidth*kHeight. libfreenect2 frames
  // are little-endian float on the supported (LE) platforms; emit as-is.
  std::fwrite(undistorted->data, sizeof(float), pixel_count, stdout);
  std::fflush(stdout);
}

int main(int argc, char** argv) {
  std::signal(SIGINT, handle_signal);
  std::signal(SIGTERM, handle_signal);

  // libfreenect2 logs to stderr by its default logger; keep stdout clean.
  libfreenect2::setGlobalLogger(libfreenect2::createConsoleLogger(
      libfreenect2::Logger::Warning));

  libfreenect2::Freenect2 freenect2;

  if (freenect2.enumerateDevices() == 0) {
    std::cerr << "[kinect-v2-bridge] No Kinect v2 device found.\n";
    return 1;
  }

  // CPU pipeline: slower than OpenGL/OpenCL but maximally portable and avoids
  // GPU/OpenGL setup issues on macOS. Registration itself is CPU regardless.
  libfreenect2::PacketPipeline* pipeline =
      new libfreenect2::CpuPacketPipeline();

  // Optional device argument. A SHORT all-digit value is a device INDEX (e.g.
  // "0", "1"); a LONG all-digit value is a 12-digit Kinect SERIAL number; any
  // non-digit is also a serial; no argument uses the default device. The length
  // guard keeps std::stoi from overflowing on a 12-digit serial, and lets us
  // pin each camera to a stable serial (device indices swap between runs).
  std::string arg = (argc >= 2) ? argv[1] : "";
  bool numeric = !arg.empty() && arg.size() <= 4;
  for (char c : arg) {
    if (c < '0' || c > '9') { numeric = false; break; }
  }

  libfreenect2::Freenect2Device* dev = nullptr;
  std::string which;
  if (numeric) {
    which = "index " + arg;
    dev = freenect2.openDevice(std::stoi(arg), pipeline);
  } else {
    std::string serial =
        arg.empty() ? freenect2.getDefaultDeviceSerialNumber() : arg;
    which = "serial " + serial;
    dev = freenect2.openDevice(serial, pipeline);
  }
  if (dev == nullptr) {
    std::cerr << "[kinect-v2-bridge] Could not open Kinect v2 device ("
              << which << ").\n";
    return 2;
  }

  // We need both color (for registration) and IR/depth.
  libfreenect2::SyncMultiFrameListener listener(
      libfreenect2::Frame::Color |
      libfreenect2::Frame::Depth);
  dev->setColorFrameListener(&listener);
  dev->setIrAndDepthFrameListener(&listener);

  if (!dev->start()) {
    std::cerr << "[kinect-v2-bridge] Could not start Kinect v2 device.\n";
    dev->close();
    return 3;
  }

  std::cerr << "[kinect-v2-bridge] Started. serial=" << dev->getSerialNumber()
            << " firmware=" << dev->getFirmwareVersion() << "\n";

  // Registration maps the color frame onto the depth frame, producing a 512x424
  // undistorted depth image and a 512x424 registered color image that are
  // pixel-aligned. IR params are the pinhole intrinsics for that 512x424 frame.
  const libfreenect2::Freenect2Device::IrCameraParams ir =
      dev->getIrCameraParams();
  libfreenect2::Registration registration(ir, dev->getColorCameraParams());

  // Emit the intrinsics control frame ONCE up front.
  write_intrinsics(ir);

  // Output frames for Registration::apply (sized internally by libfreenect2).
  libfreenect2::Frame undistorted(kWidth, kHeight, 4);  // float32 depth (mm)
  libfreenect2::Frame registered(kWidth, kHeight, 4);   // BGRX color

  uint32_t frame_counter = 0;

  while (g_running.load()) {
    libfreenect2::FrameMap frames;
    // Wait up to 1s for a synchronized (color + depth) frame set.
    if (!listener.waitForNewFrame(frames, 1000)) {
      std::cerr << "[kinect-v2-bridge] Timed out waiting for a frame.\n";
      continue;
    }

    libfreenect2::Frame* color = frames[libfreenect2::Frame::Color];
    libfreenect2::Frame* depth = frames[libfreenect2::Frame::Depth];

    if (color != nullptr && depth != nullptr) {
      // Produce pixel-aligned 512x424 registered color + undistorted depth.
      registration.apply(color, depth, &undistorted, &registered);
      write_frame(frame_counter++, &registered, &undistorted);
    }

    listener.release(frames);
  }

  std::cerr << "[kinect-v2-bridge] Stopping.\n";
  dev->stop();
  dev->close();
  return 0;
}
