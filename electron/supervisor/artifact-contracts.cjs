const path = require('node:path');

const { ARTIFACT_CONTRACT_VERSION } = require('./contracts.cjs');

const RESULT_PATH_PATTERN = /^work\/02_solving\/sub_problem_[1-9]\d*\/results\.yaml$/;
const STABLE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const LOCATOR_SEGMENT_PATTERN = /^(?:[a-z_][a-z0-9_-]*|\d+)$/i;
const STRUCTURED_ARTIFACT_PATTERN = /\.(?:ya?ml|json)$/i;
const EVIDENCE_TYPES = new Set(['numeric', 'figure', 'citation']);

function failure(code, reason) {
  return { ok: false, code, reason };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasContractVersion(value) {
  return isPlainObject(value) && value.schema_version === ARTIFACT_CONTRACT_VERSION;
}

function isStableId(value) {
  return isNonEmptyText(value)
    && value.length <= 64
    && STABLE_ID_PATTERN.test(value);
}

function isNonEmptyTextList(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyText);
}

function isSafeArtifactPath(value) {
  if (!isNonEmptyText(value)
    || value.length > 512
    || value.includes('\\')
    || /[\u0000-\u001f<>:"|?*]/.test(value)) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  const segments = value.split('/');
  if (!['inputs', 'work'].includes(segments[0])) return false;
  if (segments.length < 2 || segments.some((segment) => {
    if (!segment || segment.startsWith('.') || /[. ]$/.test(segment)) return true;
    return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment);
  })) return false;
  return path.posix.normalize(value) === value;
}

function inspectNumbers(value, seen = new Set()) {
  if (typeof value === 'number') {
    return { count: 1, finite: Number.isFinite(value) };
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return { count: 0, finite: true };
  seen.add(value);
  const values = Array.isArray(value) ? value : Object.values(value);
  return values.reduce((result, item) => {
    const inspection = inspectNumbers(item, seen);
    return {
      count: result.count + inspection.count,
      finite: result.finite && inspection.finite,
    };
  }, { count: 0, finite: true });
}

function resolveLocator(value, locator) {
  if (!isNonEmptyText(locator) || locator.length > 256) return { found: false };
  const segments = locator.split('.');
  if (segments.some((segment) => !LOCATOR_SEGMENT_PATTERN.test(segment)
    || ['__proto__', 'prototype', 'constructor'].includes(segment))) return { found: false };
  let current = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment) || Number(segment) >= current.length) return { found: false };
      current = current[Number(segment)];
      continue;
    }
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return { found: false };
    current = current[segment];
  }
  return { found: true, value: current };
}

function numbersAgree(left, right, tolerance) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  const allowedDifference = tolerance ?? (1e-9 * Math.max(1, Math.abs(left), Math.abs(right)));
  return Number.isFinite(allowedDifference)
    && allowedDifference >= 0
    && Math.abs(left - right) <= allowedDifference;
}

function numericLeaves(value, prefix = '', result = []) {
  if (typeof value === 'number') {
    result.push({ locator: prefix, value });
    return { ok: Number.isFinite(value), entries: result };
  }
  if (!value || typeof value !== 'object') return { ok: false, entries: result };
  const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
  let count = 0;
  for (const [key, item] of entries) {
    const segment = String(key);
    if (!LOCATOR_SEGMENT_PATTERN.test(segment)) return { ok: false, entries: result };
    const nested = numericLeaves(item, prefix ? `${prefix}.${segment}` : segment, result);
    if (!nested.ok) return nested;
    count += 1;
  }
  return { ok: count > 0, entries: result };
}

function analysisSubproblems(contract) {
  return Array.isArray(contract?.subproblems) ? contract.subproblems : [];
}

function validateSubproblemsContract(contract) {
  if (!hasContractVersion(contract)) {
    return failure('SUBPROBLEMS_SCHEMA_VERSION_INVALID', `subproblems.yaml must use schema_version ${ARTIFACT_CONTRACT_VERSION}.`);
  }
  if (!Array.isArray(contract.subproblems) || contract.subproblems.length === 0) {
    return failure('SUBPROBLEMS_EMPTY', 'subproblems.yaml must declare at least one subproblem.');
  }

  const ids = new Set();
  const resultPaths = new Set();
  for (const subproblem of contract.subproblems) {
    if (!isPlainObject(subproblem) || !isStableId(subproblem.id)) {
      return failure('SUBPROBLEMS_ID_INVALID', 'Each subproblem needs a lowercase stable ID of at most 64 characters.');
    }
    if (ids.has(subproblem.id)) {
      return failure('SUBPROBLEMS_DUPLICATE_ID', `Subproblem ID ${subproblem.id} is declared more than once.`);
    }
    ids.add(subproblem.id);
    if (!isNonEmptyText(subproblem.question) || !isNonEmptyText(subproblem.primary_method)) {
      return failure('SUBPROBLEMS_DESCRIPTION_INCOMPLETE', `Subproblem ${subproblem.id} needs a question and primary_method.`);
    }
    if (!isNonEmptyTextList(subproblem.inputs)
      || !isNonEmptyTextList(subproblem.outputs)
      || !isNonEmptyTextList(subproblem.validation_requirements)
      || !Array.isArray(subproblem.depends_on)
      || !subproblem.depends_on.every(isStableId)) {
      return failure('SUBPROBLEMS_FIELDS_INCOMPLETE', `Subproblem ${subproblem.id} has an incomplete input, output, dependency, or validation contract.`);
    }
    if (![...subproblem.inputs, ...subproblem.outputs].every(isSafeArtifactPath)) {
      return failure('SUBPROBLEMS_UNSAFE_PATH', `Subproblem ${subproblem.id} contains a path outside inputs/ or work/.`);
    }
    const declaredResults = subproblem.outputs.filter((value) => RESULT_PATH_PATTERN.test(value));
    if (declaredResults.length !== 1) {
      return failure('SUBPROBLEMS_RESULT_PATH_INVALID', `Subproblem ${subproblem.id} must declare exactly one sub_problem_<n>/results.yaml output.`);
    }
    if (resultPaths.has(declaredResults[0])) {
      return failure('SUBPROBLEMS_DUPLICATE_RESULT_PATH', `Result path ${declaredResults[0]} is assigned to multiple subproblems.`);
    }
    resultPaths.add(declaredResults[0]);
  }

  const byId = new Map(contract.subproblems.map((subproblem) => [subproblem.id, subproblem]));
  for (const subproblem of contract.subproblems) {
    const dependencies = new Set();
    for (const dependency of subproblem.depends_on) {
      if (!byId.has(dependency)) {
        return failure('SUBPROBLEMS_UNKNOWN_DEPENDENCY', `Subproblem ${subproblem.id} depends on unknown ID ${dependency}.`);
      }
      if (dependency === subproblem.id || dependencies.has(dependency)) {
        return failure('SUBPROBLEMS_DEPENDENCY_INVALID', `Subproblem ${subproblem.id} contains a self or duplicate dependency.`);
      }
      dependencies.add(dependency);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dependency of byId.get(id).depends_on) {
      if (!visit(dependency)) return false;
    }
    visiting.delete(id);
    visited.add(id);
    return true;
  }
  if (![...ids].every(visit)) {
    return failure('SUBPROBLEMS_DEPENDENCY_CYCLE', 'Subproblem dependencies must form an acyclic graph.');
  }
  return { ok: true, ids: [...ids], resultPaths: [...resultPaths] };
}

async function artifactPathExists(relative, artifactExists) {
  return typeof artifactExists === 'function' && await artifactExists(relative);
}

async function validateSubproblemInputs(contract, { artifactExists } = {}) {
  const validation = validateSubproblemsContract(contract);
  if (!validation.ok) return validation;
  const byId = new Map(analysisSubproblems(contract).map((subproblem) => [subproblem.id, subproblem]));
  for (const subproblem of analysisSubproblems(contract)) {
    const dependencyOutputs = new Set(subproblem.depends_on.flatMap((dependency) => byId.get(dependency).outputs));
    for (const input of subproblem.inputs) {
      if (input.startsWith('work/') && dependencyOutputs.has(input)) continue;
      if (!await artifactPathExists(input, artifactExists)) {
        return failure('SUBPROBLEMS_INPUT_MISSING', `Declared input ${input} for ${subproblem.id} does not exist.`);
      }
    }
  }
  return { ok: true };
}

async function readStructuredArtifact(relative, artifactReader) {
  if (!STRUCTURED_ARTIFACT_PATTERN.test(relative) || typeof artifactReader !== 'function') return null;
  try {
    const value = await artifactReader(relative);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

async function validateResultsContracts(records, analysisContract, { artifactExists, artifactReader } = {}) {
  const analysisValidation = validateSubproblemsContract(analysisContract);
  if (!analysisValidation.ok) return analysisValidation;
  if (!Array.isArray(records) || records.length === 0) {
    return failure('RESULTS_EMPTY', 'At least one subproblem result contract is required.');
  }

  const declaredById = new Map(analysisSubproblems(analysisContract).map((subproblem) => [
    subproblem.id,
    subproblem.outputs.find((value) => RESULT_PATH_PATTERN.test(value)),
  ]));
  const seenIds = new Set();
  const seenPaths = new Set();
  for (const record of records) {
    if (!isPlainObject(record) || !isSafeArtifactPath(record.relative) || !RESULT_PATH_PATTERN.test(record.relative)) {
      return failure('RESULTS_PATH_INVALID', 'Each results.yaml must be inside a numbered sub_problem_<n> directory.');
    }
    if (seenPaths.has(record.relative)) {
      return failure('RESULTS_DUPLICATE_PATH', `Result file ${record.relative} is listed more than once.`);
    }
    seenPaths.add(record.relative);
    const result = record.value;
    if (!hasContractVersion(result)) {
      return failure('RESULTS_SCHEMA_VERSION_INVALID', `${record.relative} must use schema_version ${ARTIFACT_CONTRACT_VERSION}.`);
    }
    if (!isStableId(result.subproblem_id) || !declaredById.has(result.subproblem_id)) {
      return failure('RESULTS_UNKNOWN_SUBPROBLEM_ID', `${record.relative} references an unknown subproblem ID.`);
    }
    if (seenIds.has(result.subproblem_id)) {
      return failure('RESULTS_DUPLICATE_SUBPROBLEM_ID', `Subproblem ID ${result.subproblem_id} has more than one results.yaml.`);
    }
    seenIds.add(result.subproblem_id);
    if (declaredById.get(result.subproblem_id) !== record.relative) {
      return failure('RESULTS_PATH_MISMATCH', `${result.subproblem_id} was written to a result path not declared by analysis.`);
    }

    if (!isPlainObject(result.metrics) || Object.keys(result.metrics).length === 0) {
      return failure('RESULTS_METRICS_EMPTY', `${record.relative} must contain numeric metrics.`);
    }
    const metrics = inspectNumbers(result.metrics);
    if (!metrics.finite) {
      return failure('RESULTS_NON_FINITE_METRIC', `${record.relative} contains NaN or an infinite metric.`);
    }
    if (metrics.count === 0) {
      return failure('RESULTS_METRICS_EMPTY', `${record.relative} must contain at least one numeric metric.`);
    }

    if (!isNonEmptyTextList(result.artifacts)) {
      return failure('RESULTS_ARTIFACTS_EMPTY', `${record.relative} must list its reproducible artifacts.`);
    }
    for (const artifact of result.artifacts) {
      if (!isSafeArtifactPath(artifact)) {
        return failure('RESULTS_UNSAFE_PATH', `${record.relative} contains an unsafe artifact path.`);
      }
      if (!await artifactPathExists(artifact, artifactExists)) {
        return failure('RESULTS_ARTIFACT_MISSING', `Referenced artifact ${artifact} does not exist.`);
      }
    }
    const resultDirectory = path.posix.dirname(record.relative);
    if (!result.artifacts.includes(record.relative)) {
      return failure('RESULTS_SELF_ARTIFACT_MISSING', `${record.relative} must list itself as a reproducible artifact.`);
    }
    const hasLocalSource = result.artifacts.some((artifact) => artifact.startsWith(`${resultDirectory}/`)
      && ['.py', '.ipynb', '.r', '.m'].includes(path.posix.extname(artifact).toLowerCase()));
    if (!hasLocalSource) {
      return failure('RESULTS_SOURCE_MISSING', `${record.relative} must list an executable source from its own subproblem directory.`);
    }

    if (!isPlainObject(result.validation)
      || result.validation.status !== 'passed'
      || !isNonEmptyText(result.validation.method)
      || !isNonEmptyText(result.validation.summary)) {
      return failure('RESULTS_VALIDATION_INCOMPLETE', `${record.relative} must record a passed validation method and summary.`);
    }
    if (!Array.isArray(result.evidence) || result.evidence.length === 0) {
      return failure('RESULTS_EVIDENCE_EMPTY', `${record.relative} must contain at least one evidence handoff.`);
    }
    for (const evidence of result.evidence) {
      if (!isPlainObject(evidence)
        || !isNonEmptyText(evidence.claim)
        || !isNonEmptyText(evidence.locator)
        || !isSafeArtifactPath(evidence.artifact)) {
        return failure('RESULTS_EVIDENCE_INVALID', `${record.relative} contains incomplete or unsafe evidence.`);
      }
      if (!evidence.artifact.startsWith(`${resultDirectory}/`)) {
        return failure('RESULTS_EVIDENCE_SCOPE_INVALID', `${record.relative} contains evidence owned by another subproblem.`);
      }
      if (!await artifactPathExists(evidence.artifact, artifactExists)) {
        return failure('RESULTS_EVIDENCE_ARTIFACT_MISSING', `Evidence artifact ${evidence.artifact} does not exist.`);
      }
      const evidenceSource = evidence.artifact === record.relative
        ? result
        : await readStructuredArtifact(evidence.artifact, artifactReader);
      const located = resolveLocator(evidenceSource, evidence.locator);
      const locatedValueIsUsable = located.found
        && (Number.isFinite(located.value) || isNonEmptyText(located.value) || typeof located.value === 'boolean');
      if (!locatedValueIsUsable) {
        return failure('RESULTS_EVIDENCE_LOCATOR_INVALID', `Evidence locator ${evidence.locator} in ${record.relative} does not resolve to a scalar YAML/JSON value.`);
      }
    }
  }

  const missing = [...declaredById.keys()].find((id) => !seenIds.has(id));
  if (missing) {
    return failure('RESULTS_SUBPROBLEM_MISSING', `Analysis subproblem ${missing} has no results.yaml.`);
  }
  return {
    ok: true,
    resultPathById: new Map(records.map((record) => [record.value.subproblem_id, record.relative])),
    resultValueById: new Map(records.map((record) => [record.value.subproblem_id, record.value])),
  };
}

async function validateAggregateContract(
  contract,
  analysisContract,
  resultPathById,
  { artifactExists, resultValueById } = {},
) {
  const analysisValidation = validateSubproblemsContract(analysisContract);
  if (!analysisValidation.ok) return analysisValidation;
  if (!hasContractVersion(contract)) {
    return failure('AGGREGATE_SCHEMA_VERSION_INVALID', `aggregate_results.yaml must use schema_version ${ARTIFACT_CONTRACT_VERSION}.`);
  }
  if (!Array.isArray(contract.subproblems) || contract.subproblems.length === 0) {
    return failure('AGGREGATE_SUBPROBLEMS_EMPTY', 'aggregate_results.yaml must contain subproblem summaries.');
  }

  const analysisIds = new Set(analysisSubproblems(analysisContract).map((subproblem) => subproblem.id));
  const seenIds = new Set();
  for (const item of contract.subproblems) {
    if (!isPlainObject(item) || !isStableId(item.id) || !analysisIds.has(item.id)) {
      return failure('AGGREGATE_UNKNOWN_SUBPROBLEM_ID', 'aggregate_results.yaml references an unknown subproblem ID.');
    }
    if (seenIds.has(item.id)) {
      return failure('AGGREGATE_DUPLICATE_SUBPROBLEM_ID', `Aggregate subproblem ID ${item.id} is listed more than once.`);
    }
    seenIds.add(item.id);
    if (!isSafeArtifactPath(item.result_file) || !RESULT_PATH_PATTERN.test(item.result_file)) {
      return failure('AGGREGATE_UNSAFE_PATH', `Aggregate entry ${item.id} has an unsafe result_file.`);
    }
    if (resultPathById?.get(item.id) !== item.result_file) {
      return failure('AGGREGATE_RESULT_PATH_MISMATCH', `Aggregate entry ${item.id} does not reference its validated results.yaml.`);
    }
    if (!await artifactPathExists(item.result_file, artifactExists)) {
      return failure('AGGREGATE_RESULT_MISSING', `Aggregate result file ${item.result_file} does not exist.`);
    }
    if (!isNonEmptyText(item.summary) || !isPlainObject(item.headline_metrics) || Object.keys(item.headline_metrics).length === 0) {
      return failure('AGGREGATE_ENTRY_INCOMPLETE', `Aggregate entry ${item.id} needs a summary and headline metrics.`);
    }
    const metrics = inspectNumbers(item.headline_metrics);
    if (!metrics.finite) {
      return failure('AGGREGATE_NON_FINITE_METRIC', `Aggregate entry ${item.id} contains NaN or an infinite metric.`);
    }
    if (metrics.count === 0) {
      return failure('AGGREGATE_ENTRY_INCOMPLETE', `Aggregate entry ${item.id} needs at least one numeric headline metric.`);
    }
    const headlineLeaves = numericLeaves(item.headline_metrics);
    if (!headlineLeaves.ok) {
      return failure('AGGREGATE_HEADLINE_METRIC_INVALID', `Aggregate entry ${item.id} must contain only finite numeric headline metrics.`);
    }
    const resultMetrics = resultValueById?.get(item.id)?.metrics;
    if (!isPlainObject(resultMetrics)) {
      return failure('AGGREGATE_RESULT_DATA_MISSING', `Validated result metrics for ${item.id} are unavailable.`);
    }
    for (const headline of headlineLeaves.entries) {
      const source = resolveLocator(resultMetrics, headline.locator);
      if (!source.found || typeof source.value !== 'number') {
        return failure('AGGREGATE_HEADLINE_METRIC_SOURCE_MISSING', `Headline metric ${headline.locator} is absent from ${item.id} results.`);
      }
      if (!numbersAgree(headline.value, source.value)) {
        return failure('AGGREGATE_HEADLINE_METRIC_MISMATCH', `Headline metric ${headline.locator} does not match ${item.id} results.`);
      }
    }
  }
  const missing = [...analysisIds].find((id) => !seenIds.has(id));
  if (missing) {
    return failure('AGGREGATE_SUBPROBLEM_MISSING', `Aggregate results omit analysis subproblem ${missing}.`);
  }
  const analysisOrder = analysisSubproblems(analysisContract).map((subproblem) => subproblem.id);
  if (contract.subproblems.some((item, index) => item.id !== analysisOrder[index])) {
    return failure('AGGREGATE_SUBPROBLEM_ORDER_INVALID', 'Aggregate subproblems must follow the analysis contract order.');
  }
  return { ok: true };
}

function isValidDoi(value) {
  if (!isNonEmptyText(value)) return false;
  const normalized = value.trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '');
  return /^10\.\d{4,9}\/[\-._;()/:a-z0-9]+$/i.test(normalized);
}

async function validateEvidenceManifest(
  manifest,
  analysisContract,
  { artifactExists, artifactReader, referencedFigurePaths = [] } = {},
) {
  const analysisValidation = validateSubproblemsContract(analysisContract);
  if (!analysisValidation.ok) return analysisValidation;
  if (!hasContractVersion(manifest)) {
    return failure('EVIDENCE_SCHEMA_VERSION_INVALID', `evidence_manifest.yaml must use schema_version ${ARTIFACT_CONTRACT_VERSION}.`);
  }
  if (!Array.isArray(manifest.evidence) || manifest.evidence.length === 0) {
    return failure('EVIDENCE_EMPTY', 'evidence_manifest.yaml must contain provenance records.');
  }

  const analysisIds = new Set(analysisSubproblems(analysisContract).map((subproblem) => subproblem.id));
  const evidenceIds = new Set();
  const types = new Set();
  const figurePaths = new Set();
  for (const evidence of manifest.evidence) {
    if (!isPlainObject(evidence) || !isStableId(evidence.id)) {
      return failure('EVIDENCE_ID_INVALID', 'Each evidence record needs a lowercase stable ID.');
    }
    if (evidenceIds.has(evidence.id)) {
      return failure('EVIDENCE_DUPLICATE_ID', `Evidence ID ${evidence.id} is declared more than once.`);
    }
    evidenceIds.add(evidence.id);
    if (!EVIDENCE_TYPES.has(evidence.type) || !isNonEmptyText(evidence.claim)) {
      return failure('EVIDENCE_ENTRY_INCOMPLETE', `Evidence ${evidence.id} needs a supported type and nonempty claim.`);
    }
    types.add(evidence.type);
    if (evidence.subproblem_id !== undefined
      && (!isStableId(evidence.subproblem_id) || !analysisIds.has(evidence.subproblem_id))) {
      return failure('EVIDENCE_UNKNOWN_SUBPROBLEM_ID', `Evidence ${evidence.id} references an unknown subproblem ID.`);
    }
    if (!isPlainObject(evidence.source)) {
      return failure('EVIDENCE_SOURCE_INVALID', `Evidence ${evidence.id} needs path or DOI provenance.`);
    }
    const hasPath = isNonEmptyText(evidence.source.path);
    const hasDoi = isNonEmptyText(evidence.source.doi);
    if (hasPath === hasDoi) {
      return failure('EVIDENCE_SOURCE_INVALID', `Evidence ${evidence.id} must contain exactly one source path or DOI.`);
    }
    if (hasPath) {
      if (!isSafeArtifactPath(evidence.source.path)) {
        return failure('EVIDENCE_UNSAFE_PATH', `Evidence ${evidence.id} contains an unsafe source path.`);
      }
      if (!await artifactPathExists(evidence.source.path, artifactExists)) {
        return failure('EVIDENCE_SOURCE_MISSING', `Evidence source ${evidence.source.path} does not exist.`);
      }
    } else if (!isValidDoi(evidence.source.doi)) {
      return failure('EVIDENCE_DOI_INVALID', `Evidence ${evidence.id} contains an invalid DOI.`);
    }

    if (evidence.type === 'numeric') {
      if (typeof evidence.value !== 'number' || !Number.isFinite(evidence.value)) {
        return failure('EVIDENCE_NUMERIC_VALUE_INVALID', `Numeric evidence ${evidence.id} needs a finite value.`);
      }
      if (!hasPath || !STRUCTURED_ARTIFACT_PATTERN.test(evidence.source.path)) {
        return failure('EVIDENCE_NUMERIC_SOURCE_UNSUPPORTED', `Numeric evidence ${evidence.id} must use a YAML or JSON source path.`);
      }
      if (!isNonEmptyText(evidence.source.locator)) {
        return failure('EVIDENCE_LOCATOR_MISSING', `Numeric evidence ${evidence.id} needs a source locator.`);
      }
      if (evidence.tolerance !== undefined
        && (typeof evidence.tolerance !== 'number'
          || !Number.isFinite(evidence.tolerance)
          || evidence.tolerance < 0)) {
        return failure('EVIDENCE_TOLERANCE_INVALID', `Numeric evidence ${evidence.id} has an invalid absolute tolerance.`);
      }
      const sourceDocument = await readStructuredArtifact(evidence.source.path, artifactReader);
      const sourceValue = resolveLocator(sourceDocument, evidence.source.locator);
      if (!sourceValue.found || typeof sourceValue.value !== 'number' || !Number.isFinite(sourceValue.value)) {
        return failure('EVIDENCE_LOCATOR_INVALID', `Numeric evidence ${evidence.id} locator does not resolve to a finite YAML/JSON number.`);
      }
      if (!numbersAgree(evidence.value, sourceValue.value, evidence.tolerance)) {
        return failure('EVIDENCE_NUMERIC_VALUE_MISMATCH', `Numeric evidence ${evidence.id} does not match its source value.`);
      }
    }
    if (evidence.type === 'figure') {
      if (!hasPath || !/\.(?:pdf|png|jpe?g|webp)$/i.test(evidence.source.path)) {
        return failure('EVIDENCE_FIGURE_SOURCE_INVALID', `Figure evidence ${evidence.id} needs an existing figure path.`);
      }
      figurePaths.add(evidence.source.path);
    }
  }

  if (!types.has('numeric')) {
    return failure('EVIDENCE_NUMERIC_MISSING', 'The evidence manifest needs at least one core numeric claim.');
  }
  if (!types.has('citation')) {
    return failure('EVIDENCE_CITATION_MISSING', 'The evidence manifest needs at least one citation provenance record.');
  }
  const unmappedFigure = referencedFigurePaths.find((relative) => !figurePaths.has(relative));
  if (unmappedFigure) {
    return failure('EVIDENCE_FIGURE_UNMAPPED', `Referenced figure ${unmappedFigure} is absent from the evidence manifest.`);
  }
  return { ok: true };
}

module.exports = {
  isSafeArtifactPath,
  isValidDoi,
  numbersAgree,
  resolveLocator,
  validateAggregateContract,
  validateEvidenceManifest,
  validateResultsContracts,
  validateSubproblemInputs,
  validateSubproblemsContract,
};
