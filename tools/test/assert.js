/* Minimal assertion helpers. The project has no dependencies and this keeps it
 * that way: `node tools/test/run.js` and nothing to install. */

let checks = 0;

export function ok(cond, msg) {
  checks++;
  if (!cond) throw new Error(msg);
  console.log(`    ok  ${msg}`);
}

export function eq(actual, expected, msg) {
  ok(Object.is(actual, expected), `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export function count() { return checks; }

export async function suite(name, fn) {
  console.log(`\n  ${name}`);
  await fn();
}
