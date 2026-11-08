'use strict';
// Packs dist/win-unpacked into the portable zip (el-gato-studio-<version>-windows-portable.zip).
// Uses Windows' built-in tar (bsdtar), which writes zip files: electron-builder's own zip target
// hung on GitHub's Windows runners after downloading its 7-Zip tool.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const { version } = require(path.join(root, 'package.json'));
const src = path.join(root, 'dist', 'win-unpacked');
const out = path.join(root, 'dist', `el-gato-studio-${version}-windows-portable.zip`);

if (!fs.existsSync(src)) throw new Error(`${src} not found: run electron-builder --win first`);
fs.rmSync(out, { force: true });
// The System32 copy explicitly: Git's GNU tar can come first on PATH and can't write zips.
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'tar.exe') : 'bsdtar';
execFileSync(tar, ['-a', '-c', '-f', out, '-C', src, ...fs.readdirSync(src)], { stdio: 'inherit' });
console.log(`Built ${path.relative(root, out)} (${Math.round(fs.statSync(out).size / 1e6)} MB)`);
