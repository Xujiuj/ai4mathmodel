const { normalizeSettings } = require('../runtime-config.cjs');

function connectionModels(connection = {}) {
  const models = [connection.model]
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  return [...new Set(models)];
}

function buildModelRoutes(rawSettings, stage, { supervisor = false } = {}) {
  const settings = normalizeSettings(rawSettings);
  const primaryKey = supervisor || stage !== 'paper' ? 'reasoning' : 'writing';
  const secondaryKey = primaryKey === 'reasoning' ? 'writing' : 'reasoning';
  const keys = [primaryKey, secondaryKey];
  const routes = [];
  const seen = new Set();
  for (const connectionKey of keys) {
    const connection = settings.connections[connectionKey] || {};
    const models = connectionModels(connection);
    if (!models.length) models.push('');
    for (const model of models) {
      const identity = `${connectionKey}|${connection.protocol}|${connection.baseUrl}|${model}`.toLowerCase();
      if (seen.has(identity)) continue;
      seen.add(identity);
      routes.push({
        connectionKey,
        model,
        protocol: connection.protocol,
        baseUrl: connection.baseUrl,
        degraded: connectionKey !== primaryKey || model !== connection.model,
        reason: connectionKey !== primaryKey ? 'cross-role-fallback' : model !== connection.model ? 'fallback-model' : 'primary',
      });
    }
  }
  return routes;
}

function imageModelForAttempt(rawSettings, attemptIndex = 0) {
  const settings = normalizeSettings(rawSettings);
  const models = connectionModels(settings.connections.image);
  if (!models.length) return '';
  return models[Math.min(Math.max(0, attemptIndex), models.length - 1)];
}

module.exports = {
  buildModelRoutes,
  connectionModels,
  imageModelForAttempt,
};
