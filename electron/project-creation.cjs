const fsp = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_PROJECT_NAME = '新建数模项目';

function normalizeProjectCreationName(value) {
  const supplied = value === undefined || value === null ? DEFAULT_PROJECT_NAME : String(value);
  const safeName = supplied.replace(/[<>:"/\\|?*]/g, '-').trim().slice(0, 80);
  if (!safeName || safeName === '.' || safeName === '..') {
    throw new Error('项目名称无效。');
  }
  return safeName;
}

function resolveProjectCreationRoot(parent, name) {
  const parentRoot = path.resolve(String(parent || ''));
  const root = path.resolve(parentRoot, name);
  if (path.dirname(root) !== parentRoot) throw new Error('项目目录必须位于所选位置下。');
  return root;
}

async function claimProjectCreationRoot(parent, name) {
  const safeName = normalizeProjectCreationName(name);
  const root = resolveProjectCreationRoot(parent, safeName);
  await fsp.mkdir(root);
  return { root, safeName };
}

module.exports = {
  DEFAULT_PROJECT_NAME,
  normalizeProjectCreationName,
  resolveProjectCreationRoot,
  claimProjectCreationRoot,
};
