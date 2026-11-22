import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
test("the direct Apps Script reader follows complete snapshots and protects the read credential", () => {
  execFileSync("python3", [fileURLToPath(new URL("./discovery_reader_test.py", import.meta.url))], { stdio: "pipe" });
});
