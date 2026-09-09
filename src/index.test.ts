import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const STATE_IMPORT_WITH_DEFAULT =
  /import\s*\{[^}]*DEFAULT_PROVIDER[^}]*\}\s*from\s*"\.\/state";/s;

test("startup notification uses the shared provider fallback", () => {
  expect(source).toMatch(STATE_IMPORT_WITH_DEFAULT);
  expect(source).toContain(
    "const providerId = persisted?.activeProvider ?? DEFAULT_PROVIDER;"
  );
  expect(source).not.toContain(
    'const providerId = persisted?.activeProvider ?? "claude";'
  );
});
