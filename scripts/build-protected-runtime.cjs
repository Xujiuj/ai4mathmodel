const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');
const bytenode = require('bytenode');

const projectRoot = path.resolve(__dirname, '..');
const outputDirectory = path.join(projectRoot, 'electron', 'protected');
const temporaryBundle = path.join(outputDirectory, 'main.bundle.cjs');
const temporaryBytecode = path.join(outputDirectory, 'main.raw.jsc');
const encryptedRuntime = path.join(outputDirectory, 'runtime.bin');
const temporaryLoader = path.join(outputDirectory, 'loader.bundle.cjs');
const loaderBytecode = path.join(outputDirectory, 'loader.jsc');
const spreadsheetWorker = path.join(outputDirectory, 'spreadsheet-worker.cjs');
const electronPath = path.join(projectRoot, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const FORBIDDEN_RUNTIME_TEXT = [
  'SKILL.md',
  '.agents',
  'STAGE_PLAYBOOKS',
  'Supervisor Dispatch v1',
  'local-supervisor-policy',
  'createAgentSupervisor',
  '你正在当前工作目录内执行无人值守',
  '所有安全重试与模型降级路径已耗尽',
];

function assertNoPrivateText(targets) {
  for (const target of targets) {
    const content = fsSync.readFileSync(target);
    const encodings = [content.toString('utf8'), content.toString('utf16le')];
    for (const needle of FORBIDDEN_RUNTIME_TEXT) {
      if (encodings.some((text) => text.includes(needle))) {
        throw new Error(`Protected output exposes private runtime text: ${path.basename(target)} (${needle})`);
      }
    }
  }
}

function loaderSource(key, firstMask, secondMask) {
  const keyDigest = crypto.createHash('sha256').update(key).digest('hex');
  return `
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const bytenode = require('bytenode');
const a = [${[...firstMask].join(',')}];
const b = [${[...secondMask].join(',')}];
const key = Buffer.from(a.map((value, index) => value ^ b[index]));
if (crypto.createHash('sha256').update(key).digest('hex') !== '${keyDigest}') throw new Error('Application runtime integrity check failed.');
const filename = path.join(__dirname, 'runtime.bin');
const payload = fs.readFileSync(filename);
if (payload.length < 65 || payload.subarray(0, 5).toString('ascii') !== 'MMRT1') throw new Error('Application runtime is damaged.');
const nonce = payload.subarray(5, 17);
const tag = payload.subarray(17, 33);
const expected = payload.subarray(33, 65);
const ciphertext = payload.subarray(65);
const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
decipher.setAAD(Buffer.from('math-modeling-runtime-v1'));
decipher.setAuthTag(tag);
const bytecode = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
const actual = crypto.createHash('sha256').update(bytecode).digest();
if (!crypto.timingSafeEqual(actual, expected)) throw new Error('Application runtime integrity check failed.');
const compiledWrapper = bytenode.runBytecode(bytecode);
if (typeof compiledWrapper !== 'function') throw new Error('Application runtime could not be loaded.');
const runtimeModule = new Module(path.join(__dirname, 'runtime.jsc'), module);
runtimeModule.filename = path.join(__dirname, 'runtime.jsc');
runtimeModule.paths = module.paths;
function localRequire(request) { return runtimeModule.require(request); }
localRequire.resolve = (request, options) => Module._resolveFilename(request, runtimeModule, false, options);
localRequire.main = process.main;
localRequire.extensions = Module._extensions;
localRequire.cache = Module._cache;
compiledWrapper.call(runtimeModule.exports, runtimeModule.exports, localRequire, runtimeModule, runtimeModule.filename, __dirname, process, global);
module.exports = runtimeModule.exports;
key.fill(0);
bytecode.fill(0);
`;
}

function assertEncryptedRuntime(payload, key, expectedBytecode) {
  if (payload.length < 65 || payload.subarray(0, 5).toString('ascii') !== 'MMRT1') {
    throw new Error('Protected runtime payload has an invalid header.');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, payload.subarray(5, 17));
  decipher.setAAD(Buffer.from('math-modeling-runtime-v1'));
  decipher.setAuthTag(payload.subarray(17, 33));
  const bytecode = Buffer.concat([decipher.update(payload.subarray(65)), decipher.final()]);
  const expectedDigest = payload.subarray(33, 65);
  const actualDigest = crypto.createHash('sha256').update(bytecode).digest();
  if (!crypto.timingSafeEqual(actualDigest, expectedDigest) || !bytecode.equals(expectedBytecode)) {
    bytecode.fill(0);
    throw new Error('Protected runtime encryption round trip failed.');
  }
  bytecode.fill(0);
}

async function build() {
  if (!fsSync.existsSync(electronPath)) require('electron');
  await fs.mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    temporaryBundle, temporaryBytecode, encryptedRuntime, temporaryLoader, loaderBytecode, spreadsheetWorker,
    path.join(outputDirectory, 'main.jsc'),
  ].map((target) => fs.rm(target, { force: true })));

  await esbuild.build({
    entryPoints: [path.join(projectRoot, 'electron', 'main.cjs')],
    outfile: temporaryBundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    legalComments: 'none',
    minify: true,
    sourcemap: false,
    supported: { arrow: false },
  });

  await esbuild.build({
    entryPoints: [path.join(projectRoot, 'electron', 'workers', 'spreadsheet-worker.cjs')],
    outfile: spreadsheetWorker,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    legalComments: 'none',
    minify: true,
    sourcemap: false,
  });

  await bytenode.compileFile({
    filename: temporaryBundle,
    output: temporaryBytecode,
    compileAsModule: true,
    electronMain: true,
    electronPath,
  });

  const rawBytecode = await fs.readFile(temporaryBytecode);
  const key = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from('math-modeling-runtime-v1'));
  const ciphertext = Buffer.concat([cipher.update(rawBytecode), cipher.final()]);
  const digest = crypto.createHash('sha256').update(rawBytecode).digest();
  const encryptedPayload = Buffer.concat([Buffer.from('MMRT1'), nonce, cipher.getAuthTag(), digest, ciphertext]);
  assertEncryptedRuntime(encryptedPayload, key, rawBytecode);
  await fs.writeFile(encryptedRuntime, encryptedPayload);

  const firstMask = crypto.randomBytes(32);
  const secondMask = Buffer.from(key.map((value, index) => value ^ firstMask[index]));
  await fs.writeFile(temporaryLoader, loaderSource(key, firstMask, secondMask), 'utf8');
  await bytenode.compileFile({
    filename: temporaryLoader,
    output: loaderBytecode,
    compileAsModule: true,
    electronMain: true,
    electronPath,
  });

  key.fill(0);
  rawBytecode.fill(0);
  firstMask.fill(0);
  secondMask.fill(0);

  const stat = await fs.stat(encryptedRuntime);
  const loaderStat = await fs.stat(loaderBytecode);
  const workerStat = await fs.stat(spreadsheetWorker);
  if (stat.size < 32_768) throw new Error('Protected runtime payload is unexpectedly small.');
  if (loaderStat.size < 2_048 || loaderStat.size > 128_000) throw new Error('Protected runtime loader has an unexpected size.');
  if (workerStat.size < 100_000) throw new Error('Bundled spreadsheet worker is unexpectedly small.');
  assertNoPrivateText([encryptedRuntime, loaderBytecode, spreadsheetWorker]);
  await Promise.all([temporaryBundle, temporaryBytecode, temporaryLoader].map((target) => fs.rm(target, { force: true })));
  process.stdout.write(`Protected runtime: ${Math.round(stat.size / 1024)} KiB encrypted + ${Math.round(loaderStat.size / 1024)} KiB loader; spreadsheet worker: ${Math.round(workerStat.size / 1024)} KiB\n`);
}

build().catch(async (error) => {
  await Promise.all([temporaryBundle, temporaryBytecode, temporaryLoader].map((target) => fs.rm(target, { force: true }).catch(() => {})));
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
