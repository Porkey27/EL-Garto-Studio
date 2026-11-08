# Elgato device control protocol (recovered from Elgato Studio 2.0.0.3364)

Recovered by static analysis of `EGAVDeviceSupport.dll`, `RTICE_SDK_x64.dll` and
`RTK_IO_x64.dll` (Ghidra 12.2 decompilation) plus the managed assemblies (ILSpy).
Nothing here has been checked against live hardware yet. Entries marked **(verify)** are
inferred from the decompilation and are most likely to need a fix after a hardware test.

All multi-byte values are little-endian.

## 1. Cameras (Facecam family, Cam Link 4K rev3+) — UVC extension units

Windows reaches these through `KSPROPERTY_EXTENSION_UNIT`; on Linux, use
`UVCIOC_CTRL_QUERY` on the capture node. Unit IDs are not fixed: find the
`VC_EXTENSION_UNIT` descriptor whose `guidExtensionCode` matches, and use its `bUnitID`.

| Internal code | GUID | Used by |
|---|---|---|
| `0x2060000` (XU1) | `23E49ED0-1178-4F31-AE52-D2FB8A8D3001` | all "Elgato Webcam Base" cameras |
| `0x2070000` (XU2) | `2C49D16A-32B8-4485-3EA8-643A15236002` | all "Elgato Webcam Base" cameras |
| `0x1060000` | `23E49ED0-1178-4F31-AE52-D2FB8A8D3B48` | Facecam Neo, MK.2, MK.2 Rev.2 (legacy set) |
| `0x1060000` | `A8E5782B-36E6-4FA1-87F8-83E32B323124` | Facecam, Facecam Pro (legacy set) |

### XU1 selectors

| Sel | Name | Len | Notes |
|---|---|---|---|
| 0x01 | CAMERA_STATUS | 13 | read only |
| 0x02 | AE_METERING | 1 | 0 center-weighted, 1 average, 2 spot |
| 0x03 | AE_SPEED | 2 | |
| 0x04 | AE_LOCK | 1 | bool |
| 0x05 | AE_LOCK_DELAY | 2 | |
| 0x06 | AE_CURRENT_VALUE | 4 | read only |
| 0x07 | AE_TARGET_VALUE | 4 | read only |
| 0x08 | GAIN_VALUE | 4 | read only (live ISO) |
| 0x09 | GAIN_LIMIT | 4 | |
| 0x0a | EXPOSURE_TIME_ABSOLUTE | 4 | |
| 0x0b | EXPOSURE_TIME_VALUE | 4 | read only (live shutter) |
| 0x0c | EXPOSURE_PRIORITY | 4 | AE priority defaults |
| 0x0d | FOCUS_VALUE | 4 | read only |
| 0x0e | VIBRANCY | 2 | signed **(verify)** |
| 0x0f | AWB_LOCK | 1 | bool |
| 0x10 | AWB_LOCK_DELAY | 2 | |
| 0x11 | WB_TEMPERATURE_VALUE | 4 | read only |
| 0x12 | TINT | 2 | signed **(verify)** |
| 0x13 | TINT_VALUE | 4 | read only |
| 0x15 | HDR (dynamic range) | 1 | 0 standard, 1 wide, 2 high |
| 0x16 | NOISE_REDUCTION | 1 | 0 off, 1 on, 2 light, 3 medium, 4 high |
| 0x17 | DIGITAL_WINDOW | 12 | framing rectangle **(verify layout)** |
| 0x18 | PANTILT_ABSOLUTE | 8 | int32 pan, int32 tilt |
| 0x19 | AF_METERING | 1 | 0 center, 1 spot, 2 average |
| 0x1a | AF_LOCK | 1 | bool |
| 0x1b | AF_LOCK_DELAY | 2 | |
| 0x1c | AF_CURRENT_VALUE | 4 | read only |
| 0x1d | AF_TARGET_VALUE | 4 | read only |
| 0x1e | ONE_TIME_AUTO | 4 | write only |
| 0x1f | INFO | 121 | read only |

### XU2 selectors

| Sel | Name | Len | Notes |
|---|---|---|---|
| 0x01 | FEATURES | 100 | capability bitmap, read only |
| 0x02 | VIDEOMODES | 65 or 129 | codec/mode table (vertical, Switch 2, …) |
| 0x03 | NOISE_REDUCTION_2D | 1 | |
| 0x04 | LED_CONTROL | 10 | `[ff, 00, which(2=streaming,3=idle), 00, 00, brightness 0-255, 0,0,0,0]` **(verify)** |
| 0x06 | USER_PROFILE_LOAD | 1 | slot |
| 0x07 | USER_PROFILE_SAVE | 1 | slot ("Save to camera") |
| 0x09 | USER_PROFILE_CLEAR | 1 | slot |
| 0x0a | MUTE | 1 | |
| 0x0b | USB_TRANSFER_MODE | 1 | |
| 0x0d | UVC_INDEX | ? | |
| 0x0e | POWER_LINE_FREQUENCY | 1 | |
| 0x0f | POWER_LINE_FREQUENCY_MODE | 1 | |
| 0x10 | REBOOT | ? | write only |
| 0x14 | NOISE_REDUCTION_3D | 1 | |
| 0x1d | BINNING (low-light mode) | 2 | |
| 0x1f | INFO | 121 | read only |

### Legacy Facecam/Facecam Pro selectors (`A8E5782B…` unit)

| Sel (Facecam) | Sel (Facecam Pro) | Name |
|---|---|---|
| 0x08 | 0x02 | EXPOSURE_METERING |
| 0x14 | 0x0f | EXPOSURE_TIME (Facecam: 100 µs units, Pro: 50 µs units) |
| 0x15 | – | AUTO_EXPOSURE_SPEED (%) |
| 0x19 | – | AUTO_EXPOSURE_LOCK |
| 0x12 | – | NOISE_REDUCTION |
| 0x13 | – | SERVICE_MODE (do not touch) |

Lengths aren't fixed in the code. Query them at runtime with `UVC_GET_LEN`.

Everything else (brightness, contrast, saturation, sharpness, white balance, focus,
zoom, pan, tilt, exposure, gain, power-line frequency) uses the standard UVC camera and
processing unit controls, which Linux exposes as ordinary V4L2 controls.

## 2. USB capture cards (HD60 S+, HD60 X, Neo, 4K S, Cam Link family) — I2C over HID

The control channel is a vendor HID interface (`hidInterfaceNumber` in the device
table: 2 on older models, 7 on newer). Windows uses `HidD_SetOutputReport` and
`HidD_GetInputReport`. On Linux, write `[reportId, payload…]` to `/dev/hidrawN`,
zero-padded to the output report size, and read with `HIDIOCGINPUT`.

Two framings exist, chosen by device generation:

* **Legacy** (HD60 S+, Cam Link, Cam Link 4K rev1):
  * write: report `0x0B`, payload `[addr, reg, len, data…]`
  * read: report `0x09`, payload `[addr, reg, len]`; then input report `0x0A` (36 bytes) holds
    the data at offset 0 **(verify: offset after report id)**
* **New** (HD60 X/X Rev.2, Neo, 4K S, Cam Link 4K rev3/rev4/MK.2):
  * write: report `0x06`, payload `[len+5, 0x06, addr, len+1, reg, data…]`
  * read: report `0x06`, payload `[0x06, 0x07, addr, 0x01, reg, len]`; then input report `0x05`,
    whose data starts at offset 1

**Tested on hardware** (Game Capture 4K S on Windows, 2026-11-08, `tools/write-test.js`): every
register in the table below that the app writes, plus the EDID EEPROM, changed, read back and
restored correctly. Reads must request exactly 2047 bytes on input report 5: the card stalls a
GET_REPORT longer than its reply buffer, for example the 4097-byte maximum Windows reports.

A capture of this app's own write test (`captures/app-writes-*.pcap`) matched Studio's capture byte
for byte: all 81 requests both apps sent were identical, including `wLength`. That capture also
showed two more things:

* After the card restarts, any save commit (`0x13`) queued before the restart is lost. The app now
  commits only once the card answers again.
* The 4K S has a UVC **extension unit 3** on interface 0, with selectors 1–24. Selector 1 is
  4,100 bytes and selector 3 is 256 bytes. Windows' UVC driver probes it on every enumeration.
  Neither Studio nor this app uses it for the settings above.

**Verified by USB capture** (Studio driving a Game Capture 4K S, 2026-11-08; tools in
`tools/capture-elgato.ps1`, `tools/usbpcap_ctrl.py`, `tools/decode_hid_i2c.py`). The new framing
is exact. Output reports are 255 bytes plus the report ID, sent as `SET_REPORT` on interface 7.
Reads are `GET_REPORT` input `0x05`, and the reply on the wire is `[status 00, data…]`. Example
writes: EDID mode → display `06 | 06 06 55 02 12 01`; read audio input `06 | 06 07 55 01 08 01`.
The capture also showed:

* **Save settings:** about 1 s after every change, Studio writes `01` to register `0x13`, and once
  after an EDID write. Without it, changes are not kept across a power cycle.
* **Polling:** every ~0.74 s Studio reads `0x00`, `0x09`, `0x14`, `0x1c`, `0x2d` and I2C `0x60`/`0x00`
  (VRR frame rate), and every ~5 s it reads `0x08 0x0b 0x19 0x0d 0x12 0x0a`.
* **HDR tonemapping toggle:** on the 4K S it caused no device write. Studio tonemaps in software
  on the PC (confirmed by the user); it only sets register `0x0a` to 1 once at startup.
* **EDID preset swap:** selecting another EDID preset rewrites the whole 256-byte EEPROM at `0xA0`
  (bank select, then 32 × 8-byte chunk writes, each followed by an 8-byte read-back), then one
  save-settings write.

Main I2C address `0x55` registers:

| Reg | R/W | Meaning |
|---|---|---|
| 0x00 | R (8 bytes) | signal: `[?, width u16le, height u16le, fps, ?, ?]`, all zero without signal (4K S: `00 80 07 38 04 3c 56 00` = 1920×1080@60) |
| 0x01 | R/W | USB pipe mode |
| 0x02 | R | firmware version. New devices: Base then MCU as decimal `YY MM DD` bytes (4K S: `1a 08 19 1a 09 07` = Base 26.08.25, MCU 26.09.07) |
| 0x13 | W | save settings: write `01` (see above) |
| 0x05 | W | firmware update control |
| 0x08 | R/W | audio input: 0 HDMI, 1 analog |
| 0x09 | R | HDMI HDR info-frame packet |
| 0x0a | R/W | HDR tonemapping 0/1 |
| 0x0b | R/W | colour range: 0 bypass, 1 expand, 2 shrink (HD60 S+ swaps 1 and 2) |
| 0x0d | R/W | line-in gain (new devices) — min 0x20, default 0x80, max 0xB0 |
| 0x0e | R/W | line-in gain (legacy devices); source product description (new) |
| 0x12 | R/W | EDID mode: 0 internal, 1 display (pass-through), 2 mix |
| 0x14 | R | HDMI source product description |
| 0x19 | R/W | video scaler enabled. **Writing it restarts the card** (4K S: leaves USB about 1.1 s after the write, back about 0.6 s later, value kept) |
| 0x1c | R | USB generation |
| 0x2d | R | pass-through monitor connected |
| 0x2e | R | charging power |

Other I2C addresses:

* `0xAA` reg `0x03` ← `12 34 69 01`: select the EDID bank before EDID access (new devices; magic
  `12 34`, command `0x69`, bank 1). **Verified by capture.** Earlier notes said this payload was a
  single bank byte, which was wrong.
* `0x50`/`0x51` (legacy; `0x51` on HD60 S+) or `0xA0` (new): EDID EEPROM. Read and write 8 bytes
  at a time, with `reg = offset` for offsets below 256. For offsets 256–511,
  `reg = (offset & 0xff) + 1` (copied as found in the original code). Wait 10 ms after each write
  chunk and read it back to check.
* `0x60` reg `0x00`: VRR frame rate.
* `0x66` reg `0xAA`: recording LED.

The picture settings (brightness, contrast, hue, saturation) are the standard UVC processing
unit controls.

## 3. Game Capture 4K X — Realtek UB700E "AT" commands

The 4K X uses Realtek's RTICE SDK. Each feature is an AT command ID, sent through
`rtk_sendATCommand(id, in, out, inLen)`. The transport (`CRosRTD2801Protocol`) wraps it in a
UVC extension unit frame with an LRC checksum. The **framing has not been decoded yet**;
the IDs are below:

| ID | Command | In len |
|---|---|---|
| 0x1f | HDR2SDR on/off | 1 |
| 0x1d / 0x1e | UVC HDR P010 / NV12 on/off | 1 |
| 0x4d / 0x4e | EDID mode set/get (0 internal, 1 display, 4 mix) | 4 |
| 0x54 / 0x55 / 0x56 | EDID flash get table / set default / get default | 4/1/0 |
| 0x7c | set colour range (`[1, 0=bypass/3=expand/4=shrink]`) | 2 |
| 0x84 / 0x85 | LED light set/get | 4 |
| 0x8d / 0x8e | USB force speed get/set | 0/8 |
| 0x90 | HDR2SDR status | 0 |
| 0x9b / 0x9c | HDR2SDR colour params get/set | 0/7 |
| 0x10 / 0x11 | UAC volume set/get | 4 |
| 0x34 / 0x35 | input source switch/get | 1 |
| 0x38 | HDMI RX video stable | 0 |
| 0x37 | HDMI RX raw timing | 0 |
| 0x65 | HDR metadata | 0 |
| 0x25 | reboot | 0 |

## 4. Studio WebSocket API (Stream Deck integration)

JSON-RPC 2.0 over WebSocket on `127.0.0.1:<dynamic port>`. The port is written to
`<appdata>/ws-info.json` as `{"port": N}` (on Linux:
`~/.config/elgato-studio-linux/ws-info.json`). Methods: `getApplicationInfo`,
`getRecordingInformation`, `setIsRecording`, `takeSnapshot`,
`getLastRecordingItemInformation`, `openStorageLocation`, `getSignalInformation`,
`getPreviewInformation`, `setPreviewInformation`, `getDevices`, `getSupportedProperties`,
`getSupportedActions`, `getProperty`, `setProperty`, `resetProperty`, `resetCategory`,
`invokeAction`, `setSubscription`. Notifications: `recordingInformationChanged`,
`previewInformationChanged`, `signalInformationChanged`,
`lastRecordingItemInformationChanged`, `propertyChanged`, `supportedPropertiesChanged`,
`supportedActionsChanged`, `devicesChanged`. Error `-32001` means invalid state.
