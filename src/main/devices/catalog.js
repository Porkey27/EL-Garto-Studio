'use strict';
// Known Elgato USB devices (vendor 0x0fd9). Feature flags mirror what the Windows
// app enables per model; `hidInterface` is the USB interface carrying the vendor
// HID control channel on capture cards.

const ELGATO_VID = 0x0fd9;

const CAPTURE_FULL = {
  customEdid: true, edidMode: true, colorRange: true, pictureSettings: true,
  hdrInput: true, hdrTonemapping: true, hdrRecording: true, tenBit: true,
};

const DEVICES = [
  { name: 'Game Capture HD60 S+', pids: [0x6a, 0x6b], kind: 'capture', type: 'HD60_SPLUS',
    features: { ...CAPTURE_FULL, audioInputs: 3 }, hidInterface: 2, firmware: ['mcu'],
    maxRes: [[1920, 1080, 120], [3840, 2160, 60]] },
  { name: 'Cam Link', pids: [0x61, 0x62], kind: 'capture', type: 'CAMLINK',
    features: { pictureSettings: true }, hidInterface: 2, firmware: ['mcu'], maxRes: [[1920, 1080, 60]] },
  { name: 'Cam Link 4K', pids: [0x66, 0x67], kind: 'capture', type: 'CAMLINK_4K',
    features: { pictureSettings: true }, hidInterface: 2, firmware: ['mcu'],
    maxRes: [[1920, 1080, 60], [3840, 2160, 30]] },
  { name: 'Cam Link 4K', pids: [0x7b, 0x85], kind: 'capture', type: 'CAMLINK_4K_REV3',
    features: { pictureSettings: true }, firmware: ['mcu', 'base'], maxRes: [[1920, 1080, 60], [3840, 2160, 30]] },
  { name: 'Cam Link 4K', pids: [0xa1, 0xa2], kind: 'capture', type: 'CAMLINK_4K_REV4',
    features: { pictureSettings: true }, hidInterface: 7, firmware: ['mcu', 'base'], maxRes: [[3840, 2160, 60]] },
  { name: 'Cam Link 4K MK.2', pids: [0xf4, 0xf5], kind: 'capture', type: 'CAMLINK_4K_MK2',
    features: { pictureSettings: true, colorRange: true }, hidInterface: 7, firmware: [], maxRes: [[3840, 2160, 60]] },
  { name: 'Cam Link Pro', pids: [0x11], kind: 'capture', type: 'CAMLINK_PRO', pcie: true,
    features: { pictureSettings: true }, firmware: ['mcu'], maxRes: [[3840, 2160, 60]] },
  { name: 'Game Capture 4K60 Pro', pids: [0x07, 0x0b], kind: 'capture', type: '4K60_PRO', pcie: true,
    features: { customEdid: true, edidMode: true, colorRange: true, pictureSettings: true, hdrInput: true },
    firmware: ['mcu'], maxRes: [[1920, 1080, 240], [2560, 1440, 144], [4096, 2160, 60]] },
  { name: 'Game Capture 4K60 Pro MK.2', pids: [0x0e], kind: 'capture', type: '4K60_PRO_MK2', pcie: true,
    features: { ...CAPTURE_FULL, vrr: true }, firmware: ['mcu', 'base'],
    maxRes: [[1920, 1080, 240], [2560, 1440, 144], [4096, 2160, 60]] },
  { name: '4K Pro', pids: [0x12], kind: 'capture', type: '4K_PRO', pcie: true,
    features: { ...CAPTURE_FULL, vrr: true }, firmware: ['mcu', 'base'],
    maxRes: [[1920, 1080, 360], [4096, 2160, 240], [7680, 4320, 60]] },
  { name: 'Game Capture HD60 X', pids: [0x82, 0x83], kind: 'capture', type: 'HD60_X',
    features: { ...CAPTURE_FULL, audioInputs: 3, vrr: true }, hidInterface: 7, firmware: ['mcu', 'base'],
    maxRes: [[1920, 1080, 240], [2560, 1440, 120], [3840, 2160, 60]] },
  { name: 'Game Capture HD60 X Rev.2', pids: [0x8a, 0x8b], kind: 'capture', type: 'HD60_XPLUS',
    features: { ...CAPTURE_FULL, audioInputs: 3, vrr: true }, firmware: ['mcu', 'base'],
    maxRes: [[1920, 1080, 240], [2560, 1440, 120], [3840, 2160, 60]] },
  { name: 'Game Capture Neo', pids: [0x8c, 0x8d], kind: 'capture', type: 'GAMECAPTURE_NEO',
    features: { customEdid: true, edidMode: true, colorRange: true, pictureSettings: true, hdrInput: true, hdrTonemapping: true },
    hidInterface: 7, firmware: ['mcu', 'base'], maxRes: [[1920, 1080, 120], [3840, 2160, 60]] },
  { name: 'Game Capture 4K X', pids: [0x9b, 0x9c, 0x9d], kind: 'capture', type: '4K_X', usb2Pid: 0x9d,
    features: { ...CAPTURE_FULL, audioInputs: 3, vrr: true }, firmware: ['mcu'],
    maxRes: [[1920, 1080, 240], [2560, 1440, 144], [3840, 2160, 144]] },
  { name: 'Game Capture 4K S', pids: [0xae, 0xaf, 0xdb, 0xdc], kind: 'capture', type: '4K_S', usb2Pid: 0xae,
    features: { ...CAPTURE_FULL, audioInputs: 3, vrr: true }, hidInterface: 7, firmware: ['mcu', 'base'],
    maxRes: [[1920, 1080, 240], [2560, 1440, 120], [3840, 2160, 60]] },

  { name: 'Facecam', pids: [0x77, 0x78], kind: 'camera', type: 'FACECAM', usb2Pid: 0x77, firmware: ['base'] },
  { name: 'Facecam Pro', pids: [0x79, 0x87], kind: 'camera', type: 'FACECAM_PRO', usb2Pid: 0x87, firmware: ['base'] },
  { name: 'Facecam Neo', pids: [0x81], kind: 'camera', type: 'FACECAM_NEO', firmware: ['base'] },
  { name: 'Facecam MK.2', pids: [0x93, 0x94], kind: 'camera', type: 'FACECAM_MK2', usb2Pid: 0x93, firmware: ['base'] },
  { name: 'Facecam MK.2 Rev.2', pids: [0xd6, 0xd7], kind: 'camera', type: 'FACECAM_MK2_REV2', usb2Pid: 0xd6, firmware: ['base'] },
  { name: 'Facecam 4K', pids: [0x91, 0x92], kind: 'camera', type: 'FACECAM_4K', usb2Pid: 0x91, firmware: ['base'] },
];

function lookup(vid, pid) {
  if (vid !== ELGATO_VID) return null;
  return DEVICES.find((d) => d.pids.includes(pid)) || null;
}

module.exports = { ELGATO_VID, DEVICES, lookup };
