'use strict';
// Builds the native helper for the current OS: native/build/egctl (Linux, make + cc) or
// native/build/egctl.exe (Windows, MSVC via native/win/build.ps1).

const { execFileSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
if (process.platform === 'win32') {
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'native', 'win', 'build.ps1')], { stdio: 'inherit' });
} else if (process.platform === 'linux') {
  execFileSync('make', ['-C', path.join(root, 'native')], { stdio: 'inherit' });
} else {
  console.error(`No native helper for ${process.platform}; device controls will be unavailable.`);
}
