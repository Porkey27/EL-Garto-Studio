# El-Gato Studio — Linux and Windows

An unofficial app for Elgato capture cards, Facecams and the prompter, for **Linux and Windows**.
It reimplements Elgato Studio 2.0 on each OS's own device APIs:

* **Linux:** V4L2, hidraw, UVC extension-unit ioctls, PipeWire/ALSA, v4l2loopback
* **Windows:** SetupAPI, the HID API, DirectShow and Kernel Streaming (the same APIs Elgato Studio uses)

It contains no Elgato code or binaries. The device control protocol was worked out by analysing
the Windows app for interoperability and checked against USB captures; see
[docs/PROTOCOL.md](docs/PROTOCOL.md).

> **Status:**
> * **Game Capture 4K S on Windows:** discovery, preview, every settings read and every settings
>   write have been tested against a real card. `tools/write-test.js` changes each setting, reads it
>   back, then restores it. The EDID write path was tested by writing back the card's own EDID. The
>   bytes also match a USB capture of Elgato Studio.
> * **Linux:** builds and passes the same tests, plus a headless app start, but hasn't run on real
>   hardware yet.
> * **Cameras:** the Elgato camera extras are untested on hardware on both OSes.

## Install

### Windows

Requirements: Node.js 20+, Visual Studio 2022 or later (or Build Tools) with
"Desktop development with C++", and `ffmpeg` on `PATH` for the library and remuxing
(`winget install Gyan.FFmpeg`).

```bash
npm install
```

```bash
npm run build:native
```

```bash
npm start
```

Build an installer (`dist/*.exe`):

```bash
npm run dist:win
```

Quit Elgato Studio before using this app: both poll the capture card over the same HID channel,
and their requests interleave.

### Linux

Requirements: Node.js 20+, `ffmpeg`, `v4l-utils`, a C compiler and kernel headers (for the
helper). Optional: `v4l2loopback` for the virtual camera.

```bash
sudo apt install ffmpeg v4l-utils build-essential linux-libc-dev   # Debian/Ubuntu
```

```bash
npm install
```

```bash
npm run build:native
```

Let your user reach the devices without root:

```bash
sudo cp udev/60-el-gato-studio.rules /etc/udev/rules.d/ && sudo udevadm control --reload-rules && sudo udevadm trigger
```

```bash
npm start
```

Package as AppImage and .deb:

```bash
npm run dist:linux
```

Virtual microphone (optional): click **Virtual mic** under the preview, then pick
"El-Gato Virtual Microphone" as the input in Discord, OBS or a browser. It carries the audio the
app is using (the card's audio by default) and is removed when the app quits. It needs `pactl`
(`sudo apt install pulseaudio-utils`; on PipeWire systems `pipewire-pulse` must be running, which
it is by default on current distros).

Virtual camera (optional):

```bash
sudo modprobe v4l2loopback video_nr=10 card_label="El-Gato Virtual Camera" exclusive_caps=1
```

## Features

| Area | Feature | Linux | Windows |
|---|---|---|---|
| Live | Preview with resolution/frame-rate picker, fullscreen, framing grid | ✅ | ✅ |
| Live | Audio monitoring with volume, mute, level meters, audio source picker | ✅ | ✅ |
| Live | Recording to MP4/MKV/WebM, snapshots, Flashback replay buffer, multiview | ✅ | ✅ |
| Live | Recording options as in Studio: max resolution, max frame rate, quality with an MB/min estimate, codec (H.264/HEVC/AV1/VP9, whichever the system can encode) | ✅ | ✅ |
| Live | HDR recording: HDR inputs recorded as 10-bit HEVC Main 10 tagged HDR10/HLG (GPU encoder: AMD, NVIDIA or Intel, else x265), with an SDR preview while recording; SDR/HDR shown in the signal pop-up | — (planned) | ✅ tested (4K S, HDR source) |
| Live | Signal path pop-up (input → card → recording format, audio) and device details (rename, serial, firmware, USB speed) | ✅ | ✅ |
| Live | Virtual camera | ✅ v4l2loopback | — (use OBS Virtual Camera) |
| Live | Virtual microphone: the app's audio as "El-Gato Virtual Microphone" for Discord, OBS and browsers | ✅ PulseAudio/PipeWire (`pactl`) | — |
| Library | Thumbnails, playback, rename, show in folder, move to trash | ✅ | ✅ |
| Cameras | Standard controls: exposure, shutter, gain, white balance, focus, zoom/pan/tilt, picture, anti-flicker | ✅ | ✅ |
| Cameras | Elgato extras: vibrancy, tint, locks, metering, dynamic range, noise reduction, low light, status LED, "Save to camera" | ⚠️ unverified | ⚠️ unverified |
| Capture cards | Picture settings (brightness, contrast, hue, saturation) | ✅ | ✅ tested (4K S) |
| Capture cards | EDID source, colour range, audio input, line-in gain, video scaler, with Studio's "save settings" commit | ⚠️ capture-verified | ✅ tested (4K S) |
| Capture cards | EDID backup and custom EDID write (validated, read back chunk by chunk) | ⚠️ capture-verified | ✅ tested (4K S) |
| Capture cards | Custom EDID presets from Elgato's list (default, shared presets such as 1080p/1440p/Steam Deck/HDR, and card-specific ones such as Switch 2 VRR), checksum-verified; refuses to write while Elgato Studio is running | ⚠️ capture-verified | ✅ (4K S) |
| Capture cards | Firmware version, input signal (resolution/fps), USB 2.0 warning | ✅ | ✅ tested (4K S) |
| Prompter | Script library and editor, .txt/.md/.rtf/.docx import, prompter window, mirror mode, chat overlay, VoiceSync | ✅ | ✅ |
| Remote | Studio-compatible JSON-RPC WebSocket API (Stream Deck), tray, global shortcuts | ✅ | ✅ |
| App | Themes (Settings → Appearance): 7 presets, custom colours, background image with fit/darken/blur and see-through panels, corner roundness, UI size, import/export | ✅ | ✅ |

"Capture-verified" means the bytes the app sends match a USB capture of Elgato Studio doing the same
thing, but this app hasn't yet sent them to a card on that OS.

On the 4K S, **HDR tonemapping** is done in software by Elgato Studio; the card setting only
exists so other models can use it. Changing the **video scaler** restarts the card: it leaves
USB for about half a second. The app waits for it and the preview reconnects, but a recording in
progress stops.

### Not supported, and why

* **Game Capture 4K X device settings.** It uses a Realtek UB700E chip with its own framed protocol
  (`CRosRTD2801Protocol`) that hasn't been decoded yet. The command IDs are listed in
  `docs/PROTOCOL.md`. Preview and recording work because the card is standard UVC.
* **PCIe cards** (4K60 Pro, 4K60 Pro MK.2, 4K Pro, Cam Link Pro). There are no Linux drivers. On
  Windows they appear as ordinary video devices (preview and recording work), but their settings
  go through a separate PCIe driver interface this app doesn't implement.
* **Firmware updates for other models.** Only the Game Capture 4K S is supported (see below); the
  other models' update paths are researched in [docs/FIRMWARE.md](docs/FIRMWARE.md) but not built.

## Firmware updates (Game Capture 4K S)

**In the app:** when an update is available, the ⚙ (device details) button gets a red dot and a
message appears. Open device details and click **Update firmware…**. The dialog shows the
versions, runs both parts, and tells you when to unplug and replug the card. The preview pauses
during the update, and the app won't close until it finishes. **Reinstall…** reflashes the current
version.

The app and the command-line updater run the same code.

**Command line:** a command-line updater replays exactly what Elgato Studio sends. A test checks every report against
a USB capture of Studio updating a real 4K S. Both parts (MCU and Base) have been flashed with it on a
real 4K S on Windows, including resuming an MCU update that had stopped part-way.

```bash
npm run firmware
```

That's a dry run: it reads the card's versions, downloads and validates Elgato's files, and rehearses
the whole update on a simulated card. To update:

```bash
npm run firmware -- --write
```

* Quit Elgato Studio first, and leave only the card being updated connected, on a **USB 3** port.
  Elgato publishes no firmware for the card's USB 2.0 mode.
* The HDMI input can stay plugged in. The tool tells you when to unplug and replug the
  USB cable: once after the MCU part, once after the Base part.
* Safety checks:
  * MCU: the bootloader confirms its write pointer after every 240-byte chunk.
  * Base: the 256 KB image is read back and compared before it is marked valid.
  * A failure before that point leaves the old firmware in place, and the update can be rerun.
  * If an MCU update stops part-way, the card waits in its bootloader; running the tool again
    detects that and writes the MCU part again.
* Options: `--mcu-only`, `--base-only`, `--force`, `--mcu-file <path>`, `--base-file <path>`.

This is unofficial. If anything goes wrong, Elgato Studio on Windows can still update or recover
the card.
* **Elgato Prompter hardware controls** (the vendor HID brightness channel). The prompter works as
  an ordinary monitor.
* **Elgato-service extras:** Marketplace and purchases, Windows AI effects, Elgato telemetry,
  crash reporting and auto-update.

## Automatic builds (GitHub Actions)

`.github/workflows/build.yml` runs the tests, then builds these files, each including the native
helpers:

| File | What it is |
|---|---|
| `…-windows-setup.exe` | Windows installer |
| `…-windows-portable.zip` | Windows, unpacked: extract and run `El-Gato Studio.exe` |
| `…-linux.AppImage` | Linux, one file that runs on most distros (`chmod +x`, then run) |
| `…-linux-amd64.deb` | Debian/Ubuntu package (also installs the udev rule) |
| `…-linux-x64.tar.gz` | Linux, unpacked |

GitHub adds the source code (zip and tar.gz) to every release automatically. The AppImage and the
`.tar.gz` don't install the udev rule: see "Linux" above for the one-time `udev` command.

* **Every push to `main`:** the **Latest build** pre-release on the Releases page is replaced with
  fresh installers from that commit.
* **Pull requests:** the installers are attached to the run (Actions tab → the run → Artifacts).

To publish a permanent, numbered release, push a version tag:

```bash
git tag v0.1.0
```

```bash
git push origin v0.1.0
```

Bump `version` in `package.json` before tagging a new release. If the repository isn't
`github.com/Porkey27/EL-Garto-Studio`, update `homepage` in `package.json`, which the `.deb`
package uses.

## Development

```bash
npm test
```

The tests cover:
* device discovery: a fake sysfs tree on Linux, and real `egctl.exe` output on Windows
* descriptor parsing
* the camera and capture-card protocol encodings, including byte sequences replayed from a USB
  capture of Elgato Studio
* DirectShow control mapping
* the JSON-RPC server, script import and VoiceSync matching

`EGS_SMOKE_TEST=1 npm start` loads both windows, prints any renderer errors and exits.

To check the protocol against Elgato Studio on Windows (needs Wireshark and USBPcap):
`tools/capture-elgato.ps1` records the card's USB traffic; `tools/usbpcap_ctrl.py` and
`tools/decode_hid_i2c.py` turn the capture into a list of I2C register reads and writes.

Layout:

```
native/egctl.c           Linux helper (UVC XU ioctls, hidraw input/feature reports)
native/win/egctl.cpp     Windows helper (SetupAPI, HID API, DirectShow, Kernel Streaming)
src/main/platform/       OS backends (linux.js, win32.js) behind one interface
src/main/devices/        catalog, Linux discovery/descriptors/v4l2, camera and capture controllers
src/main/                app main process, recorder, library, settings, WebSocket server
src/renderer/            UI (live, device panel, library, prompter, chat, VoiceSync)
docs/                    recovered device protocol and firmware notes
tools/                   USB capture and decoding scripts
```
