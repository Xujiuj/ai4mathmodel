function createAutoUpdaterBridge({
  autoUpdater = null,
  isDev = false,
  send = () => {},
  log = console,
} = {}) {
  if (!autoUpdater) {
    return {
      enabled: false,
      check: async () => ({ ok: false, reason: 'updater-unavailable' }),
      download: async () => ({ ok: false, reason: 'updater-unavailable' }),
      install: async () => ({ ok: false, reason: 'updater-unavailable' }),
    };
  }

  autoUpdater.autoDownload = false;
  autoUpdater.allowPrerelease = false;
  if (autoUpdater.logger !== undefined) autoUpdater.logger = log;

  const emit = (type, payload = {}) => send({ type, ...payload, at: Date.now() });

  autoUpdater.on('checking-for-update', () => emit('checking'));
  autoUpdater.on('update-available', (info) => emit('available', {
    version: info.version,
    releaseNotes: info.releaseNotes || '',
  }));
  autoUpdater.on('update-not-available', () => emit('up-to-date'));
  autoUpdater.on('download-progress', (progress) => emit('download-progress', {
    percent: progress.percent,
  }));
  autoUpdater.on('update-downloaded', (info) => emit('ready', { version: info.version }));
  autoUpdater.on('error', (error) => emit('error', { message: error.message }));

  return {
    enabled: !isDev,
    check: async () => {
      if (isDev) return { ok: false, reason: 'dev-mode' };
      const result = await autoUpdater.checkForUpdates();
      return { ok: true, result };
    },
    download: async () => {
      if (isDev) return { ok: false, reason: 'dev-mode' };
      await autoUpdater.downloadUpdate();
      return { ok: true };
    },
    install: async () => {
      if (isDev) return { ok: false, reason: 'dev-mode' };
      autoUpdater.quitAndInstall(false, true);
      return { ok: true };
    },
  };
}

module.exports = { createAutoUpdaterBridge };
