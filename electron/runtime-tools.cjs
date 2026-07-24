const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const TOOL_DIRECTORIES = Object.freeze({
  python: 'python',
  tectonic: 'tectonic',
});

const LOCAL_TOOL_COMMANDS = Object.freeze({
  python: ['python', 'python3'],
  tectonic: ['tectonic'],
});

const LOCAL_LATEX_COMMANDS = Object.freeze(['tectonic', 'xelatex', 'lualatex', 'pdflatex']);

const TECTONIC_FONT_ALIASES = Object.freeze([
  'simhei.ttf',
  'simkai.ttf',
  'simsun.ttf',
]);

function executableName(tool, platform = process.platform) {
  if (!Object.hasOwn(TOOL_DIRECTORIES, tool)) throw new Error(`Unsupported runtime tool: ${tool}`);
  return platform === 'win32' ? `${tool}.exe` : tool;
}

function runtimeRoot({ isPackaged = false, resourcesPath = '', appRoot = '' } = {}) {
  const base = isPackaged ? resourcesPath : appRoot;
  if (!base || !path.isAbsolute(base)) throw new Error('Runtime base path must be absolute.');
  return path.join(base, 'runtime');
}

function runtimeToolPath(tool, context = {}) {
  if (!Object.hasOwn(TOOL_DIRECTORIES, tool)) throw new Error(`Unsupported runtime tool: ${tool}`);
  return path.join(runtimeRoot(context), TOOL_DIRECTORIES[tool], executableName(tool, context.platform));
}

function pathEnvironmentKey(environment = {}) {
  return Object.keys(environment).find((key) => key.toLowerCase() === 'path') || 'PATH';
}

function localCommandNames(command, platform = process.platform) {
  const value = String(command || '').trim();
  if (!value) return [];
  if (platform !== 'win32' || path.extname(value)) return [value];
  return [`${value}.exe`, `${value}.com`, value];
}

function findOnPath(commands, context = {}) {
  const environment = context.env || process.env;
  const existsSync = context.existsSync || fs.existsSync;
  const platform = context.platform || process.platform;
  const pathValue = String(environment[pathEnvironmentKey(environment)] || '');
  const directories = pathValue.split(context.pathDelimiter || path.delimiter)
    .map((directory) => directory.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  for (const command of commands) {
    if (path.isAbsolute(command) && existsSync(command)) return path.normalize(command);
    for (const name of localCommandNames(command, platform)) {
      for (const directory of directories) {
        const candidate = path.join(directory, name);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return '';
}

function bundledRuntimeExecutable(tool, context = {}) {
  const candidate = runtimeToolPath(tool, context);
  return (context.existsSync || fs.existsSync)(candidate) ? candidate : '';
}

function localRuntimeExecutable(tool, context = {}) {
  if (!Object.hasOwn(LOCAL_TOOL_COMMANDS, tool)) throw new Error(`Unsupported runtime tool: ${tool}`);
  return findOnPath(LOCAL_TOOL_COMMANDS[tool], context);
}

function resolveRuntimeExecutable(tool, context = {}) {
  const bundled = bundledRuntimeExecutable(tool, context);
  if (bundled) return bundled;
  const local = localRuntimeExecutable(tool, context);
  if (local) return local;
  return LOCAL_TOOL_COMMANDS[tool][0];
}

function runtimeStatus(context = {}) {
  return Object.freeze(Object.fromEntries(Object.keys(TOOL_DIRECTORIES).map((tool) => [
    tool,
    tool === 'tectonic'
      ? Boolean(resolveLatexCompiler(context).executable)
      : Boolean(bundledRuntimeExecutable(tool, context) || localRuntimeExecutable(tool, context)),
  ])));
}

function runtimeToolSource(tool, context = {}) {
  const bundled = bundledRuntimeExecutable(tool, context);
  if (bundled) return { tool, executable: bundled, source: 'bundled' };
  const local = localRuntimeExecutable(tool, context);
  if (local) return { tool, executable: local, source: 'local' };
  return { tool, executable: '', source: 'missing' };
}

function resolveLatexCompiler(context = {}) {
  const bundled = bundledRuntimeExecutable('tectonic', context);
  if (bundled) return { executable: bundled, kind: 'tectonic', source: 'bundled' };
  const local = findOnPath(LOCAL_LATEX_COMMANDS, context);
  if (!local) return { executable: '', kind: '', source: 'missing' };
  const name = path.basename(local).replace(/\.(?:exe|com)$/i, '').toLowerCase();
  return { executable: local, kind: name === 'tectonic' ? 'tectonic' : name, source: 'local' };
}

function writableRuntimeDirectories(userData) {
  if (!userData || !path.isAbsolute(userData)) throw new Error('User data path must be absolute.');
  const root = path.join(userData, 'runtime');
  return Object.freeze({
    root,
    home: path.join(root, 'home'),
    cache: path.join(root, 'cache'),
    matplotlib: path.join(root, 'cache', 'matplotlib'),
    tectonic: path.join(root, 'cache', 'tectonic'),
  });
}

async function ensureWritableRuntimeDirectories(userData) {
  const directories = writableRuntimeDirectories(userData);
  await Promise.all(Object.values(directories).map((directory) => fsp.mkdir(directory, { recursive: true })));
  return directories;
}

function runtimeAssetError(asset) {
  return Object.assign(new Error(`Required application runtime asset is missing: ${asset}`), {
    code: 'RUNTIME_ASSET_MISSING',
    asset,
  });
}

async function seedTectonicCache(context = {}, { seedVersion = 'v1', required = context.isPackaged } = {}) {
  const source = path.join(runtimeRoot(context), 'tectonic', 'cache');
  const directories = await ensureWritableRuntimeDirectories(context.userData);
  const existsSync = context.existsSync || fs.existsSync;
  if (!existsSync(source)) {
    if (required) throw runtimeAssetError('tectonic/cache');
    return { seeded: false, reason: 'source-missing', target: directories.tectonic };
  }

  const markerVersion = String(seedVersion || 'v1').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'v1';
  const marker = path.join(directories.tectonic, `.bundled-cache-${markerVersion}.json`);
  if (existsSync(marker)) return { seeded: false, reason: 'current', target: directories.tectonic };

  await fsp.cp(source, directories.tectonic, {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
  await fsp.writeFile(marker, JSON.stringify({ seedVersion: markerVersion, seededAt: new Date().toISOString() }), 'utf8');
  return { seeded: true, target: directories.tectonic };
}

async function withTectonicFontAliases(paperDirectory, context, operation) {
  if (!path.isAbsolute(paperDirectory)) throw new Error('Paper directory must be absolute.');
  if (typeof operation !== 'function') throw new TypeError('Tectonic font operation must be a function.');
  const sourceDirectory = path.join(runtimeRoot(context), 'tectonic', 'fonts');
  const existsSync = context.existsSync || fs.existsSync;
  const created = [];

  try {
    for (const name of TECTONIC_FONT_ALIASES) {
      const source = path.join(sourceDirectory, name);
      const destination = path.join(paperDirectory, name);
      if (!existsSync(source)) {
        if (context.isPackaged) throw runtimeAssetError(`tectonic/fonts/${name}`);
        continue;
      }
      if (existsSync(destination)) continue;
      try {
        await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
        created.push(destination);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    return await operation();
  } finally {
    await Promise.all(created.map((file) => fsp.rm(file, { force: true })));
  }
}

function buildRuntimeEnvironment({
  base = process.env,
  isPackaged = false,
  resourcesPath = '',
  appRoot = '',
  userData,
  platform = process.platform,
  existsSync = fs.existsSync,
} = {}) {
  const root = runtimeRoot({ isPackaged, resourcesPath, appRoot });
  const writable = writableRuntimeDirectories(userData);
  const pathKey = pathEnvironmentKey(base);
  const inheritedPath = String(base[pathKey] || '');
  const bundledPython = bundledRuntimeExecutable('python', { isPackaged, resourcesPath, appRoot, platform, existsSync });
  const bundledTectonic = bundledRuntimeExecutable('tectonic', { isPackaged, resourcesPath, appRoot, platform, existsSync });
  const runtimePath = [
    path.join(root, 'python'),
    path.join(root, 'python', 'Scripts'),
    path.join(root, 'tectonic'),
  ].filter((directory) => existsSync(directory));
  if (isPackaged && platform === 'win32') {
    const systemRoot = String(base.SystemRoot || base.SYSTEMROOT || base.WINDIR || 'C:\\Windows');
    runtimePath.push(path.join(systemRoot, 'System32'), path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'), systemRoot);
  }
  if (inheritedPath && (!isPackaged || !bundledPython || !bundledTectonic)) runtimePath.push(inheritedPath);

  return {
    [pathKey]: runtimePath.join(path.delimiter),
    HOME: writable.home,
    USERPROFILE: writable.home,
    // Undefined removes any inherited Python home so a local interpreter can resolve itself.
    PYTHONHOME: bundledPython ? path.dirname(bundledPython) : undefined,
    PYTHONPATH: undefined,
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUTF8: '1',
    MPLCONFIGDIR: writable.matplotlib,
    TECTONIC_CACHE_DIR: writable.tectonic,
    XDG_CACHE_HOME: writable.cache,
  };
}

module.exports = {
  LOCAL_LATEX_COMMANDS,
  LOCAL_TOOL_COMMANDS,
  TECTONIC_FONT_ALIASES,
  TOOL_DIRECTORIES,
  buildRuntimeEnvironment,
  bundledRuntimeExecutable,
  ensureWritableRuntimeDirectories,
  executableName,
  findOnPath,
  localRuntimeExecutable,
  resolveRuntimeExecutable,
  resolveLatexCompiler,
  runtimeRoot,
  runtimeStatus,
  runtimeToolSource,
  runtimeToolPath,
  seedTectonicCache,
  withTectonicFontAliases,
  writableRuntimeDirectories,
};
