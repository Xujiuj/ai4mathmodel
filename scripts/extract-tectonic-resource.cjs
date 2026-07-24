const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const executable = path.join(projectRoot, 'runtime', 'tectonic', 'tectonic.exe');
const fontRoot = path.join(projectRoot, 'runtime', 'tectonic', 'fonts');
const [resourceName, outputName] = process.argv.slice(2);

if (!/^[A-Za-z0-9_.-]{1,160}$/.test(resourceName || '') || !/^[A-Za-z0-9_.-]{1,160}$/.test(outputName || '')) {
  throw new Error('Usage: node extract-tectonic-resource.cjs <bundle-name> <output-name>');
}

const output = path.resolve(fontRoot, outputName);
if (path.dirname(output) !== path.resolve(fontRoot)) throw new Error('Output path escaped the runtime font directory.');
const result = spawnSync(executable, ['-X', 'bundle', 'cat', resourceName], {
  cwd: projectRoot,
  encoding: null,
  windowsHide: true,
  maxBuffer: 64 * 1024 * 1024,
  timeout: 120_000,
});
if (result.error) throw result.error;
if (result.status !== 0 || !result.stdout || result.stdout.length < 32_768) {
  throw new Error(`Unable to extract ${resourceName}: ${result.stderr?.toString('utf8') || `status ${result.status}`}`);
}
fs.mkdirSync(fontRoot, { recursive: true });
fs.writeFileSync(output, result.stdout);
process.stdout.write(`${resourceName} -> ${path.relative(projectRoot, output)} (${Math.round(result.stdout.length / 1024)} KiB)\n`);
