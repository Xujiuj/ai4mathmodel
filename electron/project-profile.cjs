const PROJECT_SCHEMA_VERSION = 2;
const COMPETITIONS = Object.freeze(['china', 'american']);
const PAPER_FORMATS = Object.freeze(['latex', 'markdown']);
const DEFAULT_PROJECT_PROFILE = Object.freeze({
  competition: 'china',
  paperFormat: 'latex',
});

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeProjectProfile(raw) {
  const source = isPlainObject(raw) ? raw : {};
  return {
    ...source,
    competition: COMPETITIONS.includes(source.competition)
      ? source.competition
      : DEFAULT_PROJECT_PROFILE.competition,
    paperFormat: PAPER_FORMATS.includes(source.paperFormat)
      ? source.paperFormat
      : DEFAULT_PROJECT_PROFILE.paperFormat,
  };
}

function normalizeProjectRecord(raw) {
  const source = isPlainObject(raw) ? raw : {};
  return {
    ...source,
    projectSchemaVersion: PROJECT_SCHEMA_VERSION,
    profile: normalizeProjectProfile(source.profile),
  };
}

module.exports = {
  COMPETITIONS,
  DEFAULT_PROJECT_PROFILE,
  PAPER_FORMATS,
  PROJECT_SCHEMA_VERSION,
  normalizeProjectProfile,
  normalizeProjectRecord,
};
