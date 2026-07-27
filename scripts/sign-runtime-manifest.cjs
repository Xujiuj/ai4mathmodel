#!/usr/bin/env node
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { signManifest, verifyManifestSignature } = require('../electron/component-manager.cjs');

function usage() {
  console.error(`用法:
  node scripts/sign-runtime-manifest.cjs <manifest.json> [--out <signed.json>] [--key <private.pem>]

示例:
  node scripts/sign-runtime-manifest.cjs release/manifest-0-stable.json
  node scripts/sign-runtime-manifest.cjs draft.json --out release/manifest-0-stable.json
`);
}

async function main(argv) {
  const args = [...argv];
  if (!args.length || args.includes('-h') || args.includes('--help')) {
    usage();
    process.exit(args.length ? 0 : 1);
  }
  const input = args.shift();
  let output = input;
  let keyPath = '';
  while (args.length) {
    const flag = args.shift();
    if (flag === '--out') output = args.shift();
    else if (flag === '--key') keyPath = args.shift();
    else throw new Error(`未知参数: ${flag}`);
  }

  const raw = JSON.parse(await fsp.readFile(input, 'utf8'));
  const { signature, allowUnsignedDev, ...content } = raw;
  const signed = signManifest(content, keyPath || undefined);
  if (!verifyManifestSignature(signed)) throw new Error('签名后自校验失败');
  await fsp.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await fsp.writeFile(output, `${JSON.stringify(signed, null, 2)}\n`, 'utf8');
  console.log(`已签名: ${output}`);
  console.log(`signature: ${signed.signature.slice(0, 24)}...`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
