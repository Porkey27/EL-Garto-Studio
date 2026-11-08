# How Elgato Studio updates device firmware (research notes)

**Research only. None of this is implemented in the app.** Recovered from Elgato Studio
2.0.0.3364 (`EGAVDeviceSupport.dll` via Ghidra; `Elgato.BaseClasses.*` via ILSpy). Nothing here has
been run against a device. Byte layouts marked **(partial)** were read from decompiler output and
still have gaps. A mistake while flashing can leave a device unbootable.

## 1. Finding and downloading firmware

Firmware is **not** shipped with the app; it is downloaded on demand.

1. **Manifest:** `GET https://gc-updates.elgato.com/windows/estw-update/<channel>/device-update-check.json.php`
   with query `osName=Windows&osVersion=…&osPlatform=x64&appVersion=…&appPlatform=x64&appLanguage=…`.
   `<channel>` is `final` (stable), `beta`, or an alpha keyword read from
   `HKCU\SOFTWARE\Elgato\AlphaUpdateKeyword` (default `alpha`). The response is cached for 1 h in
   `<tmp>/device-asset-manifest.json`.
2. **Manifest shape:** `{ appDevices: [...], hardwareDevices: [ { name, category, id: { type, vendorId,
   productId }, drivers: [...], firmware: [ FirmwareDetails ] } ] }`. Each `FirmwareDetails` has: `type`
   (`MCU`, `Base`, `FPGA`, …), `version`, `versionNumber`, `versionFormat`, `filename`, `downloadUrl`,
   `releaseNotesUrl`, `importance`, `updateDurationSec`, `updateOrder`, `postAction`,
   `mustDisconnectHDMI`, `mustStopStreaming`, `minimumFirmwareVersion`, `maximumFirmwareVersion`,
   `minimumDriverVersion`, `platform`, `minimumOS`/`maximumOS`.
3. **Files** live under `…/egc/es_content/assets/<Product>/firmware/FW_<Product>_<TYPE>_<version>.bin`.
   The download is checked against a SHA-256 (log string "Downloaded asset failed SHA-256 validation").
4. **Order:** components are flashed in ascending `updateOrder` (for example HD60 X: MCU first, then
   Base). `postAction` is 0 = cold reboot (USB-powered), 1 = cold reboot (USB), 2 = cold reboot (PCI).

Fetched on 2026-11-08 from the `final` channel: 50 hardware entries, for example:

| Device | USB ID | Components (version) |
|---|---|---|
| HD60 S+ | 0fd9:006a | FPGA 67, MCU 22.03.09 |
| HD60 X | 0fd9:0082 | MCU 22.04.08, Base 22.04.26 |
| HD60 X Rev.2 | 0fd9:008a | MCU 25.06.27, Base 25.07.16 |
| Game Capture Neo | 0fd9:008c | MCU 26.03.26, Base 26.03.27 |
| 4K X | 0fd9:009b/009c | MCU 25.02.10 (Rev3 image 25.08.15) |
| 4K S | 0fd9:00af | MCU 26.09.07, Base 26.08.25 |
| Cam Link 4K | 0fd9:0066 / 00a1 | FPGA 67 + MCU 20.02.19 / Base+MCU 24.05.09 |
| Facecam / Pro / Neo / MK.2 / 4K | 0078 / 0079 / 0081 / 0093-94 / 0091-92 | Base 4.09 / 0.6.1785 / 1.79.162 / 2.0.350 / 2.49.0000 |

Native firmware type IDs (`EGAVDSFirmwareType`): 0 Base, 1 MCU, 2 FPGA, 3 Kernel, 4 ISP, 5 IQ, 6 PD,
7 LD, 8 AP1, 9 AP2.

Shared safety checks: refuse while the device is streaming or recording (`DoNotUpdateWhileStreaming`);
some updates require HDMI to be unplugged (`mustDisconnectHDMI`); while updating, every other
settings call returns "Blocked due to firmware update"; after a reboot the app waits for the device
to re-enumerate (`updateReappearanceIntervalSec`).

## 2. USB capture cards: legacy generation (Cam Link, Cam Link 4K rev1, HD60 S+)

`CCamLinkSupport::DoFirmwareUpdate` → `FirmwareUpdatePD570`. It uses the vendor HID interface
(the same channel as the settings in PROTOCOL.md §2). "Write report N" means an output report
(`HidD_SetOutputReport`); "feature N" means `HidD_SetFeature`.

1. **Enter flash mode:** feature report `0x01`, data `[0x01]`.
2. **Erase:** the image region is split into 64 KB sectors: `count = (size [+0x100 for FPGA]) >> 16
   + 1`. The start sector is 0 for MCU and 4 (address `0x40000`) for FPGA. For each sector, write
   report `0x05` with `[sector]`, sleep 100 ms, then poll input report `0x06` until its first byte is 0
   (up to 50 polls, 100 ms apart).
3. **FPGA only:** the FPGA image must start with `FF 00`. First write report `0x04` (260-byte buffer):
   `[0x04, 0x00, 0x00, 0x08, size:u32le, ~size:u32le, 0…]`, a size header at page `0x0400`. Data
   then starts at page `0x0401`.
4. **Data:** 256-byte pages via write report `0x04`, buffer `[page_hi, page_lo, len_hi, len_lo,
   data[256]]`. The page counter starts at 0 for MCU and increments per page.
5. **Exit flash mode:** feature `0x01`, data `[0x00]`.
6. **Reset:** write report `0x12`, data `[0x13]`.
7. Afterwards the version string is written to I2C `0x55` register `0x05` (4 bytes) **(partial)**.

## 3. USB capture cards: new generation (HD60 X, Neo, 4K S, Cam Link 4K rev3/rev4/MK.2)

`DoFirmwareUpdate` loads the image into a `PD575FirmwareUpdate` helper, then:

### MCU (type 1): `FirmwareUpdateMCU` → `UpdateAPROM`
This is a Nuvoton-style ISP flow over I2C. MCU commands go to I2C address **0x66**, register
**0xAA**; the payload starts with the magic `12 34` followed by a command byte.
* Read the MCU version: `[12 34 58]` → 3 bytes back. The version must be in range (major 0x14–0x28).
* `Jump2LDROM` (switch to the bootloader), `CheckLDROMIdle`, "Erase All", then `UpdateOnePage` per page
  with a checksum check ("page ok" / "checksum fail"), then "Run APROM" to boot the new image.
  The real byte sequence is in the captured table below. Bootloader commands go to I2C `0x6C`;
  each page is 240 bytes. **(The per-page checksum and the exact meaning of `a2`/`a3`/`a4`/`ac`
  are still inferred.)**

### Base (type 0): `FirmwareUpdateBase`
* The image must be at least `0x180014` bytes. The big-endian u32 at `0x18000C` is the header length
  and the one at `0x180010` is the boot size. The amount written is (header + boot) rounded up to
  64 KB.
* Flash access over HID:
  * write report `0x04`, `[0x07, 0x03, mode, addr:u32le]`: set access mode and address
    (`REPORT_FLASH_ACCESS_MODE`);
  * write report `0x04`, `[0x06, 0x05, len:u32le]`: set length (`REPORT_FLASH_SET_LEN`);
  * write report `0x03`, `[0, 0, 0, data…]` in 4 KB chunks (`BURST_FLASH_WRITE`);
  * read input report `0x01` (`BURST_FLASH_READ`).
* Sequence:
  1. Read the 4 KB config page at `0x70000` (cmd `0x11`, mode 2), set byte 0 to `0`, write it back
     (cmd `0x10`). This marks "update in progress".
  2. Burst-write the image at `0x180000` (cmd `0x13`, mode 0, then data).
  3. Burst-read it back and compare.
  4. Set config-page byte 0 back to `1`.
  5. Write two "customised" sections from a built-in table (burst mode 3).
  6. Ask the user to replug.

### Verified: a real 4K S update captured from Elgato Studio (2026-11-08)

The card (0fd9:00af) went from Base 25.07.23 / MCU 25.12.03 to Base 26.08.25 / MCU
26.09.07. It took two runs, both recorded with USBPcap
(`captures/fw-update-4ks-*.pcap`, decode with `tools/usbpcap_ctrl.py`).

**Run 1, MCU (succeeded).** Everything went over the I2C-over-HID channel (report 6 out, report 5
in); none of the flash reports 3/4/1 were used:

| t (s) | I2C transaction | Meaning |
|---|---|---|
| 36.4 | W `66`/`ab` ← `03 12 34 58` | ask the MCU for its version (`12 34` magic, command `0x58`) |
| 36.5 | W `66`/`aa` ← `03 0d 12 04 86 54 06 aa` | jump to the bootloader (LDROM); the MCU then answers on I2C **0x6C** |
| 37.7 | W `6c`/`ac`, W `6c`/`a2` | bootloader handshake |
| 67.9 | W `6c`/`a3` | erase (Studio waited ~30 s before this) |
| 67.9–72.6 | 300 × W `6c`/`ae` ← 240 bytes | program APROM (72,000 bytes of ARM Thumb code) |
| 72.6 | R `6c`/`01`, `6c`/`03`; W `6c`/`a4`, `6c`/`ac`; R `6c`/`01` = `01` | verify, then run the new APROM |
| 76.8 | card re-enumerates by itself; version reads show MCU 26.09.07 | |

After each `0x6C` write, Studio reads input report 5 with `wLength` **1791** (not 2047).

Studio then asked for a replug before the Base update and polled the version for ~66 s. No replug
happened on that port in time, so it gave up. **The Base firmware was never touched**, and the card
kept working on the old Base.

**Run 2, Base (succeeded after a replug).** Flash-access reports, exactly as decompiled above:

| t (s) | Transfer | Meaning |
|---|---|---|
| 17.75 | rpt4 `07 03 02 00000700`, rpt4 `06 05 00100000`; read rpt1 4096 B | read config page `0x70000` (byte 0 = `01`, valid) |
| 17.78 | same address/length; rpt3 4100 B (`03 000000` + page with byte 0 = `00`) | mark update in progress |
| 18.09–19.20 | rpt4 mode 0 addr `0x180000`, len `0x40000`; 64 × rpt3 | write 256 KB image (starts `SMEDIA02`) |
| 19.51–19.65 | same address/length; 64 × read rpt1 | read back and compare |
| 19.65–19.68 | config page read (byte 0 = `00`), rewrite with byte 0 = `01` | mark valid |
| 19.98–19.99 | rpt4 mode 3 addr `0x4F0000` len `0x10000`; 16 × rpt3 | customised section 1 |
| 20.38–20.78 | rpt4 mode 3 addr `0x500000` len `0x20000`; 32 × rpt3 | customised section 2 |
| 35.7 | re-enumeration | |

Report sizes on the wire: rpt4 `wLength` 32, rpt3 4100 (report ID, 3 zero bytes, 4096 data),
rpt1 reads `wLength` 4097. The 256 KB written is (header + boot size) rounded up to 64 KB, not the
whole 1.5 MB file.

**Implemented** in `src/main/firmware/fourks.js` (CLI: `tools/firmware-update.js`). The details below
came from the captures and the matching decompiled `PD575FirmwareUpdate` code:

* **General I2C frame** (output report 6, 255 bytes on the wire including the ID):
  * write: `[4+n, 06, addr, n, bytes…]`
  * read: `[5+n, 07, addr, n, bytes…, readLen]`, where `n` may be 0
  * reply on report 5: `[status, data…]`
  * after a bootloader write, Studio reads a 1-byte acknowledgement with `wLength` 1791. It is 0,
    except after `RUN_APROM`, when the bootloader is gone and it is 1.
* **MCU image:** the downloaded file plus 512 zero bytes (Studio allocates size+0x200), sent as
  299×240 bytes plus a 72-byte final chunk.
* **Bootloader write pointer:** after each chunk, a 3-byte read from `0x6C` returns
  `0xC00000 + bytes received` (LE24). The updater checks it after every chunk.
* **Bootloader commands:**
  * `0x66`/`aa` jump command: the constant `03 0d 12 04 86 54 06 aa`.
  * Idle check: `ac`, then read 1 byte, which must be `0xAB` (retried up to 5×).
  * `a2` erases, followed by Studio's ~30 s wait.
  * `a3` reads the bootloader version (`15 0b 0a`).
  * `ae` writes a chunk; `a4` runs the new firmware.
* **Base file:** an 8 MB flash image whose file offset equals the flash address. The main region
  length is (BE u32 `0x18000C` + BE u32 `0x180010`) rounded up to 64 KB. The two extra sections
  are `0x4F0000`/64 KB and `0x500000`/128 KB.

**Practical:**
* The update needs a **physical replug** between the MCU and Base steps, within about a minute.
* The card must be on **USB 3**: in USB 2.0 mode (product ID `0x00AE`) Elgato's manifest offers no
  firmware.
* The risky window is the ~3 s of step "write 256 KB" until "mark valid". A failure before the
  config page is marked in progress leaves the old Base fully intact (as in run 1).

### PD (type 6): `FirmwareUpdatePD` (ITE IT6227 USB-PD controller)
* MCU "stop polling": I2C `0x66`/`0xAA`, `[03 12 34 5C 01]`.
* Erase the IT6227: `[03 0D 12 04 62 27 01]`.
* `dbgr_flash_program`: the image is written to the IT6227 through the MCU's debugger bridge,
  with verify steps.
* MCU "start polling": `[12 34 5C 00]`, then replug.

## 4. Cameras with the "Elgato firmware spec" (Facecam Neo, MK.2, MK.2 Rev.2, 4K)

`CElgatoWebcamFWSupport::DoFirmwareUpdate`.

* **Image header (first 0x80 bytes):** u16 magic `0x00CE` or `0x4E59`; the text `Elgato Firmware`
  within bytes 4–0x2C; byte `0x2D` non-zero; u32 at `0x36` ≥ 100; u16 at `0x3A` ≥ 0x80. The payload
  follows the 0x80-byte header. IQ images are ≥ 0x47 bytes and contain `firmware` in their first
  0x46 bytes.
* Other checks: downgrades blocked below a minimum, a partition-size mismatch check (EVH-5345), and a
  device/image combination check.
* **Which transport** depends on the model and the firmware currently on the device:

| PID | Condition | Method |
|---|---|---|
| 0x81 Neo | firmware < 0x1_0048_009B | legacy XU |
| 0x81 Neo | otherwise | HID |
| 0x93/0x94 MK.2 | firmware < 0x1_0060_0159 | legacy XU |
| 0x93/0x94 MK.2 | otherwise | HID |
| 0xD6/0xD7 MK.2 Rev.2 | always | HID |
| 0x91/0x92 Facecam 4K | firmware ≥ 0x1_0004_0003 | XU |

* **Legacy XU** (unit `…8A8D3B48`): SET selector 4, `[01 00 03 00 00 size:u24]`, where size is the
  payload rounded up to 512. Then GET selector 5 (8-byte status), then data in 32-byte chunks
  (512-byte chunks via selector 0x0D on MK.2) **(partial)**.
* **XU** (XU2 unit `2C49D16A…`): selector `0x15` takes an upload header (contains `01 05 01`,
  payload size = file − 0x80, and the chunk size field); data goes in chunks to selector `0x16`;
  `0x17` commits; GET `0x18` reads status. Progress is reported per chunk.
* **HID:** "set device in update mode" (6-byte command), then data blocks on HID report `0x01`
  (block header starts `01 FF FB 03`), then "end update", with 200 ms / 500 ms waits **(partial)**.

## 5. Facecam (original) and Facecam Pro

* **Facecam (0x77/0x78)** has a Cypress CX3 bridge. The image must start with `CY` and contain the
  expected header token, within a size range. The HID sequence is `CX3_FW_DOWNLOAD_START`
  (command `0xFB00`), `CX3_FW_DOWNLOADING` in chunks, `CX3_FW_DOWNLOAD_END`, then a reboot.
* **Facecam Pro (0x79/0x87)** first enters "service mode" over the legacy XU (selector 0x13, the
  `SERVICE_MODE` control). It then updates over HID ("Start", "Transfer data", "Finish"), with a
  maximum image size check.

## 6. Game Capture 4K X (Realtek UB700E)

The image must be an MCU image of 1–16 MB with the expected header. Studio writes it to a temp
file and calls Realtek's `burnToFlash()` in `RTK_IO_x64.dll`. That goes over the same undecoded
`CRosRTD2801Protocol` UVC-XU transport as the 4K X settings (PROTOCOL.md §3). Doing this on Linux
first requires decoding that transport.

## 7. Elgato Prompter

`PrompterDeviceSupport::UpdateFirmwareOverTransport` sends the image in pages split into chunks of
HID output reports (log: "output report failed at page={0} chunk={1}"). It has a maximum image
size, reads the version and serial number through feature reports, and validates the firmware type.
**(partial: report layout not decoded)**

## 8. What it would take to implement safely

1. Decode the parts still marked (partial), starting with one device family, and check them
   against a USB capture (Wireshark + USBPcap) of a real update on Windows.
2. Implement read-only steps first: version readout, manifest lookup and an "update available"
   notice.
3. Only then flash, and only with verified downloads (SHA-256 from the manifest), header checks,
   no streaming, `mustDisconnectHDMI` enforced, `updateOrder` followed, and a recovery plan for the
   device (most capture cards keep a bootloader, but a cut-off Base/PD write may not be recoverable
   without Windows tools).
