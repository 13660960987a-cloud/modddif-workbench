#!/usr/bin/env node
// Builds downloadable installers for Mac (arm64 + x64) and Windows (x64).
// Each package contains: the Node runtime, the built web page, the server scripts, and a launcher.
// Usage: node scripts/package.mjs

import { mkdirSync, rmSync, cpSync, writeFileSync, chmodSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';

const root = join(fileURLToPath(import.meta.url), '../..');
const distWeb = join(root, 'dist');
const out = join(root, 'packages');
const nodeVersion = process.version; // e.g. v24.13.1

const TARGETS = [
  { name: 'mac-arm64', archive: `node-${nodeVersion}-darwin-arm64.tar.gz`, nodeBin: 'bin/node', ext: '.app' },
  { name: 'mac-x64',  archive: `node-${nodeVersion}-darwin-x64.tar.gz`,   nodeBin: 'bin/node', ext: '.app' },
  { name: 'win-x64',  archive: `node-${nodeVersion}-win-x64.zip`,         nodeBin: 'node.exe', ext: '' },
];

function run(cmd, opts) { execSync(cmd, { stdio: 'inherit', ...opts }); }

// 1. Build the web page
console.log('Building web page...');
run('node node_modules/vite/bin/vite.js build', { cwd: root });

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const cache = join(out, '.node-cache');
mkdirSync(cache, { recursive: true });

for (const target of TARGETS) {
  const isMac = target.name.startsWith('mac');
  const isWin = target.name.startsWith('win');
  // Windows archives use ASCII names: older unzip tools garble non-ASCII paths.
  // ASCII archive names: GitHub release uploads drop non-ASCII characters from file names.
  const label = `YingwenWorkbench-${target.name}`;
  console.log(`\nPackaging ${label}...`);

  // 2. Download Node runtime (cached)
  const archivePath = join(cache, target.archive);
  if (!existsSync(archivePath)) {
    const url = `https://nodejs.org/dist/${nodeVersion}/${target.archive}`;
    console.log(`  Downloading ${url}...`);
    run(`curl -fsSL -o "${archivePath}" "${url}"`);
  }

  // 3. Extract Node binary
  const nodeDir = join(out, `_node-${target.name}`);
  rmSync(nodeDir, { recursive: true, force: true });
  mkdirSync(nodeDir, { recursive: true });
  if (isWin) {
    run(`unzip -q "${archivePath}" -d "${nodeDir}"`);
  } else {
    run(`tar -xzf "${archivePath}" -C "${nodeDir}" --strip-components=1`);
  }

  // 4. Assemble the app folder
  let appDir, contentsDir, nodeBin;
  if (isMac) {
    // macOS .app bundle structure
    appDir = join(out, `${label}${target.ext}`);
    contentsDir = join(appDir, 'Contents');
    const macOS = join(contentsDir, 'MacOS');
    const resources = join(contentsDir, 'Resources');
    mkdirSync(macOS, { recursive: true });
    mkdirSync(resources, { recursive: true });

    // Copy node binary
    cpSync(join(nodeDir, target.nodeBin), join(macOS, 'node'));
    chmodSync(join(macOS, 'node'), 0o755);

    // Copy app files into Resources
    cpSync(distWeb, join(resources, 'web'), { recursive: true });
    cpSync(join(root, 'api-server.mjs'), join(resources, 'api-server.mjs'));
    cpSync(join(root, 'env-config.mjs'), join(resources, 'env-config.mjs'));
    mkdirSync(join(resources, 'src'), { recursive: true });
    cpSync(join(root, 'src', 'ai-guide.js'), join(resources, 'src', 'ai-guide.js'));
    cpSync(join(root, 'scripts', 'launcher.mjs'), join(resources, 'launcher.mjs'));

    // Shell launcher
    const launcher = `#!/bin/bash\ncd "$(dirname "$0")/../Resources"\nexec "$(dirname "$0")/node" launcher.mjs "$@"\n`;
    writeFileSync(join(macOS, '映纹工坊'), launcher);
    chmodSync(join(macOS, '映纹工坊'), 0o755);

    // Info.plist
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>映纹工坊</string>
  <key>CFBundleDisplayName</key><string>映纹工坊</string>
  <key>CFBundleIdentifier</key><string>com.modddif.workbench</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>CFBundleExecutable</key><string>映纹工坊</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>`;
    writeFileSync(join(contentsDir, 'Info.plist'), plist);
    nodeBin = join(macOS, 'node');
  } else {
    // Windows: flat folder
    appDir = join(out, label);
    mkdirSync(appDir, { recursive: true });

    // Copy node binary + necessary DLLs
    const winNodeDir = readdirSync(nodeDir).find(d => d.startsWith('node-'));
    const winSrc = winNodeDir ? join(nodeDir, winNodeDir) : nodeDir;
    cpSync(join(winSrc, 'node.exe'), join(appDir, 'node.exe'));
    // Copy ICU and OpenSSL DLLs if present
    for (const f of readdirSync(winSrc)) {
      if (f.endsWith('.dll')) cpSync(join(winSrc, f), join(appDir, f));
    }

    cpSync(distWeb, join(appDir, 'web'), { recursive: true });
    cpSync(join(root, 'api-server.mjs'), join(appDir, 'api-server.mjs'));
    cpSync(join(root, 'env-config.mjs'), join(appDir, 'env-config.mjs'));
    mkdirSync(join(appDir, 'src'), { recursive: true });
    cpSync(join(root, 'src', 'ai-guide.js'), join(appDir, 'src', 'ai-guide.js'));
    cpSync(join(root, 'scripts', 'launcher.mjs'), join(appDir, 'launcher.mjs'));

    // .bat launcher
    const bat = `@echo off\r\nchcp 65001 >nul\r\ntitle Yingwen Workbench\r\ncd /d "%~dp0"\r\nnode.exe launcher.mjs\r\nif errorlevel 1 pause\r\n`;
    writeFileSync(join(appDir, 'Start-Yingwen-Workbench.bat'), bat);
    nodeBin = join(appDir, 'node.exe');
  }

  // 5. Compress
  // Ad-hoc signature: Apple-silicon Macs refuse to run unsigned bundles at all.
  if (isMac && platform() === 'darwin') run(`codesign --force --deep --sign - "${appDir}"`);
  if (isMac) {
    const zipName = `${label}.zip`;
    run(`ditto -c -k --sequesterRsrc --keepParent "${basename(appDir)}" "${zipName}"`, { cwd: out });
    console.log(`  → ${zipName}`);
  } else {
    const zipName = `${label}.zip`;
    run(`cd "${out}" && zip -rq "${zipName}" "${basename(appDir)}"`);
    console.log(`  → ${zipName}`);
  }

  // Cleanup extracted node
  rmSync(nodeDir, { recursive: true, force: true });
}

// Cleanup cache
rmSync(cache, { recursive: true, force: true });

console.log('\nDone! Packages:');
for (const f of readdirSync(out).filter(f => f.endsWith('.zip'))) {
  const size = (execSync(`stat -f%z "${join(out, f)}"`).toString().trim() / 1048576).toFixed(1);
  console.log(`  ${f}  (${size} MB)`);
}
