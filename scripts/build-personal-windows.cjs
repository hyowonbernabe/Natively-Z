// Personal build (Natively Z): Windows installer without Calendar sync.
// Existing macOS and official release workflows are unchanged.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
if (process.platform !== 'win32') {
  console.error('This command builds the Windows installer on Windows. Use the existing macOS build workflow on macOS.');
  process.exit(1);
}
const root = path.resolve(__dirname, '..');
const env = { ...process.env, NATIVELY_CORE_SMOKE: '1', NATIVELY_PERSONAL_NO_CALENDAR: '1' };
delete env.ELECTRON_RUN_AS_NODE;
function run(script, args = []) {
  console.log(`[personal-build] ${script} ${args.join(' ')}`);
  const result = spawnSync(process.execPath, [path.join(root, script), ...args], { cwd: root, env, stdio: 'inherit', shell: false });
  if (result.error || result.status !== 0) {
    console.error(`[personal-build] Failed: ${script}`, result.error?.message || result.status);
    process.exit(result.status || 1);
  }
}
run('node_modules/typescript7/lib/tsc.js', ['-p', 'tsconfig.json', '--noEmit']);
run('node_modules/typescript7/lib/tsc.js', ['-p', 'electron/tsconfig.json', '--noEmit']);
run('node_modules/vite/bin/vite.js', ['build']);
run('scripts/build-electron.js');
run('scripts/build-native.js');
run('scripts/ensure-sqlite-vec.js');
run('scripts/verify-packaged-local-assets.mjs');
run('scripts/package-app.js', ['--config', 'electron-builder.personal.cjs', '--win', 'nsis', '--x64', '--publish', 'never']);
run('scripts/verify-packaged-local-assets.mjs', ['--app', 'release/win-unpacked', '--platform', 'win32']);
console.log('[personal-build] Windows installer ready in release/. Calendar sync is unavailable.');
