import fs from "node:fs";
import vm from "node:vm";
import { createHash, randomUUID } from "node:crypto";

const source = fs.readFileSync(new URL("../../apps-script/DiscoveryDecisions.gs", import.meta.url), "utf8");
export function discoveryFixture({ coreSource } = {}) {
  const tables = new Map(), props = new Map([["QDP_DISCOVERY_READ_TOKEN", "a".repeat(64)]]);
  let sheetReads = 0, sheetWrites = 0, locks = 0, locked = false;
  class Sheet {
    constructor() { this.rows = []; this.capacity = 1000; }
    getLastRow() { return this.rows.length; }
    getMaxRows() { return this.capacity; }
    insertRowsAfter(row, count) { this.capacity += count; }
    setFrozenRows() {}
    getRange(row, column, height, width) {
      const sheet = this;
      return {
        getValues() { sheetReads++; return Array.from({ length: height }, (_, i) =>
          Array.from({ length: width }, (_, j) => sheet.rows[row + i - 1]?.[column + j - 1] ?? "")); },
        setNumberFormat() { return this; },
        setValues(values) { sheetWrites++; values.forEach((valuesRow, i) => {
          sheet.rows[row + i - 1] ||= [];
          valuesRow.forEach((value, j) => { sheet.rows[row + i - 1][column + j - 1] = value; });
        }); return this; }
      };
    }
  }
  const context = vm.createContext({ console: { error() {} }, Date, Map, Set, JSON, String, Object, Array, Number, Math, RegExp,
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => props.get(key), setProperty: (key, value) => props.set(key, value) }) },
    ss_: () => ({ getSheetByName: name => {
      if (name !== "QDP_Discovery_Decisions") throw new Error("Decision reads must not access Calendar/index sheets");
      return tables.get(name);
    }, insertSheet: name => { const sheet = new Sheet(); tables.set(name, sheet); return sheet; } }),
    SpreadsheetApp: { flush() {} },
    qdpWithWriteLock_: work => { if (locked) throw new Error("Nested lock"); locked = true; locks++;
      try { return work(); } finally { locked = false; } },
    qdpFlyerSafeEqual_: (a, b) => typeof a === "string" && a === b,
    Utilities: { DigestAlgorithm: { SHA_256: "sha256" }, Charset: { UTF_8: "utf8" }, getUuid: randomUUID,
      computeDigest: (algorithm, text) => Array.from(createHash("sha256").update(text).digest()) },
    ScriptApp: { getService: () => ({ getUrl: () => "https://script.google.com/macros/s/FIXTURE/exec" }) },
    ui_: () => null
  });
  const ledgerSource = context.ss_, ledgerLock = context.qdpWithWriteLock_;
  vm.runInContext(coreSource || source, context);
  if (coreSource) { context.ss_ = ledgerSource; context.qdpWithWriteLock_ = ledgerLock; }
  const records = () => tables.get("QDP_Discovery_Decisions")?.rows.slice(1).map(row => ({
    alias: row[0], id: row[1], kind: row[2], date: row[3], decision: row[4], updatedAt: row[5]
  })) || [];
  return { context, props, tables, records,
    read: identity => context.qdpDiscoveryAdmin_({ operation: "read", items: [{ identity }] }).records[0],
    save: (identity, decision, receipt = false) => context.qdpDiscoverySave_([{ identity, decision }], receipt)[0],
    import: (rows, result) => context.qdpDiscoveryRecordImport_(rows, result),
    feed: (body = {}) => context.qdpDiscoveryFeedback_({ readToken: "a".repeat(64), ...body }),
    get sheetReads() { return sheetReads; }, get sheetWrites() { return sheetWrites; }, get locks() { return locks; }
  };
}
