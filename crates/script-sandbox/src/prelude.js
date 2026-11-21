// The `pm` API seen by user scripts. Runs inside a fresh QuickJS context per run:
// no file system, no network, no timers. Input arrives in `__input` (JSON text) and
// `__run()` returns the output as JSON text.
"use strict";

const __in = JSON.parse(__input);
const __out = { logs: [], tests: [], errors: [] };
const __vars = __in.variables;

const __str = (v) =>
  v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);

function __scope(name, label) {
  return {
    get: (key) => __vars[name]?.[key],
    has: (key) => Boolean(__vars[name]) && Object.hasOwn(__vars[name], key),
    set: (key, value) => {
      if (!__vars[name]) throw new Error(`No hay ${label}: actívalo para usar pm.${name === "collection" ? "collectionVariables" : name}.set`);
      __vars[name][__str(key)] = __str(value);
    },
    unset: (key) => {
      if (__vars[name]) delete __vars[name][key];
    },
    clear: () => {
      if (__vars[name]) for (const k of Object.keys(__vars[name])) delete __vars[name][k];
    },
    toObject: () => ({ ...(__vars[name] ?? {}) }),
  };
}

const __lookup = (key) => {
  for (const s of ["local", "environment", "collection", "globals"])
    if (__vars[s] && Object.hasOwn(__vars[s], key)) return __vars[s][key];
  return undefined;
};

/** Header list with Postman's helpers (case-insensitive keys). */
function __headers(list) {
  const find = (key) => list.findIndex((h) => h.key.toLowerCase() === String(key).toLowerCase());
  return {
    all: () => list.map((h) => ({ ...h })),
    get: (key) => list[find(key)]?.value,
    has: (key) => find(key) >= 0,
    add: (h) => list.push({ key: __str(h.key), value: __str(h.value), enabled: true }),
    upsert: (h) => {
      const i = find(h.key);
      if (i >= 0) list[i].value = __str(h.value);
      else list.push({ key: __str(h.key), value: __str(h.value), enabled: true });
    },
    remove: (key) => {
      for (let i = find(key); i >= 0; i = find(key)) list.splice(i, 1);
    },
    toObject: () => Object.fromEntries(list.filter((h) => h.enabled).map((h) => [h.key, h.value])),
  };
}

const __deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function __expect(actual, negate = false) {
  const check = (ok, message) => {
    if (ok === negate) throw new Error(negate ? `No se esperaba: ${message}` : message);
  };
  const show = (v) => (typeof v === "string" ? JSON.stringify(v) : __str(v));
  const api = {
    equal: (v) => check(actual === v, `se esperaba ${show(v)} y llegó ${show(actual)}`),
    eql: (v) => check(__deepEqual(actual, v), `se esperaba ${show(v)} y llegó ${show(actual)}`),
    include: (v) =>
      check(
        typeof actual === "string" || Array.isArray(actual)
          ? actual.includes(v)
          : actual && typeof actual === "object" && Object.hasOwn(actual, v),
        `${show(actual)} no incluye ${show(v)}`,
      ),
    above: (n) => check(actual > n, `${show(actual)} no es mayor que ${n}`),
    below: (n) => check(actual < n, `${show(actual)} no es menor que ${n}`),
    property: (k) =>
      check(actual != null && Object.hasOwn(Object(actual), k), `falta la propiedad ${show(k)}`),
    a: (type) =>
      check(
        (Array.isArray(actual) ? "array" : actual === null ? "null" : typeof actual) === type,
        `${show(actual)} no es de tipo ${type}`,
      ),
  };
  api.eq = api.equal;
  api.contain = api.include;
  api.an = api.a;
  const chain = {
    ...api,
    get ok() {
      check(Boolean(actual), `${show(actual)} no es verdadero`);
      return chain;
    },
    get true() {
      check(actual === true, `${show(actual)} no es true`);
      return chain;
    },
    get false() {
      check(actual === false, `${show(actual)} no es false`);
      return chain;
    },
    get null() {
      check(actual === null, `${show(actual)} no es null`);
      return chain;
    },
    get undefined() {
      check(actual === undefined, `${show(actual)} no es undefined`);
      return chain;
    },
    get empty() {
      const size = actual == null ? 0 : (actual.length ?? Object.keys(actual).length);
      check(size === 0, `${show(actual)} no está vacío`);
      return chain;
    },
    get not() {
      return __expect(actual, !negate);
    },
  };
  // Chai's filler words: pm.expect(x).to.be.an("object"), .to.have.property(…), …
  for (const word of ["to", "be", "been", "is", "that", "which", "and", "has", "have", "with", "at", "of", "same", "deep"])
    Object.defineProperty(chain, word, { get: () => chain });
  return chain;
}

const __req = __in.request;
const __request = {
  get url() {
    return __req.url;
  },
  set url(v) {
    __req.url = __str(v);
  },
  get method() {
    return __req.method;
  },
  set method(v) {
    __req.method = __str(v).toUpperCase();
  },
  headers: __headers(__req.headers),
};

let __response;
if (__in.response) {
  const r = __in.response;
  __response = {
    code: r.code,
    status: r.status,
    responseTime: r.responseTime,
    headers: __headers(r.headers),
    text: () => r.body,
    json: () => JSON.parse(r.body),
    to: {
      have: {
        status: (code) => {
          if (r.code !== code) throw new Error(`se esperaba status ${code} y llegó ${r.code}`);
        },
        header: (key) => {
          if (!r.headers.some((h) => h.key.toLowerCase() === String(key).toLowerCase()))
            throw new Error(`falta el header ${key}`);
        },
      },
    },
  };
  __response.to.be = __response.to.have;
}

const pm = {
  environment: __scope("environment", "entorno activo"),
  globals: __scope("globals", "globales"),
  collectionVariables: __scope("collection", "colección"),
  variables: {
    get: __lookup,
    has: (key) => __lookup(key) !== undefined,
    set: (key, value) => {
      __vars.local[__str(key)] = __str(value);
    },
    unset: (key) => {
      delete __vars.local[key];
    },
    replaceIn: (text) =>
      __str(text).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, name) => __lookup(name) ?? whole),
    toObject: () => ({ ...__vars.globals, ...__vars.collection, ...__vars.environment, ...__vars.local }),
  },
  request: __request,
  response: __response,
  test: (name, fn) => {
    try {
      fn();
      __out.tests.push({ name: __str(name), passed: true, error: null });
    } catch (e) {
      __out.tests.push({ name: __str(name), passed: false, error: __str(e?.message ?? e) });
    }
  },
  expect: (v) => __expect(v),
};

const __fmt = (args) => args.map((a) => (typeof a === "string" ? a : __str(a))).join(" ");
let __logged = 0;
const __log = (level) => (...args) => {
  // shortcut: logs capped at 500 lines per run, enough for debugging.
  if (__logged++ < 500) __out.logs.push({ level, text: __fmt(args) });
};
const console = { log: __log("log"), info: __log("info"), warn: __log("warn"), error: __log("error"), debug: __log("log") };

function __run() {
  for (const s of __in.scripts) {
    try {
      new Function("pm", "console", s.code)(pm, console);
    } catch (e) {
      __out.errors.push(`${s.source}: ${__str(e?.message ?? e)}`);
      break; // like Postman: a failing script stops the chain.
    }
  }
  return JSON.stringify({ ...__out, variables: __vars, request: __req });
}
