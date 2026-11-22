import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

function typed(value, header) {
  if (!value) return "";
  if (/(?:^Date$|Date$)/.test(header) && /^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(value + "T00:00:00Z");
  if (/Time$/.test(header)) {
    const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
    if (match) return (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] || 0)) / 86400;
  }
  return typeof value === "string" && value.startsWith("=") ? "'" + value : value;
}

export async function exportWorkbook(payload, output, template) {
  const require = createRequire(import.meta.url);
  const modulePath = require.resolve("@oai/artifact-tool", {paths: [process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean)});
  const { Workbook, SpreadsheetFile, FileBlob } = await import(pathToFileURL(modulePath).href);
  const workbook = template ? await SpreadsheetFile.importXlsx(await FileBlob.load(template)) : Workbook.create();
  const instructions = [
    ["Step", "Instructions"],
    ["1", "Upload the latest daily Excel on Admin → Apify Import. It includes unresolved future events from earlier days."],
    ["2", "Choose Include, Wait or Exclude, then Save decisions and included events. Wait adds nothing and carries forward. Exclude suppresses that edition in future reviews. Saved choices sync automatically through the Apps Script decision ledger."],
    ["3", "Include saves selected events to Apify Import. Use the existing import rows + flyers, Calendar creation and Pull workflow."],
    ["4", "For Corrections, choose Include, select only the fields to change, and save the correction. Apply it to the existing event through the usual sheet workflow."],
    ["5", "Confirmed Include receipts and Exclude choices retire items from the pending review. Failed saves remain pending. Downloading a file does not mark it imported."],
    ["Flyers", "Source image URLs can expire. Saved Drive copies depend on your existing flyer helper."],
    ["Compatibility", "Spreadsheet paste remains supported: copy complete A:AQ rows with blanks intact. Save Wait/Exclude in Admin; the next daily review reads those choices automatically. No manual feedback export is needed."],
    ["Coverage", "The normal public-calendar comparison remains. No extra Calendar/index reconciliation or automatic publishing is performed."]
  ];
  const tables = [
    ["New events", [payload.headers, ...payload.rows]],
    ["Corrections", [payload.correctionHeaders, ...payload.corrections.map(row => payload.correctionHeaders.map(header => row[header] || ""))]],
    ["How to use", instructions],
    ["Coverage", [["Metric", "Value"], ...Object.entries(payload.coverage).map(([key, value]) => [key, typeof value === "object" ? JSON.stringify(value) : value])]]
  ];
  for (const [name, rows] of tables) {
    let sheet;
    try { sheet = workbook.worksheets.getItem(name); } catch { /* New workbook. */ }
    sheet ||= workbook.worksheets.add(name);
    sheet.getUsedRange()?.clear({applyTo: "contents"});
    const width = rows[0].length;
    const values = rows.map((row, index) => Array.from({length: width}, (_, column) => index ? typed(row[column] ?? "", rows[0][column]) : row[column]));
    const range = sheet.getRangeByIndexes(0, 0, rows.length, width);
    range.values = values;
    range.format.font = {name: "Arial", size: 11};
    range.format.wrapText = true;
    range.format.verticalAlignment = "top";
    sheet.freezePanes.freezeRows(1);
    if (!template) {
      range.format.columnWidth = 20;
      sheet.getRangeByIndexes(0, 0, 1, width).format = {fill: "#34102c", font: {bold: true, color: "#ffffff"}, rowHeight: 42, wrapText: true};
      if (width === 2) sheet.getRangeByIndexes(0, 1, rows.length, 1).format.columnWidth = 95;
    }
    if (rows.length > 1) for (let column = 0; column < width; column++) {
      const cells = sheet.getRangeByIndexes(1, column, rows.length - 1, 1);
      if (/Date$/.test(rows[0][column])) cells.setNumberFormat("mm/dd/yy");
      if (/Time$/.test(rows[0][column])) cells.setNumberFormat("h:mm AM/PM");
    }
  }
  workbook.recalculate();
  await fs.mkdir(path.dirname(output), {recursive: true});
  const exported = await SpreadsheetFile.exportXlsx(workbook);
  await exported.save(output);
  return workbook;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, index, all) => arg.startsWith("--") ? [...pairs, [arg.slice(2), all[index + 1]]] : pairs, []));
  const payload = JSON.parse(await fs.readFile(args.payload, "utf8"));
  await exportWorkbook(payload, args.output, args.template);
  console.log(JSON.stringify({output: args.output,events: payload.rows.length,corrections: payload.corrections.length}));
}
