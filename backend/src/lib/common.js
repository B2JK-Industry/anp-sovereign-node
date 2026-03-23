function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function firstDefined(...values) {
  for (const value of values) {
    if (typeof value !== "undefined" && value !== null) {
      return value;
    }
  }

  return null;
}

function pickFirstString(...values) {
  for (const value of values) {
    if (isNonEmptyString(value)) {
      return value.trim();
    }
  }

  return null;
}

function normalizeForCanonicalJson(value) {
  if (value === null) {
    return null;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON does not support non-finite numbers.");
    }

    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeForCanonicalJson(item));
  }

  if (isPlainObject(value)) {
    const normalized = {};

    for (const key of Object.keys(value).sort()) {
      if (typeof value[key] === "undefined") {
        continue;
      }

      normalized[key] = normalizeForCanonicalJson(value[key]);
    }

    return normalized;
  }

  throw new TypeError(
    `Unsupported value in canonical JSON: ${Object.prototype.toString.call(value)}`
  );
}

function canonicalJson(value) {
  return JSON.stringify(normalizeForCanonicalJson(value));
}

function parseBoolean(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    if (/^(1|true|yes|y|on)$/i.test(value.trim())) {
      return true;
    }

    if (/^(0|false|no|n|off)$/i.test(value.trim())) {
      return false;
    }
  }

  return fallback;
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

module.exports = {
  canonicalJson,
  firstDefined,
  isNonEmptyString,
  isPlainObject,
  normalizeForCanonicalJson,
  parseBoolean,
  pickFirstString,
  sleep,
  toNumber
};
