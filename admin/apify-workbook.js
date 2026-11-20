const MAX_WORKBOOK_BYTES = 10 * 1024 * 1024;
const MAX_XML_BYTES = 16 * 1024 * 1024;
const PACKAGE_ORIGIN = "https://workbook.invalid";
const WORKBOOK_PART = "xl/workbook.xml";
const utf8 = new TextDecoder("utf-8", { fatal: true });
const EXCEL_NUMBER = /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
import { discoveryIdentity } from "../shared/discovery-identity.js?v=20261120-daily-1";

export const REVIEW_FIELDS = [
  { name: "Title (internal)", label: "Event title", wide: true },
  { name: "StartDate", label: "Start date", type: "date" },
  { name: "StartTime", label: "Start time", type: "time" },
  { name: "EndDate", label: "End date", type: "date" },
  { name: "EndTime", label: "End time", type: "time" },
  { name: "Timezone", label: "Time zone" },
  { name: "ExplicitQueer (Yes/No)", label: "Explicitly queer", type: "yes-no" },
  { name: "Location", label: "Location", wide: true },
  { name: "Description", label: "Description", type: "textarea", wide: true },
  { name: "Lineup_Raw", label: "Lineup", type: "textarea", wide: true },
  { name: "Instagram_URL", label: "Open Instagram post", type: "link" },
  { name: "Event_URL", label: "Open event link", type: "link" },
  { name: "RawFlyerURL", label: "Open flyer image", type: "link" },
  { name: "Review_notes", label: "Review notes", type: "textarea", wide: true }
];

const CORRECTION_FIELDS = [
  "Date", "Current title", "Correction", "Venue", "Instagram source",
  "Apply to existing event only", "Suggested Description", "RawFlyerURL", "Public listing",
  "Suggested StartDate", "Suggested StartTime", "Suggested EndDate", "Suggested EndTime",
  "Suggested Lineup_Raw"
];

function zipDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const short = offset => view.getUint16(offset, true);
  const long = offset => view.getUint32(offset, true);
  const badZip = () => new Error("This file could not be read as an Excel .xlsx workbook.");
  let end = bytes.length - 22;

  for (; end >= Math.max(0, bytes.length - 65557); end--) {
    if (long(end) === 0x06054b50 && end + 22 + short(end + 20) === bytes.length) break;
  }
  if (end < Math.max(0, bytes.length - 65557) || short(end + 4) || short(end + 6)) throw badZip();

  const count = short(end + 10);
  const start = long(end + 16);
  const limit = start + long(end + 12);
  if (limit > end) throw badZip();
  let cursor = start;
  const entries = new Map();

  for (let i = 0; i < count; i++) {
    if (cursor + 46 > limit || long(cursor) !== 0x02014b50) throw badZip();
    const nameStart = cursor + 46;
    const nameEnd = nameStart + short(cursor + 28);
    const next = nameEnd + short(cursor + 30) + short(cursor + 32);
    if (next > limit) throw badZip();
    const name = utf8.decode(bytes.subarray(nameStart, nameEnd));
    entries.set(name, {
      flags: short(cursor + 8),
      method: short(cursor + 10),
      compressedSize: long(cursor + 20),
      size: long(cursor + 24),
      offset: long(cursor + 42)
    });
    cursor = next;
  }

  return async function readPart(name) {
    const entry = entries.get(name);
    if (!entry) return null;
    const { flags, method, compressedSize, size, offset } = entry;
    if ((flags & 1) || size > MAX_XML_BYTES || offset + 30 > start || long(offset) !== 0x04034b50) {
      throw badZip();
    }
    const dataStart = offset + 30 + short(offset + 26) + short(offset + 28);
    if (dataStart + compressedSize > start) throw badZip();
    const data = bytes.subarray(dataStart, dataStart + compressedSize);

    if (method === 0 && data.length === size) return utf8.decode(data);
    if (method !== 8) throw badZip();

    let inflater;
    try {
      inflater = new DecompressionStream("deflate-raw");
    } catch {
      throw new Error("This browser cannot open .xlsx files. Try an updated Safari, Chrome, or Firefox.");
    }

    const reader = new Blob([data]).stream().pipeThrough(inflater).getReader();
    const expanded = new Uint8Array(size);
    let written = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (written + value.length > size) throw badZip();
        expanded.set(value, written);
        written += value.length;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (written !== size) throw badZip();
    return utf8.decode(expanded);
  };
}

function nodes(root, name) {
  return Array.from(root.getElementsByTagNameNS("*", name));
}

function xml(text, part) {
  if (text == null) throw new Error("The workbook is missing " + part + ".");
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (nodes(document, "parsererror").length) {
    throw new Error("Excel data could not be read from " + part + ".");
  }
  return document;
}

function partPath(target) {
  const url = new URL(target, PACKAGE_ORIGIN + "/" + WORKBOOK_PART);
  if (url.origin !== PACKAGE_ORIGIN) {
    throw new Error("A review tab points outside this workbook.");
  }
  return decodeURIComponent(url.pathname.slice(1));
}

function richText(root) {
  return nodes(root, "t")
    .filter(node => node.parentNode.localName !== "rPh")
    .map(node => node.textContent)
    .join("");
}

function sheetRows(document, strings) {
  return nodes(document, "row").map((row, index) => {
    const cells = [];
    let column = 0;
    for (const cell of nodes(row, "c")) {
      const address = /^[A-Z]+/.exec(cell.getAttribute("r") || "");
      if (address) {
        column = [...address[0]].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0) - 1;
      }
      const type = cell.getAttribute("t");
      const value = nodes(cell, "v")[0]?.textContent ?? "";
      cells[column++] = type === "s" ? (strings[Number(value)] ?? "")
        : type === "inlineStr" ? richText(cell)
        : type === "b" ? (value === "1" ? "Yes" : "No")
        : type === "e" ? "" : value;
    }
    return { cells, rowNumber: row.getAttribute("r") || String(index + 1) };
  });
}

function headerKey(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function readTable(rows, expected, required, name) {
  const nonempty = rows.filter(row => row.cells.some(value => value.trim()));
  if (!nonempty.length) return [];

  const positions = new Map(nonempty[0].cells.flatMap((value, i) =>
    value ? [[headerKey(value), i]] : []
  ));
  const missing = required.filter(field => !positions.has(headerKey(field)));
  if (missing.length) {
    throw new Error(name + " is missing the " + missing.join(", ") + " column.");
  }

  return nonempty.slice(1).map(row => ({
    rowNumber: row.rowNumber,
    values: Object.fromEntries(expected.map(field => [
      field, (row.cells[positions.get(headerKey(field))] ?? "").trim()
    ]))
  }));
}

function formattedDate(value, date1904) {
  const number = Number(value);
  if (EXCEL_NUMBER.test(value) && Number.isFinite(number)) {
    const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
    const date = new Date(base + Math.floor(number) * 86400000);
    return Number.isFinite(+date) ? date.toISOString().split("T")[0] : value;
  }
  const iso = /^(\d{4}-\d{2}-\d{2})(?:$|T|\s)/.exec(value);
  if (iso) return iso[1];
  const local = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!local) return value;
  return [local[3], local[1].padStart(2, "0"), local[2].padStart(2, "0")].join("-");
}

function formattedTime(value) {
  const number = Number(value);
  if (EXCEL_NUMBER.test(value) && Number.isFinite(number)) {
    const seconds = Math.round((number % 1) * 86400) % 86400;
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
      .map(part => String(part).padStart(2, "0")).join(":");
  }
  const time = /^(?:\d{4}-\d{2}-\d{2}[T ])?(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(AM|PM)?$/i.exec(value);
  if (!time) return value;
  const [, hour, minute, second = "00", meridiem] = time;
  const h = meridiem ? Number(hour) % 12 + (meridiem.toLowerCase() === "pm" ? 12 : 0) : Number(hour);
  return [String(h).padStart(2, "0"), minute, second].join(":");
}

function candidates(rows, workbookKey, date1904) {
  const names = REVIEW_FIELDS.map(field => field.name).concat(["Review", "Import readiness", "ImportSourceKey", "ImportSourceSnapshot"]);
  return readTable(rows, names, ["Title (internal)", "StartDate"], "New events")
    .filter(row => row.values["Title (internal)"])
    .map(({ rowNumber, values }) => {
      const fields = {};
      for (const { name, type } of REVIEW_FIELDS) {
        let value = values[name];
        if (type === "date") value = formattedDate(value, date1904);
        if (type === "time") value = formattedTime(value);
        if (type === "yes-no" && /^(yes|no)$/i.test(value)) {
          value = value[0].toUpperCase() + value.slice(1).toLowerCase();
        }
        fields[name] = value;
      }
      return {
        key: workbookKey + ":" + rowNumber,
        fields,
        suggestion: values.Review,
        readiness: values["Import readiness"],
        identityFields: { ...fields, ImportSourceKey: values.ImportSourceKey, ImportSourceSnapshot: values.ImportSourceSnapshot },
        decision: "WAIT",
        decisionDirty: false,
        saved: false
      };
    });
}

function corrections(rows, workbookKey, date1904) {
  return readTable(rows, CORRECTION_FIELDS, ["Current title", "Correction"], "Corrections")
    .filter(row => row.values["Current title"])
    .map(({ rowNumber, values }) => {
      values.intakeKey = workbookKey + ":" + rowNumber;
      for (const name of ["Date", "Suggested StartDate", "Suggested EndDate"]) {
        values[name] = formattedDate(values[name], date1904);
      }
      for (const name of ["Suggested StartTime", "Suggested EndTime"]) {
        values[name] = formattedTime(values[name]);
      }
      return values;
    });
}

export async function readScrapeWorkbook(file) {
  if (file.size > MAX_WORKBOOK_BYTES) throw new Error("Choose a scrape workbook under 10 MB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const read = zipDirectory(bytes);
  const workbook = xml(await read(WORKBOOK_PART), "workbook.xml");
  const linksPart = "xl/_rels/workbook.xml.rels";
  const links = nodes(xml(await read(linksPart), linksPart), "Relationship");
  const tabs = nodes(workbook, "sheet");
  const date1904 = /^(1|true)$/i.test(nodes(workbook, "workbookPr")[0]?.getAttribute("date1904") || "");
  const sharedStrings = links.find(link => link.getAttribute("Type")?.endsWith("/sharedStrings"));
  const stringPart = sharedStrings ? partPath(sharedStrings.getAttribute("Target")) : "xl/sharedStrings.xml";
  const stringText = await read(stringPart);
  const strings = stringText ? nodes(xml(stringText, stringPart), "si").map(richText) : [];

  async function readTab(name) {
    const tab = tabs.find(item => headerKey(item.getAttribute("name")) === headerKey(name));
    if (!tab) return null;
    const id = tab.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id")
      || tab.getAttribute("r:id");
    const link = links.find(item => item.getAttribute("Id") === id);
    if (!link || link.getAttribute("TargetMode") === "External") {
      throw new Error("The " + name + " tab has no worksheet data.");
    }
    const part = partPath(link.getAttribute("Target"));
    return sheetRows(xml(await read(part), part), strings);
  }

  const [newRows, correctionRows] = await Promise.all([readTab("New events"), readTab("Corrections")]);
  if (!newRows && !correctionRows) throw new Error("Choose a QDP workbook with a New events or Corrections tab.");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const workbookKey = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  const result = {
    candidates: candidates(newRows ?? [], workbookKey, date1904),
    corrections: corrections(correctionRows ?? [], workbookKey, date1904)
  };
  for (const candidate of result.candidates) candidate.discovery = await discoveryIdentity(candidate.identityFields);
  for (const correction of result.corrections) {
    const fields = { StartDate: correction.Date, Location: correction.Venue,
      "Title (internal)": correction["Current title"], Instagram_URL: correction["Instagram source"] };
    correction.discovery = await discoveryIdentity(fields, "correction", JSON.stringify([
      correction.Correction, correction["Suggested Description"], correction["Suggested StartDate"],
      correction["Suggested StartTime"], correction["Suggested EndDate"], correction["Suggested EndTime"],
      correction["Suggested Lineup_Raw"] || ""
    ]));
    correction.decision = "WAIT";
  }
  return result;
}
