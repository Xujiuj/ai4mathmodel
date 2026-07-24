const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const ExcelJS = require('exceljs');

const workerPath = path.resolve(
  __dirname,
  '..',
  process.env.SPREADSHEET_WORKER_PATH || path.join('electron', 'workers', 'spreadsheet-worker.cjs'),
);

function parseInWorker(target) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, {
      workerData: {
        target,
        extension: path.extname(target).toLowerCase(),
        rowLimit: 20,
        columnLimit: 10,
        sheetLimit: 4,
      },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Spreadsheet worker exited with code ${code}.`));
    });
  });
}

test('parses a real XLSX workbook in the isolated ExcelJS worker', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'modeling-xlsx-worker-'));
  const target = path.join(directory, 'results.xlsx');
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('实验结果');
  sheet.addRows([
    ['方案', '准确率', '备注'],
    ['基线', 0.73, '可复核'],
    ['改进模型', 0.86, { formula: 'B3-B2', result: 0.13 }],
  ]);
  await workbook.xlsx.writeFile(target);

  const result = await parseInWorker(target);

  assert.equal(result.ok, true);
  assert.equal(result.value.name, 'results.xlsx');
  assert.equal(result.value.sheets[0].name, '实验结果');
  assert.deepEqual(result.value.sheets[0].rows[0], ['方案', '准确率', '备注']);
  assert.equal(result.value.sheets[0].rows[2][0], '改进模型');
  assert.equal(result.value.sheets[0].rows[2][2], '0.13');
});
