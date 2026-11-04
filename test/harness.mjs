// Tiny test harness. No dependencies, no network.
//
// The shape matters more than the assertions. In the previous project a summary
// line printed "all passed" before the async tests had finished, because each
// test was invoked without awaiting it. Here the caller registers tests and calls
// run() once; run() awaits every test in order and only then prints. There is no
// way to forget an await, because the caller never writes one.

const state = { name: "tests", tests: [] };

export function suite(name) {
  state.name = name;
  state.tests = [];
}

export function test(name, fn) {
  state.tests.push({ name, fn });
}

// JSON.stringify cannot serialise BigInt, which is most of what we assert on.
export function stringify(value) {
  if (typeof value === "bigint") return `${value}n`;
  if (value instanceof Uint8Array) return `0x${[...value].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  if (Array.isArray(value)) return `[${value.map(stringify).join(", ")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).map(([k, v]) => `${k}: ${stringify(v)}`).join(", ")}}`;
  }
  return String(value);
}

export function ok(condition, message) {
  if (!condition) throw new Error(message || "expected a truthy value");
}

export function eq(actual, expected, message) {
  if (stringify(actual) !== stringify(expected)) {
    throw new Error(`${message ? message + ": " : ""}expected ${stringify(expected)}, got ${stringify(actual)}`);
  }
}

export function includes(haystack, needle, message) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${message ? message + ": " : ""}expected to find ${JSON.stringify(needle)} in ${JSON.stringify(String(haystack).slice(0, 200))}`);
  }
}

export async function throws(fn, matcher, message) {
  let error = null;
  try {
    await fn();
  } catch (err) {
    error = err;
  }
  if (!error) throw new Error(`${message ? message + ": " : ""}expected a throw, nothing was thrown`);
  if (matcher instanceof RegExp && !matcher.test(error.message)) {
    throw new Error(`${message ? message + ": " : ""}expected error matching ${matcher}, got ${JSON.stringify(error.message)}`);
  }
  if (typeof matcher === "string" && !error.message.includes(matcher)) {
    throw new Error(`${message ? message + ": " : ""}expected error containing ${JSON.stringify(matcher)}, got ${JSON.stringify(error.message)}`);
  }
  return error;
}

export async function run() {
  const failures = [];
  let passed = 0;

  for (const { name, fn } of state.tests) {
    try {
      await fn();
      passed++;
      console.log(`  ok    ${name}`);
    } catch (err) {
      failures.push({ name, error: err });
      console.log(`  FAIL  ${name}`);
      console.log(`        ${err.message}`);
    }
  }

  console.log("");
  console.log(`${state.name}: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("");
    for (const f of failures) console.log(`failed: ${f.name}`);
  }
  return failures.length;
}
