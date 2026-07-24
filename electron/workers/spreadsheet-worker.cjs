const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
const ExcelJS = require('exceljs');

function cellText(cell) {
  const text = String(cell?.text ?? '');
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, 10_000);
}

async function parseWorkbook() {
  const { target, extension, rowLimit, columnLimit, sheetLimit } = workerData;
  const workbook = new ExcelJS.Workbook();
  workbook.calcProperties.fullCalcOnLoad = false;
  if (extension === '.csv') await workbook.csv.readFile(target);
  else await workbook.xlsx.readFile(target, { ignoreNodes: ['dataValidations', 'extLst', 'picture'] });

  const worksheets = workbook.worksheets.slice(0, sheetLimit);
  const sheets = worksheets.map((worksheet, sheetIndex) => {
    const totalRows = Math.max(0, worksheet.actualRowCount || worksheet.rowCount || 0);
    const totalColumns = Math.max(0, worksheet.actualColumnCount || worksheet.columnCount || 0);
    const rowCount = Math.min(totalRows, rowLimit);
    const columnCount = Math.min(totalColumns, columnLimit);
    const rows = [];
    for (let rowIndex = 1; rowIndex <= rowCount; rowIndex += 1) {
      const row = worksheet.getRow(rowIndex);
      const values = [];
      for (let columnIndex = 1; columnIndex <= columnCount; columnIndex += 1) {
        values.push(cellText(row.getCell(columnIndex)));
      }
      rows.push(values);
    }
    return {
      name: String(worksheet.name || `Sheet ${sheetIndex + 1}`).slice(0, 120),
      rows,
      totalRows,
      totalColumns,
      truncated: totalRows > rowCount || totalColumns > columnCount,
    };
  });
  return {
    name: path.basename(target),
    extension,
    sheets,
    truncatedSheets: workbook.worksheets.length > sheets.length,
    limits: { rows: rowLimit, columns: columnLimit },
  };
}

parseWorkbook()
  .then((value) => parentPort.postMessage({ ok: true, value }))
  .catch(() => parentPort.postMessage({ ok: false, error: '表格文件无法安全解析。' }));
