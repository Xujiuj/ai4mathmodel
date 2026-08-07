const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateAggregateContract,
  validateEvidenceManifest,
  validateResultsContracts,
  validateSubproblemInputs,
  validateSubproblemsContract,
} = require('../electron/supervisor/artifact-contracts.cjs');

const subproblemsContract = () => ({
  schema_version: 1,
  subproblems: [
    {
      id: 'sp-1',
      question: 'Estimate the demand response under the stated constraints.',
      inputs: ['inputs/problem/demand.csv'],
      outputs: ['work/02_solving/sub_problem_1/results.yaml'],
      depends_on: [],
      primary_method: 'Constrained regression with a baseline comparison.',
      validation_requirements: ['Holdout error and residual diagnostics must pass.'],
    },
    {
      id: 'sp-2',
      question: 'Optimize the allocation using the estimated demand response.',
      inputs: ['work/02_solving/sub_problem_1/results.yaml'],
      outputs: ['work/02_solving/sub_problem_2/results.yaml'],
      depends_on: ['sp-1'],
      primary_method: 'Mixed-integer optimization with scenario stress tests.',
      validation_requirements: ['All constraints and stress scenarios must pass.'],
    },
  ],
});

const resultRecord = (id, index) => ({
  relative: `work/02_solving/sub_problem_${index}/results.yaml`,
  value: {
    schema_version: 1,
    subproblem_id: id,
    metrics: { score: 0.8 + index / 100, error: 0.1 },
    artifacts: [
      `work/02_solving/sub_problem_${index}/solver.py`,
      `work/02_solving/sub_problem_${index}/results.yaml`,
    ],
    validation: {
      status: 'passed',
      method: 'holdout and stress testing',
      summary: 'The model passed the declared validation requirements.',
    },
    evidence: [{
      claim: `Core score for ${id}.`,
      artifact: `work/02_solving/sub_problem_${index}/results.yaml`,
      locator: 'metrics.score',
    }],
  },
});

const artifactExists = async () => true;

test('subproblem contract rejects duplicate IDs, unknown dependencies, cycles, and unsafe paths', async (context) => {
  const duplicate = subproblemsContract();
  duplicate.subproblems[1].id = 'sp-1';
  assert.equal(validateSubproblemsContract(duplicate).code, 'SUBPROBLEMS_DUPLICATE_ID');

  const unknownDependency = subproblemsContract();
  unknownDependency.subproblems[1].depends_on = ['sp-404'];
  assert.equal(validateSubproblemsContract(unknownDependency).code, 'SUBPROBLEMS_UNKNOWN_DEPENDENCY');

  const cycle = subproblemsContract();
  cycle.subproblems[0].depends_on = ['sp-2'];
  assert.equal(validateSubproblemsContract(cycle).code, 'SUBPROBLEMS_DEPENDENCY_CYCLE');

  const unsafe = subproblemsContract();
  unsafe.subproblems[0].inputs = ['work/../../secrets.txt'];
  assert.equal(validateSubproblemsContract(unsafe).code, 'SUBPROBLEMS_UNSAFE_PATH');

  const alternateDataStream = subproblemsContract();
  alternateDataStream.subproblems[0].inputs = ['work/results.yaml:private'];
  assert.equal(validateSubproblemsContract(alternateDataStream).code, 'SUBPROBLEMS_UNSAFE_PATH');

  const internalSnapshot = subproblemsContract();
  internalSnapshot.subproblems[0].inputs = ['work/.staging/other-run/01_analysis/analysis.md'];
  assert.equal(validateSubproblemsContract(internalSnapshot).code, 'SUBPROBLEMS_UNSAFE_PATH');

  await context.test('accepts a complete acyclic contract', () => {
    assert.equal(validateSubproblemsContract(subproblemsContract()).ok, true);
  });

  await context.test('requires declared raw inputs to exist', async () => {
    const missing = await validateSubproblemInputs(subproblemsContract(), {
      artifactExists: async () => false,
    });
    assert.equal(missing.code, 'SUBPROBLEMS_INPUT_MISSING');

    const valid = await validateSubproblemInputs(subproblemsContract(), {
      artifactExists: async (relative) => relative === 'inputs/problem/demand.csv',
    });
    assert.equal(valid.ok, true);
  });
});

test('result contracts require exactly one validated evidence handoff per analysis ID', async () => {
  const analysis = subproblemsContract();
  const records = [resultRecord('sp-1', 1), resultRecord('sp-2', 2)];
  assert.equal((await validateResultsContracts(records, analysis, { artifactExists })).ok, true);

  const duplicate = [resultRecord('sp-1', 1), resultRecord('sp-1', 2)];
  assert.equal((await validateResultsContracts(duplicate, analysis, { artifactExists })).code, 'RESULTS_DUPLICATE_SUBPROBLEM_ID');

  const missing = [resultRecord('sp-1', 1)];
  assert.equal((await validateResultsContracts(missing, analysis, { artifactExists })).code, 'RESULTS_SUBPROBLEM_MISSING');

  const nonFinite = [resultRecord('sp-1', 1), resultRecord('sp-2', 2)];
  nonFinite[0].value.metrics.score = Number.NaN;
  assert.equal((await validateResultsContracts(nonFinite, analysis, { artifactExists })).code, 'RESULTS_NON_FINITE_METRIC');

  const emptyEvidence = [resultRecord('sp-1', 1), resultRecord('sp-2', 2)];
  emptyEvidence[0].value.evidence = [];
  assert.equal((await validateResultsContracts(emptyEvidence, analysis, { artifactExists })).code, 'RESULTS_EVIDENCE_EMPTY');

  const borrowedSource = [resultRecord('sp-1', 1), resultRecord('sp-2', 2)];
  borrowedSource[0].value.artifacts = [
    'work/02_solving/sub_problem_1/results.yaml',
    'work/02_solving/sub_problem_2/solver.py',
  ];
  assert.equal((await validateResultsContracts(borrowedSource, analysis, { artifactExists })).code, 'RESULTS_SOURCE_MISSING');

  const bogusLocator = [resultRecord('sp-1', 1), resultRecord('sp-2', 2)];
  bogusLocator[0].value.evidence[0].locator = 'metrics.not_present';
  assert.equal((await validateResultsContracts(bogusLocator, analysis, { artifactExists })).code, 'RESULTS_EVIDENCE_LOCATOR_INVALID');
});

test('aggregate contract references every result ID exactly once', async () => {
  const analysis = subproblemsContract();
  const resultPaths = new Map([
    ['sp-1', 'work/02_solving/sub_problem_1/results.yaml'],
    ['sp-2', 'work/02_solving/sub_problem_2/results.yaml'],
  ]);
  const resultValues = new Map([
    ['sp-1', resultRecord('sp-1', 1).value],
    ['sp-2', resultRecord('sp-2', 2).value],
  ]);
  const aggregate = {
    schema_version: 1,
    subproblems: [
      {
        id: 'sp-1',
        result_file: resultPaths.get('sp-1'),
        summary: 'Demand response estimates passed holdout validation.',
        headline_metrics: { score: 0.81 },
      },
      {
        id: 'sp-2',
        result_file: resultPaths.get('sp-2'),
        summary: 'Allocation remained feasible under stress scenarios.',
        headline_metrics: { score: 0.82 },
      },
    ],
  };
  const options = { artifactExists, resultValueById: resultValues };
  assert.equal((await validateAggregateContract(aggregate, analysis, resultPaths, options)).ok, true);

  const duplicate = structuredClone(aggregate);
  duplicate.subproblems[1].id = 'sp-1';
  assert.equal((await validateAggregateContract(duplicate, analysis, resultPaths, options)).code, 'AGGREGATE_DUPLICATE_SUBPROBLEM_ID');

  const unknown = structuredClone(aggregate);
  unknown.subproblems[1].id = 'sp-404';
  assert.equal((await validateAggregateContract(unknown, analysis, resultPaths, options)).code, 'AGGREGATE_UNKNOWN_SUBPROBLEM_ID');

  const missing = structuredClone(aggregate);
  missing.subproblems.pop();
  assert.equal((await validateAggregateContract(missing, analysis, resultPaths, options)).code, 'AGGREGATE_SUBPROBLEM_MISSING');

  const reordered = structuredClone(aggregate);
  reordered.subproblems.reverse();
  assert.equal((await validateAggregateContract(reordered, analysis, resultPaths, options)).code, 'AGGREGATE_SUBPROBLEM_ORDER_INVALID');

  const mismatch = structuredClone(aggregate);
  mismatch.subproblems[0].headline_metrics.score = 999;
  assert.equal((await validateAggregateContract(mismatch, analysis, resultPaths, options)).code, 'AGGREGATE_HEADLINE_METRIC_MISMATCH');
});

test('evidence manifest rejects broken provenance and maps every referenced figure', async () => {
  const analysis = subproblemsContract();
  const manifest = {
    schema_version: 1,
    evidence: [
      {
        id: 'ev-score',
        type: 'numeric',
        claim: 'The holdout score is 0.81.',
        subproblem_id: 'sp-1',
        value: 0.81,
        source: {
          path: 'work/02_solving/sub_problem_1/results.yaml',
          locator: 'metrics.score',
        },
      },
      {
        id: 'ev-figure',
        type: 'figure',
        claim: 'The overview figure visualizes the validated allocation.',
        subproblem_id: 'sp-2',
        source: { path: 'work/03_paper/figures/overview.png' },
      },
      {
        id: 'ev-citation',
        type: 'citation',
        claim: 'The optimization method follows a peer-reviewed source.',
        source: { doi: '10.1000/example.2026.1' },
      },
    ],
  };
  const options = {
    artifactExists,
    artifactReader: async (relative) => relative === 'work/02_solving/sub_problem_1/results.yaml'
      ? { metrics: { score: 0.81 } }
      : null,
    referencedFigurePaths: ['work/03_paper/figures/overview.png'],
  };
  assert.equal((await validateEvidenceManifest(manifest, analysis, options)).ok, true);

  const duplicate = structuredClone(manifest);
  duplicate.evidence[1].id = 'ev-score';
  assert.equal((await validateEvidenceManifest(duplicate, analysis, options)).code, 'EVIDENCE_DUPLICATE_ID');

  const unknownSubproblem = structuredClone(manifest);
  unknownSubproblem.evidence[0].subproblem_id = 'sp-404';
  assert.equal((await validateEvidenceManifest(unknownSubproblem, analysis, options)).code, 'EVIDENCE_UNKNOWN_SUBPROBLEM_ID');

  const unsafePath = structuredClone(manifest);
  unsafePath.evidence[0].source.path = '../private/results.yaml';
  assert.equal((await validateEvidenceManifest(unsafePath, analysis, options)).code, 'EVIDENCE_UNSAFE_PATH');

  const invalidDoi = structuredClone(manifest);
  invalidDoi.evidence[2].source.doi = 'example-doi';
  assert.equal((await validateEvidenceManifest(invalidDoi, analysis, options)).code, 'EVIDENCE_DOI_INVALID');

  const unmappedFigure = structuredClone(manifest);
  unmappedFigure.evidence = unmappedFigure.evidence.filter((item) => item.type !== 'figure');
  assert.equal((await validateEvidenceManifest(unmappedFigure, analysis, options)).code, 'EVIDENCE_FIGURE_UNMAPPED');

  const mismatch = structuredClone(manifest);
  mismatch.evidence[0].value = 999;
  assert.equal((await validateEvidenceManifest(mismatch, analysis, options)).code, 'EVIDENCE_NUMERIC_VALUE_MISMATCH');

  const tolerated = structuredClone(manifest);
  tolerated.evidence[0].value = 0.8105;
  tolerated.evidence[0].tolerance = 0.001;
  assert.equal((await validateEvidenceManifest(tolerated, analysis, options)).ok, true);
});
