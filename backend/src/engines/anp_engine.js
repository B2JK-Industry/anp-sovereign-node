const { promises: fs } = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { createInterface } = require("node:readline/promises");
const { stdin: input, stdout: output } = require("node:process");
const {
  Wallet,
  Contract,
  JsonRpcProvider,
  TypedDataEncoder,
  getAddress: normalizeAddress,
  keccak256,
  sha256,
  toUtf8Bytes,
  verifyTypedData
} = require("ethers");

const {
  MarketplaceAdapter,
  HttpMarketplaceAdapter
} = require("./marketplace_adapters");

const { SqliteNegotiationVault } = require("./vault_db");

const DEFAULT_VAULT_FILENAME = "negotiation_vault.json";
const DEFAULT_WALLET_FILENAME = "sovereign_wallet.json";
const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_BID_DELIVERY_SECONDS = 24 * 60 * 60;
const MIN_MATCH_BUDGET_MICRO_USDC = 5_000_000n;
const LISTING_MATCH_KEYWORDS = Object.freeze([
  "api",
  "orchestration",
  "data",
  "test",
  "verification"
]);
const VAULT_VERSION = 1;
const CANONICAL_ANP_PROTOCOL = "ANP";
const CANONICAL_ANP_VERSION = "1";
const LEGACY_ANP_PROTOCOL = "anp/v1";

const ANP_DOMAIN = Object.freeze({
  name: "ANP",
  version: "1",
  chainId: 8453,
  verifyingContract: (process.env.ANP_ACP_CONTRACT_ADDRESS || "0x6951272DC7465046C560b7b702f61C5a3E7C898B").trim()
});

const ANP_TYPES_CANONICAL = Object.freeze({
  ListingIntent: Object.freeze([
    { name: "contentHash", type: "bytes32" },
    { name: "minBudget", type: "uint256" },
    { name: "maxBudget", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "jobDuration", type: "uint256" },
    { name: "preferredEvaluator", type: "address" },
    { name: "nonce", type: "uint256" }
  ]),
  BidIntent: Object.freeze([
    { name: "listingHash", type: "bytes32" },
    { name: "contentHash", type: "bytes32" },
    { name: "price", type: "uint256" },
    { name: "deliveryTime", type: "uint256" },
    { name: "nonce", type: "uint256" }
  ]),
  AcceptIntent: Object.freeze([
    { name: "listingHash", type: "bytes32" },
    { name: "bidHash", type: "bytes32" },
    { name: "nonce", type: "uint256" }
  ])
});

const ANP_TYPES_LEGACY = Object.freeze({
  ListingIntent: Object.freeze([
    { name: "contentHash", type: "string" },
    { name: "minBudget", type: "uint256" },
    { name: "maxBudget", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "jobDuration", type: "uint256" },
    { name: "preferredEvaluator", type: "address" },
    { name: "nonce", type: "uint256" }
  ]),
  BidIntent: Object.freeze([
    { name: "listingHash", type: "string" },
    { name: "contentHash", type: "string" },
    { name: "price", type: "uint256" },
    { name: "deliveryTime", type: "uint256" },
    { name: "nonce", type: "uint256" }
  ]),
  AcceptIntent: Object.freeze([
    { name: "listingHash", type: "string" },
    { name: "bidHash", type: "string" },
    { name: "nonce", type: "uint256" }
  ])
});

const ANP_TYPES_BY_VARIANT = Object.freeze({
  canonical: ANP_TYPES_CANONICAL,
  legacy: ANP_TYPES_LEGACY
});

const DOCUMENT_TYPE_TO_PRIMARY_TYPE = Object.freeze({
  listing: "ListingIntent",
  bid: "BidIntent",
  acceptance: "AcceptIntent",
  accept: "AcceptIntent"
});

const PRIMARY_TYPE_TO_DOCUMENT_TYPE = Object.freeze({
  ListingIntent: "listing",
  BidIntent: "bid",
  AcceptIntent: "acceptance"
});

const NUMERIC_FIELDS = Object.freeze({
  ListingIntent: Object.freeze([
    "minBudget",
    "maxBudget",
    "deadline",
    "jobDuration",
    "nonce"
  ]),
  BidIntent: Object.freeze(["price", "deliveryTime", "nonce"]),
  AcceptIntent: Object.freeze(["nonce"])
});

const LISTING_INTENT_FIELDS = Object.freeze([
  "contentHash",
  "minBudget",
  "maxBudget",
  "deadline",
  "jobDuration",
  "preferredEvaluator",
  "nonce"
]);

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

function normalizeDocumentType(type) {
  const normalized = String(type || "").trim().toLowerCase();
  if (normalized === "listing" || normalized === "bid") {
    return normalized;
  }

  if (normalized === "accept" || normalized === "acceptance") {
    return "acceptance";
  }

  throw new Error(`Unsupported ANP document type: ${type}`);
}

function getEnvelopeVariant(document = null) {
  const protocol = pickFirstString(document && document.protocol);
  const version = pickFirstString(document && document.version);
  const data = isPlainObject(document && document.data) ? document.data : {};

  if (protocol === CANONICAL_ANP_PROTOCOL && (version || CANONICAL_ANP_VERSION) === CANONICAL_ANP_VERSION) {
    return "canonical";
  }

  if (
    [data.contentHash, data.listingHash, data.bidHash].some(
      (value) => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value.trim())
    )
  ) {
    return "canonical";
  }

  return "legacy";
}

function resolveTypesForVariant(variant = "canonical") {
  const normalized = variant === "legacy" ? "legacy" : "canonical";
  return ANP_TYPES_BY_VARIANT[normalized];
}

function getPrimaryTypeForDocument(documentOrType) {
  const docType = isPlainObject(documentOrType)
    ? normalizeDocumentType(documentOrType.type)
    : normalizeDocumentType(documentOrType);
  const primaryType = DOCUMENT_TYPE_TO_PRIMARY_TYPE[docType];

  if (!primaryType) {
    throw new Error(`No EIP-712 mapping for document type ${docType}`);
  }

  return primaryType;
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
      const child = value[key];

      if (typeof child === "undefined") {
        continue;
      }

      normalized[key] = normalizeForCanonicalJson(child);
    }

    return normalized;
  }

  throw new TypeError(
    `Unsupported value in canonical JSON: ${Object.prototype.toString.call(value)}`
  );
}

function canonicalJson(document) {
  if (!isPlainObject(document) && !Array.isArray(document)) {
    throw new TypeError("computeCID expects a JSON object or array.");
  }

  return JSON.stringify(normalizeForCanonicalJson(document));
}

function computeCID(document) {
  const digest = sha256(toUtf8Bytes(canonicalJson(document))).slice(2);
  return `sha256-${digest}`;
}

function computeCanonicalSha256Hex(document) {
  return sha256(toUtf8Bytes(canonicalJson(document)));
}

function computeContentHashHex(document) {
  return computeCanonicalSha256Hex(document);
}

function normalizeSha256CidToHex(value) {
  const match = String(value || "").trim().match(/^sha256-([0-9a-fA-F]{64})$/);
  return match ? `0x${match[1].toLowerCase()}` : null;
}

function normalizeBytes32(value, fieldName) {
  if (typeof value !== "string") {
    throw new TypeError(`Invalid bytes32 value for ${fieldName}.`);
  }

  const trimmed = value.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  const cidHex = normalizeSha256CidToHex(trimmed);
  if (cidHex) {
    return cidHex;
  }

  throw new TypeError(`Invalid bytes32 value for ${fieldName}: ${value}`);
}

function cloneTypes(primaryType, variant = "canonical") {
  const types = resolveTypesForVariant(variant);

  if (primaryType) {
    if (!types[primaryType]) {
      throw new Error(`Unsupported primary type: ${primaryType}`);
    }

    return {
      [primaryType]: types[primaryType].map((field) => ({ ...field }))
    };
  }

  return Object.fromEntries(
    Object.entries(types).map(([typeName, fields]) => [
      typeName,
      fields.map((field) => ({ ...field }))
    ])
  );
}

function normalizeInteger(value, fieldName) {
  try {
    return BigInt(value);
  } catch (error) {
    throw new TypeError(`Invalid integer for ${fieldName}: ${value}`);
  }
}

function generateNonce() {
  return BigInt(`0x${randomBytes(16).toString("hex")}`).toString();
}

function toMicroUsdc(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`Invalid USD amount: ${value}`);
    }

    return toMicroUsdc(value.toFixed(6));
  }

  if (typeof value !== "string") {
    throw new TypeError("priceUsdc must be a string, number, or bigint.");
  }

  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+)(?:\.(\d{1,6}))?$/);

  if (!match) {
    throw new TypeError(`Invalid USD amount: ${value}`);
  }

  const whole = match[1];
  const fraction = (match[2] || "").padEnd(6, "0");
  return `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
}

function normalizeBudgetToMicroUsdc(value) {
  if (typeof value === "undefined" || value === null || value === "") {
    return null;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      return null;
    }

    if (!Number.isInteger(value)) {
      return BigInt(toMicroUsdc(value.toFixed(6)));
    }

    return value >= 1_000_000 ? BigInt(value) : BigInt(value) * 1_000_000n;
  }

  if (typeof value === "bigint") {
    return value >= 1_000_000n ? value : value * 1_000_000n;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();

    if (!trimmed) {
      return null;
    }

    if (trimmed.includes(".")) {
      return BigInt(toMicroUsdc(trimmed));
    }

    try {
      const parsed = BigInt(trimmed);
      return parsed >= 1_000_000n ? parsed : parsed * 1_000_000n;
    } catch (error) {
      return null;
    }
  }

  return null;
}

function formatMicroUsdc(value) {
  const amount = BigInt(value);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0");
  const trimmedFraction = fraction.replace(/0+$/, "");
  return trimmedFraction ? `${whole}.${trimmedFraction}` : `${whole}`;
}

function collectStrings(value, bucket = []) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      bucket.push(trimmed);
    }

    return bucket;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, bucket);
    }

    return bucket;
  }

  if (isPlainObject(value)) {
    for (const child of Object.values(value)) {
      collectStrings(child, bucket);
    }
  }

  return bucket;
}

function getListingPayload(listing) {
  const candidates = [listing.data, listing.document, listing.payload, listing.listing];

  for (const candidate of candidates) {
    if (isPlainObject(candidate)) {
      return candidate;
    }
  }

  return listing;
}

function getListingTitle(listing) {
  const payload = getListingPayload(listing);

  return (
    pickFirstString(
      listing.title,
      payload.title,
      listing.name,
      payload.name,
      listing.headline,
      payload.headline
    ) || "Untitled listing"
  );
}

function getListingDescription(listing) {
  const payload = getListingPayload(listing);
  const directDescription = pickFirstString(
    listing.description,
    payload.description,
    listing.summary,
    payload.summary,
    listing.message,
    payload.message,
    listing.body,
    payload.body
  );

  if (directDescription) {
    return directDescription;
  }

  return collectStrings(payload).join(" ");
}

function getListingText(listing) {
  return `${getListingTitle(listing)} ${getListingDescription(listing)}`
    .trim()
    .toLowerCase();
}

function getListingCid(listing) {
  const payload = getListingPayload(listing);

  return (
    pickFirstString(
      listing.cid,
      listing.documentCid,
      listing.listingCid,
      payload.cid,
      payload.documentCid,
      payload.listingCid
    ) || computeCID(listing)
  );
}

function getListingBudgetMicroUsdc(listing, key) {
  const payload = getListingPayload(listing);
  const budget = firstDefined(
    listing[key],
    payload[key],
    listing.budget && listing.budget[key],
    payload.budget && payload.budget[key]
  );

  return normalizeBudgetToMicroUsdc(budget);
}

function hydrateImportedDocument(document, options = {}) {
  if (!isPlainObject(document) || !isPlainObject(document.data)) {
    return document;
  }

  const normalizedType = normalizeDocumentType(document.type);
  const variant = options.variant || getEnvelopeVariant(document);
  const nextDocument = {
    ...document,
    data: {
      ...document.data
    }
  };

  if (normalizedType === "listing" && !nextDocument.data.contentHash) {
    const content = {
      title: nextDocument.data.title || "",
      description: nextDocument.data.description || ""
    };
    nextDocument.data.contentHash =
      variant === "legacy"
        ? computeCID(content)
        : computeContentHashHex(content);
  }

  if (normalizedType === "bid" && !nextDocument.data.contentHash) {
    const proposalCid = pickFirstString(nextDocument.data.proposalCid);
    const content = {
      message: nextDocument.data.message || "",
      ...(proposalCid ? { proposalCid } : {})
    };
    nextDocument.data.contentHash =
      variant === "legacy"
        ? computeCID(content)
        : computeContentHashHex(content);
  }

  return nextDocument;
}

function hasListingIntentShape(candidate) {
  return (
    isPlainObject(candidate) &&
    LISTING_INTENT_FIELDS.every((field) => field in candidate)
  );
}

function normalizeBidMessageContent(message) {
  if (typeof message === "string") {
    return { message };
  }

  if (isPlainObject(message) || Array.isArray(message)) {
    return message;
  }

  throw new TypeError("message must be a string, object, or array.");
}

function normalizeIntentMessage(primaryType, message) {
  return normalizeIntentMessageForVariant(primaryType, message, "canonical");
}

function normalizeIntentMessageForVariant(primaryType, message, variant = "canonical") {
  if (!isPlainObject(message)) {
    throw new TypeError("Intent message must be a plain object.");
  }

  const fields = resolveTypesForVariant(variant)[primaryType];
  if (!fields) {
    throw new Error(`Unsupported primary type: ${primaryType}`);
  }

  const numericFields = new Set(NUMERIC_FIELDS[primaryType] || []);
  const normalized = {};

  for (const { name, type } of fields) {
    if (!(name in message)) {
      throw new Error(`Missing required field "${name}" for ${primaryType}.`);
    }

    const value = message[name];

    if (numericFields.has(name)) {
      normalized[name] = normalizeInteger(value, name).toString();
      continue;
    }

    if (type === "address") {
      if (!isNonEmptyString(value)) {
        throw new TypeError(`Invalid address for ${name}.`);
      }

      normalized[name] = normalizeAddress(value);
      continue;
    }

    if (type === "bytes32") {
      normalized[name] = normalizeBytes32(value, name);
      continue;
    }

    if (typeof value !== "string") {
      throw new TypeError(`Invalid value for ${name}; expected string.`);
    }

    normalized[name] = value;
  }

  return normalized;
}

function buildTypedData(primaryType, message, domain = ANP_DOMAIN, options = {}) {
  const variant = options.variant || "canonical";

  return {
    domain: { ...domain },
    primaryType,
    types: cloneTypes(primaryType, variant),
    message: normalizeIntentMessageForVariant(primaryType, message, variant)
  };
}

function verifyDocument(document, options = {}) {
  const result = {
    valid: false,
    cid: null,
    recoveredSigner: null,
    signer: null,
    primaryType: null,
    variant: null,
    hydrated: false,
    error: null
  };

  try {
    if (!isPlainObject(document)) {
      throw new TypeError("Document must be a plain object.");
    }

    if (!isNonEmptyString(document.protocol) || !isNonEmptyString(document.type)) {
      throw new Error("Document must include protocol and type.");
    }

    if (!isNonEmptyString(document.signature) || !isPlainObject(document.data)) {
      throw new Error("Document must include signature and data.");
    }

    result.cid = computeCID(document);
    result.primaryType =
      options.primaryType || getPrimaryTypeForDocument(document.type);
    result.signer = normalizeAddress(document.signer);
    const hydratedDocument = hydrateImportedDocument(document);
    const verificationTargets = [];
    const seenTargets = new Set();

    const pushTarget = (targetDocument, variant, hydrated = false) => {
      if (!targetDocument || !variant) {
        return;
      }

      const key = `${hydrated ? "hydrated" : "raw"}:${variant}:${
        targetDocument === document ? "same" : "derived"
      }`;
      if (seenTargets.has(key)) {
        return;
      }

      seenTargets.add(key);
      verificationTargets.push({
        document: targetDocument,
        variant,
        hydrated
      });
    };

    if (options.variant) {
      pushTarget(hydratedDocument, options.variant, hydratedDocument !== document);
      pushTarget(document, options.variant, false);
    } else {
      const preferredHydratedVariant = getEnvelopeVariant(hydratedDocument);
      const preferredRawVariant = getEnvelopeVariant(document);
      const fallbackHydratedVariant =
        preferredHydratedVariant === "canonical" ? "legacy" : "canonical";
      const fallbackRawVariant =
        preferredRawVariant === "canonical" ? "legacy" : "canonical";

      pushTarget(hydratedDocument, preferredHydratedVariant, hydratedDocument !== document);
      pushTarget(document, preferredRawVariant, false);
      pushTarget(hydratedDocument, fallbackHydratedVariant, hydratedDocument !== document);
      pushTarget(document, fallbackRawVariant, false);
    }

    let lastError = null;

    for (const target of verificationTargets) {
      try {
        const typedData = buildTypedData(
          result.primaryType,
          target.document.data,
          options.domain || ANP_DOMAIN,
          {
            variant: target.variant
          }
        );
        const recoveredSigner = verifyTypedData(
          typedData.domain,
          typedData.types,
          typedData.message,
          document.signature
        );

        result.recoveredSigner = recoveredSigner;
        result.variant = target.variant;
        result.hydrated = target.hydrated;

        if (
          normalizeAddress(recoveredSigner) === normalizeAddress(result.signer)
        ) {
          result.valid = true;
          result.error = null;
          return result;
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (!result.valid) {
      result.error =
        (lastError && lastError.message) ||
        "Recovered signer does not match the declared signer.";
    }
  } catch (error) {
    result.error = error.message;
  }

  return result;
}

class NegotiationVault {
  constructor(vaultPath = path.resolve(process.cwd(), DEFAULT_VAULT_FILENAME)) {
    this.vaultPath = vaultPath;
    this.state = null;
  }

  normalizeVaultState(state) {
    const normalized = state && isPlainObject(state) ? state : this.createEmptyVault();
    normalized.version = VAULT_VERSION;
    normalized.documents = isPlainObject(normalized.documents) ? normalized.documents : {};
    normalized.indexes = isPlainObject(normalized.indexes) ? normalized.indexes : {};
    normalized.indexes.listing = Array.isArray(normalized.indexes.listing)
      ? normalized.indexes.listing
      : [];
    normalized.indexes.bid = Array.isArray(normalized.indexes.bid)
      ? normalized.indexes.bid
      : [];
    normalized.indexes.acceptance = Array.isArray(normalized.indexes.acceptance)
      ? normalized.indexes.acceptance
      : [];
    normalized.indexes.byTypedHash = isPlainObject(normalized.indexes.byTypedHash)
      ? normalized.indexes.byTypedHash
      : {};
    normalized.bidsByListingCid = isPlainObject(normalized.bidsByListingCid)
      ? normalized.bidsByListingCid
      : {};
    normalized.observations = isPlainObject(normalized.observations)
      ? normalized.observations
      : {};
    normalized.observations.listings = isPlainObject(normalized.observations.listings)
      ? normalized.observations.listings
      : {};
    normalized.activity = Array.isArray(normalized.activity)
      ? normalized.activity
      : [];
    normalized.acp = isPlainObject(normalized.acp) ? normalized.acp : {};
    normalized.acp.jobs = isPlainObject(normalized.acp.jobs)
      ? normalized.acp.jobs
      : {};
    normalized.acp.events = Array.isArray(normalized.acp.events)
      ? normalized.acp.events
      : [];
    normalized.reputation = isPlainObject(normalized.reputation)
      ? normalized.reputation
      : {};
    normalized.reputation.attestations = Array.isArray(normalized.reputation.attestations)
      ? normalized.reputation.attestations
      : [];
    normalized.reputation.humanPauses = Array.isArray(normalized.reputation.humanPauses)
      ? normalized.reputation.humanPauses
      : [];
    normalized.createdAt =
      normalized.createdAt || new Date().toISOString();
    normalized.updatedAt =
      normalized.updatedAt || normalized.createdAt;

    return normalized;
  }

  createEmptyVault() {
    const now = new Date().toISOString();

    return {
      version: VAULT_VERSION,
      createdAt: now,
      updatedAt: now,
      documents: {},
      indexes: {
        listing: [],
        bid: [],
        acceptance: [],
        byTypedHash: {}
      },
      bidsByListingCid: {},
      observations: {
        listings: {}
      },
      activity: [],
      acp: {
        jobs: {},
        events: []
      },
      reputation: {
        attestations: [],
        humanPauses: []
      }
    };
  }

  async load() {
    if (this.state) {
      return this.state;
    }

    try {
      const raw = await fs.readFile(this.vaultPath, "utf8");
      this.state = this.normalizeVaultState(JSON.parse(raw));
      return this.state;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    this.state = this.normalizeVaultState(this.createEmptyVault());
    await this.persist();
    return this.state;
  }

  async persist() {
    const state = this.normalizeVaultState(this.state || this.createEmptyVault());
    state.updatedAt = new Date().toISOString();

    await fs.mkdir(path.dirname(this.vaultPath), { recursive: true });
    await fs.writeFile(
      this.vaultPath,
      JSON.stringify(normalizeForCanonicalJson(state), null, 2),
      "utf8"
    );
  }

  appendActivity(state, event, details = {}) {
    state.activity.push({
      event,
      recordedAt: new Date().toISOString(),
      details: normalizeForCanonicalJson(details)
    });
  }

  async storeSignedDocument(document, metadata = {}) {
    const state = await this.load();
    const cid = computeCID(document);
    const documentType = normalizeDocumentType(document.type);
    const primaryType = getPrimaryTypeForDocument(document);
    const typedData = buildTypedData(
      primaryType,
      document.data,
      ANP_DOMAIN,
      {
        variant: getEnvelopeVariant(document)
      }
    );
    const typedHash = TypedDataEncoder.hash(
      typedData.domain,
      typedData.types,
      typedData.message
    );
    const verification = verifyDocument(document);
    const existing = state.documents[cid] || {};

    state.documents[cid] = {
      cid,
      typedHash,
      protocol: document.protocol,
      type: documentType,
      storedAt: existing.storedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      document: normalizeForCanonicalJson(document),
      verification,
      metadata: normalizeForCanonicalJson({
        ...(existing.metadata || {}),
        ...metadata
      }),
      publications: existing.publications || [],
      settlements: existing.settlements || []
    };

    if (!state.indexes[documentType].includes(cid)) {
      state.indexes[documentType].push(cid);
    }
    state.indexes.byTypedHash[typedHash] = cid;

    if (documentType === "bid" && isNonEmptyString(metadata.listingCid)) {
      state.bidsByListingCid[metadata.listingCid] =
        state.bidsByListingCid[metadata.listingCid] || [];

      if (!state.bidsByListingCid[metadata.listingCid].includes(cid)) {
        state.bidsByListingCid[metadata.listingCid].push(cid);
      }
    }

    this.appendActivity(state, "document-stored", {
      cid,
      type: documentType,
      listingCid: metadata.listingCid || null
    });
    await this.persist();

    return state.documents[cid];
  }

  async removeDocuments(predicate, details = {}) {
    if (typeof predicate !== "function") {
      throw new TypeError("removeDocuments expects a predicate function.");
    }

    const state = await this.load();
    const removed = [];

    for (const [cid, entry] of Object.entries(state.documents)) {
      if (!predicate(entry, cid)) {
        continue;
      }

      removed.push({
        cid,
        type: entry.type,
        typedHash: entry.typedHash
      });

      delete state.documents[cid];

      if (Array.isArray(state.indexes[entry.type])) {
        state.indexes[entry.type] = state.indexes[entry.type].filter(
          (value) => value !== cid
        );
      }

      if (state.indexes.byTypedHash[entry.typedHash] === cid) {
        delete state.indexes.byTypedHash[entry.typedHash];
      }

      for (const listingCid of Object.keys(state.bidsByListingCid)) {
        state.bidsByListingCid[listingCid] = state.bidsByListingCid[listingCid].filter(
          (value) => value !== cid
        );

        if (state.bidsByListingCid[listingCid].length === 0) {
          delete state.bidsByListingCid[listingCid];
        }
      }
    }

    if (removed.length === 0) {
      return removed;
    }

    this.appendActivity(state, "documents-removed", {
      count: removed.length,
      removed,
      ...details
    });
    await this.persist();

    return removed;
  }

  async recordListingObservation(listing, metadata = {}) {
    const state = await this.load();
    const listingCid = getListingCid(listing);

    state.observations.listings[listingCid] = {
      listingCid,
      title: getListingTitle(listing),
      observedAt: new Date().toISOString(),
      metadata: normalizeForCanonicalJson(metadata),
      snapshot: normalizeForCanonicalJson(listing)
    };

    this.appendActivity(state, "listing-observed", {
      listingCid,
      adapter: metadata.adapter || null
    });
    await this.persist();

    return state.observations.listings[listingCid];
  }

  async recordPublication(documentCid, publication) {
    const state = await this.load();
    const entry = state.documents[documentCid];

    if (!entry) {
      throw new Error(`Cannot record publication; unknown document ${documentCid}`);
    }

    entry.publications.push({
      publishedAt: new Date().toISOString(),
      ...normalizeForCanonicalJson(publication)
    });

    this.appendActivity(state, "document-published", {
      documentCid,
      adapter: publication.adapter || null
    });
    await this.persist();
  }

  async recordSettlement(documentCid, settlement) {
    const state = await this.load();
    const entry = state.documents[documentCid];

    if (!entry) {
      throw new Error(`Cannot record settlement; unknown document ${documentCid}`);
    }

    entry.settlements.push({
      recordedAt: new Date().toISOString(),
      ...normalizeForCanonicalJson(settlement)
    });

    this.appendActivity(state, "settlement-recorded", {
      documentCid,
      txHash: settlement.txHash || null
    });
    await this.persist();
  }

  async hasBidForListingCid(listingCid) {
    const state = await this.load();
    return Boolean(
      Array.isArray(state.bidsByListingCid[listingCid]) &&
        state.bidsByListingCid[listingCid].length > 0
    );
  }

  async getDocument(documentCid) {
    const state = await this.load();
    return state.documents[documentCid] || null;
  }

  async getDocumentByTypedHash(typedHash) {
    const state = await this.load();
    const cid = state.indexes.byTypedHash[typedHash];
    return cid ? state.documents[cid] || null : null;
  }

  async recordACPJob(jobId, data = {}) {
    const state = await this.load();
    const key = String(jobId);
    const existing = state.acp.jobs[key] || {};

    state.acp.jobs[key] = {
      ...existing,
      ...normalizeForCanonicalJson(data),
      jobId: key,
      updatedAt: new Date().toISOString()
    };

    this.appendActivity(state, "acp-job-recorded", {
      jobId: key
    });
    await this.persist();

    return state.acp.jobs[key];
  }

  async recordACPEvent(eventData = {}) {
    const state = await this.load();
    state.acp.events.push({
      ...normalizeForCanonicalJson(eventData),
      recordedAt: new Date().toISOString()
    });

    this.appendActivity(state, "acp-event-recorded", {
      eventName: eventData.eventName || null,
      jobId: eventData.jobId || null
    });
    await this.persist();

    return state.acp.events[state.acp.events.length - 1];
  }

  async recordHumanPause(pause = {}) {
    const state = await this.load();
    const entry = {
      ...normalizeForCanonicalJson(pause),
      recordedAt: new Date().toISOString()
    };

    state.reputation.humanPauses.push(entry);
    this.appendActivity(state, "human-pause-recorded", {
      listingCid: pause.listingCid || null,
      title: pause.title || null
    });
    await this.persist();

    return entry;
  }

  async resolveHumanPause({ listingCid, decision, actor, note } = {}) {
    if (!listingCid) {
      throw new Error("listingCid is required to resolve a human pause.");
    }

    if (!["approve", "reject"].includes(decision)) {
      throw new Error('decision must be either "approve" or "reject".');
    }

    const state = await this.load();
    const matches = state.reputation.humanPauses
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.listingCid === listingCid)
      .sort((left, right) => {
        const leftTime = Date.parse(left.entry.recordedAt || 0);
        const rightTime = Date.parse(right.entry.recordedAt || 0);
        return rightTime - leftTime;
      });

    if (!matches.length) {
      throw new Error(`No human pause found for listing ${listingCid}.`);
    }

    const unresolved =
      matches.find(({ entry }) => !entry.decision && !entry.decidedAt) || matches[0];
    const approved = decision === "approve";
    const resolvedEntry = normalizeForCanonicalJson({
      ...unresolved.entry,
      approved,
      decision,
      decidedAt: new Date().toISOString(),
      decidedBy: actor || "owner",
      note: note || unresolved.entry.note || null
    });

    state.reputation.humanPauses[unresolved.index] = resolvedEntry;
    this.appendActivity(state, "human-pause-resolved", {
      listingCid,
      decision,
      title: resolvedEntry.title || null
    });
    await this.persist();

    return resolvedEntry;
  }

  async getMostRecentHumanPauseForListing(listingCid) {
    const state = await this.load();
    const matches = state.reputation.humanPauses
      .filter((entry) => entry.listingCid === listingCid)
      .sort((left, right) => {
        return Date.parse(right.recordedAt || 0) - Date.parse(left.recordedAt || 0);
      });

    return matches[0] || null;
  }

  async getReputationAttestationByKey(attestationKey) {
    const state = await this.load();
    return (
      state.reputation.attestations.find(
        (attestation) => attestation.attestationKey === attestationKey
      ) || null
    );
  }

  async recordReputationAttestation(attestation = {}) {
    const state = await this.load();
    const normalizedAttestation = normalizeForCanonicalJson(attestation);
    const attestationKey = normalizedAttestation.attestationKey || null;
    const existingIndex = attestationKey
      ? state.reputation.attestations.findIndex(
          (entry) => entry.attestationKey === attestationKey
        )
      : -1;
    const record = {
      ...(existingIndex >= 0 ? state.reputation.attestations[existingIndex] : {}),
      ...normalizedAttestation,
      updatedAt: new Date().toISOString()
    };

    if (!record.recordedAt) {
      record.recordedAt = record.updatedAt;
    }

    if (existingIndex >= 0) {
      state.reputation.attestations[existingIndex] = record;
    } else {
      state.reputation.attestations.push(record);
    }

    this.appendActivity(state, "reputation-attestation-recorded", {
      attestationKey: record.attestationKey || null,
      jobId: record.jobId || null,
      published: Boolean(record.onchain && record.onchain.published)
    });
    await this.persist();

    return record;
  }
}

class DiscoveryLayer {
  constructor(config = {}) {
    this.config = {
      adapter: config.adapter || process.env.ANP_MARKETPLACE_ADAPTER || null,
      endpoint: config.endpoint || process.env.ANP_DISCOVERY_URL || null,
      headers: { ...(config.headers || {}) },
      fetchImpl: config.fetchImpl || globalThis.fetch
    };
    this.registry = new Map();
  }

  registerAdapter(name, factory) {
    this.registry.set(String(name).toLowerCase(), factory);
    return this;
  }

  resolveConfig(overrides = {}) {
    return {
      adapter: overrides.adapter || this.config.adapter,
      endpoint: overrides.endpoint || this.config.endpoint,
      headers: {
        ...this.config.headers,
        ...(overrides.headers || {})
      },
      fetchImpl: overrides.fetchImpl || this.config.fetchImpl
    };
  }

  hasActiveAdapter(overrides = {}) {
    const resolved = this.resolveConfig(overrides);
    return Boolean(resolved.adapter && resolved.endpoint);
  }

  getActiveAdapter(overrides = {}) {
    const resolved = this.resolveConfig(overrides);

    if (!resolved.adapter) {
      throw new Error(
        "No marketplace adapter configured. Set ANP_MARKETPLACE_ADAPTER or pass discovery.adapter."
      );
    }

    if (!resolved.endpoint) {
      throw new Error(
        `No discovery endpoint configured for adapter ${resolved.adapter}. Set ANP_DISCOVERY_URL or pass discovery.endpoint.`
      );
    }

    const adapterName = String(resolved.adapter).toLowerCase();
    const factory =
      this.registry.get(adapterName) ||
      this.registry.get("marketplace");
    if (!factory) {
      throw new Error(`Unknown marketplace adapter: ${resolved.adapter}`);
    }

    return factory({
      ...resolved,
      label: resolved.label || resolved.adapter
    });
  }
}

class OnChainSettlementClient {
  constructor(config = {}) {
    this.config = {
      chainId: config.chainId || ANP_DOMAIN.chainId,
      rpcUrl: config.rpcUrl || process.env.ANP_BASE_RPC_URL || null,
      contractAddress:
        config.contractAddress ||
        process.env.ANP_SETTLEMENT_CONTRACT ||
        ANP_DOMAIN.verifyingContract,
      contractAbi: Array.isArray(config.contractAbi) ? config.contractAbi : []
    };
  }

  getSourceOfTruth() {
    return {
      mode: "onchain-first",
      chainId: this.config.chainId,
      contractAddress: this.config.contractAddress,
      configured: Boolean(
        this.config.rpcUrl &&
          this.config.contractAddress &&
          this.config.contractAbi.length > 0
      )
    };
  }

  getProvider() {
    if (!this.config.rpcUrl) {
      throw new Error(
        "No Base RPC URL configured. Set ANP_BASE_RPC_URL to enable on-chain settlement."
      );
    }

    return new JsonRpcProvider(this.config.rpcUrl, this.config.chainId);
  }

  getContract(runner) {
    if (!this.config.contractAddress) {
      throw new Error("No settlement contract address configured.");
    }

    if (!Array.isArray(this.config.contractAbi) || this.config.contractAbi.length === 0) {
      throw new Error(
        "No settlement contract ABI configured. Pass settlement.contractAbi to enable on-chain calls."
      );
    }

    return new Contract(this.config.contractAddress, this.config.contractAbi, runner);
  }

  buildSettlementReference(documentOrCid) {
    const cid =
      typeof documentOrCid === "string" ? documentOrCid : computeCID(documentOrCid);
    return keccak256(toUtf8Bytes(cid));
  }

  async read(methodName, args = []) {
    const provider = this.getProvider();
    const contract = this.getContract(provider);
    return contract[methodName](...args);
  }

  async submit(wallet, methodName, args = [], overrides = {}) {
    const connectedWallet = wallet.connect(this.getProvider());
    const contract = this.getContract(connectedWallet);
    const transaction = await contract[methodName](...args, overrides);

    return {
      txHash: transaction.hash,
      chainId: this.config.chainId,
      contractAddress: this.config.contractAddress,
      methodName
    };
  }
}

class ANPManager {
  constructor(options = {}) {
    this.config = {
      walletPath:
        options.walletPath ||
        path.resolve(process.cwd(), DEFAULT_WALLET_FILENAME),
      vaultPath:
        options.vaultPath ||
        path.resolve(process.cwd(), DEFAULT_VAULT_FILENAME),
      pollIntervalMs:
        options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS,
      discovery: {
        ...(options.discovery || {})
      },
      settlement: {
        ...(options.settlement || {})
      }
    };

    this.walletPath = this.config.walletPath;
    this.wallet = null;
    this.vault = new SqliteNegotiationVault(
      process.env.TURSO_DATABASE_URL || this.config.vaultPath,
      {
        computeCID,
        verifyDocument,
        buildTypedData,
        TypedDataEncoder,
        normalizeDocumentType,
        getPrimaryTypeForDocument,
        getEnvelopeVariant,
        normalizeForCanonicalJson,
        isNonEmptyString,
        getListingCid,
        getListingTitle,
        ANP_DOMAIN
      },
      { authToken: process.env.TURSO_AUTH_TOKEN || null }
    );
    this.discovery = new DiscoveryLayer(this.config.discovery);
    this.discovery.registerAdapter("marketplace", (adapterOptions) => {
      return new HttpMarketplaceAdapter(adapterOptions);
    });
    this.discovery.registerAdapter("anp", (adapterOptions) => {
      return new HttpMarketplaceAdapter(adapterOptions);
    });
    this.discovery.registerAdapter("http", (adapterOptions) => {
      return new HttpMarketplaceAdapter(adapterOptions);
    });
    this.settlement = new OnChainSettlementClient(this.config.settlement);
    this.opportunityTimer = null;
    this.scanInFlight = false;
  }

  static get DOMAIN() {
    return { ...ANP_DOMAIN };
  }

  static get TYPES() {
    return cloneTypes(undefined, "canonical");
  }

  static computeCID(document) {
    return computeCID(document);
  }

  static computeContentHashHex(document) {
    return computeContentHashHex(document);
  }

  static verifyDocument(document, options = {}) {
    return verifyDocument(document, options);
  }

  registerAdapter(name, factory) {
    this.discovery.registerAdapter(name, factory);
    return this;
  }

  getDomain() {
    return { ...ANP_DOMAIN };
  }

  getTypes(primaryType) {
    return cloneTypes(primaryType);
  }

  computeCID(document) {
    return computeCID(document);
  }

  computeContentHashHex(document) {
    return computeContentHashHex(document);
  }

  verifyDocument(document, options = {}) {
    return verifyDocument(document, options);
  }

  getSettlementSourceOfTruth() {
    return this.settlement.getSourceOfTruth();
  }

  async loadVault() {
    return this.vault.load();
  }

  async loadOrCreateWallet() {
    return this.ensureWallet();
  }

  async ensureWallet() {
    if (this.wallet) {
      return this.wallet;
    }

    const envPrivateKey =
      process.env.ANP_SOVEREIGN_PRIVATE_KEY ||
      process.env.SOVEREIGN_PRIVATE_KEY ||
      null;
    if (isNonEmptyString(envPrivateKey)) {
      const normalizedPrivateKey = envPrivateKey.startsWith("0x")
        ? envPrivateKey
        : `0x${envPrivateKey}`;
      this.wallet = new Wallet(normalizedPrivateKey);
      this.walletSource = "env:ANP_SOVEREIGN_PRIVATE_KEY";
      return this.wallet;
    }

    try {
      const raw = await fs.readFile(this.walletPath, "utf8");
      const parsed = JSON.parse(raw);

      if (!isNonEmptyString(parsed.privateKey)) {
        throw new Error(
          `Wallet file at ${this.walletPath} does not contain a privateKey.`
        );
      }

      this.wallet = new Wallet(parsed.privateKey);
      this.walletSource = this.walletPath;
      return this.wallet;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    this.wallet = Wallet.createRandom();
    this.walletSource = this.walletPath;
    await this.persistWallet();
    return this.wallet;
  }

  async persistWallet() {
    if (!this.wallet) {
      throw new Error("No wallet is loaded to persist.");
    }

    const payload = {
      address: this.wallet.address,
      privateKey: this.wallet.privateKey,
      createdAt: new Date().toISOString()
    };

    await fs.mkdir(path.dirname(this.walletPath), { recursive: true });
    await fs.writeFile(this.walletPath, JSON.stringify(payload, null, 2), "utf8");

    return payload;
  }

  async getAddress() {
    const wallet = await this.ensureWallet();
    return wallet.address;
  }

  async getWalletMetadata() {
    const wallet = await this.ensureWallet();

    return {
      address: wallet.address,
      walletPath: this.walletSource || this.walletPath
    };
  }

  prepareTypedData(primaryType, message, options = {}) {
    return buildTypedData(primaryType, message, ANP_DOMAIN, {
      variant: options.variant || "canonical"
    });
  }

  hashTypedData(primaryType, message, options = {}) {
    const typedData = this.prepareTypedData(primaryType, message, options);
    return TypedDataEncoder.hash(
      typedData.domain,
      typedData.types,
      typedData.message
    );
  }

  async signTypedData(primaryType, message, options = {}) {
    const wallet = await this.ensureWallet();
    const typedData = this.prepareTypedData(primaryType, message, options);

    return wallet.signTypedData(
      typedData.domain,
      typedData.types,
      typedData.message
    );
  }

  async createSignedDocument(primaryType, data, metadata = {}) {
    const wallet = await this.ensureWallet();
    const documentType = PRIMARY_TYPE_TO_DOCUMENT_TYPE[primaryType];

    if (!documentType) {
      throw new Error(`Unsupported primary type ${primaryType}`);
    }

    const typedData = this.prepareTypedData(primaryType, data);
    const signature = await wallet.signTypedData(
      typedData.domain,
      typedData.types,
      typedData.message
    );
    const documentData = normalizeForCanonicalJson({
      ...data,
      ...typedData.message
    });

    const document = {
      protocol: CANONICAL_ANP_PROTOCOL,
      version: CANONICAL_ANP_VERSION,
      type: documentType,
      data: documentData,
      signer: wallet.address,
      signature,
      timestamp: Math.floor(Date.now() / 1000)
    };

    const cid = computeCID(document);
    await this.vault.storeSignedDocument(document, metadata);
    console.log(`[ANP] Created signed ${documentType} ${cid}`);

    return document;
  }

  async createListing({
    title,
    description,
    contentHash,
    minBudget,
    maxBudget,
    deadline,
    jobDuration,
    preferredEvaluator,
    nonce
  }) {
    return this.createSignedDocument(
      "ListingIntent",
      {
        ...(isNonEmptyString(title) ? { title: title.trim() } : {}),
        ...(isNonEmptyString(description) ? { description: description.trim() } : {}),
        contentHash:
          contentHash ||
          computeContentHashHex({
            title: title || "",
            description: description || ""
          }),
        minBudget,
        maxBudget,
        deadline,
        jobDuration,
        preferredEvaluator,
        nonce: nonce || generateNonce()
      },
      {
        source: "local-node"
      }
    );
  }

  async createAcceptance({ listingCid, bidCid, listingHash, bidHash, nonce }) {
    return this.createSignedDocument(
      "AcceptIntent",
      {
        ...(isNonEmptyString(listingCid) ? { listingCid } : {}),
        ...(isNonEmptyString(bidCid) ? { bidCid } : {}),
        listingHash,
        bidHash,
        nonce: nonce || generateNonce()
      },
      {
        source: "local-node"
      }
    );
  }

  getSuggestedBidPriceUsdc(listing) {
    const minBudget = getListingBudgetMicroUsdc(listing, "minBudget");
    const maxBudget = getListingBudgetMicroUsdc(listing, "maxBudget");
    const suggested = minBudget || maxBudget || MIN_MATCH_BUDGET_MICRO_USDC;
    const clamped =
      suggested < MIN_MATCH_BUDGET_MICRO_USDC
        ? MIN_MATCH_BUDGET_MICRO_USDC
        : suggested;

    return formatMicroUsdc(clamped);
  }

  getSuggestedDeliverySeconds(listing) {
    const payload = getListingPayload(listing);
    const value = firstDefined(
      listing.jobDuration,
      payload.jobDuration,
      listing.deliveryTime,
      payload.deliveryTime
    );

    if (typeof value === "undefined" || value === null) {
      return DEFAULT_BID_DELIVERY_SECONDS.toString();
    }

    return normalizeInteger(value, "deliveryTime").toString();
  }

  resolveListingHash(listing) {
    const payload = getListingPayload(listing);
    const directHash = pickFirstString(
      listing.listingHash,
      listing.hash,
      listing.intentHash,
      payload.listingHash,
      payload.hash,
      payload.intentHash
    );

    if (directHash) {
      return directHash;
    }

    const candidates = [listing.data, payload.data, payload, listing];
    for (const candidate of candidates) {
      if (hasListingIntentShape(candidate)) {
        return this.hashTypedData("ListingIntent", candidate);
      }
    }

    return null;
  }

  isGoodMatch(listing) {
    const maxBudget = getListingBudgetMicroUsdc(listing, "maxBudget");
    if (maxBudget === null || maxBudget < MIN_MATCH_BUDGET_MICRO_USDC) {
      return false;
    }

    const text = getListingText(listing);
    return LISTING_MATCH_KEYWORDS.some((keyword) => text.includes(keyword));
  }

  async createBid(
    listingCid,
    listingHash,
    priceUsdc,
    deliverySeconds,
    message,
    options = {}
  ) {
    if (!isNonEmptyString(listingCid)) {
      throw new TypeError("listingCid must be a non-empty string.");
    }

    if (!isNonEmptyString(listingHash)) {
      throw new TypeError("listingHash must be a non-empty string.");
    }

    const messageDocument = normalizeBidMessageContent(message);
    const proposalCid = pickFirstString(
      options.proposalCid,
      isPlainObject(messageDocument) ? messageDocument.proposalCid : null
    );
    const contentHash = computeContentHashHex({
      message: messageDocument,
      ...(proposalCid ? { proposalCid } : {})
    });

    return this.createSignedDocument(
      "BidIntent",
      {
        listingCid,
        listingHash,
        contentHash,
        price: toMicroUsdc(priceUsdc),
        deliveryTime: normalizeInteger(
          deliverySeconds,
          "deliverySeconds"
        ).toString(),
        message: messageDocument,
        ...(proposalCid ? { proposalCid } : {}),
        nonce: generateNonce()
      },
      {
        listingCid,
        message: messageDocument,
        source: options.source || "local-node",
        ...(options.metadata || {})
      }
    );
  }

  getActiveAdapter(options = {}) {
    if (options.adapterInstance instanceof MarketplaceAdapter) {
      return options.adapterInstance;
    }

    return this.discovery.getActiveAdapter(options.discovery || options);
  }

  async syncListingFromDiscovery(listing, options = {}) {
    const adapter = this.getActiveAdapter(options);
    const listingCid = getListingCid(listing);
    const metadata = {
      adapter: adapter.name,
      endpoint: adapter.endpoint,
      discoveryId: pickFirstString(listing && listing.discoveryId, listing && listing.id) || null
    };

    const observation = await this.vault.recordListingObservation(listing, metadata);
    let importedDocument = null;
    let importError = null;

    if (options.importDocuments === false || !listingCid) {
      return {
        listingCid,
        observation,
        importedDocument,
        importError
      };
    }

    try {
      const result = await adapter.fetchDocumentByCid(listingCid);
      if (result && result.document && isPlainObject(result.document)) {
        const remoteVerification = verifyDocument(result.document);
        const importVariant =
          remoteVerification.valid && remoteVerification.variant
            ? remoteVerification.variant
            : "canonical";
        const hydratedDocument = hydrateImportedDocument(result.document, {
          variant: importVariant
        });
        const hydratedCid = computeCID(hydratedDocument);

        await this.vault.removeDocuments(
          (entry, cid) =>
            Boolean(
              entry &&
                entry.metadata &&
                entry.metadata.source === "discovery-sync" &&
                entry.metadata.remoteCid === (result.contentCid || listingCid) &&
                cid !== hydratedCid
            ),
          {
            source: "discovery-sync-reconcile",
            remoteCid: result.contentCid || listingCid,
            keepCid: hydratedCid
          }
        );

        importedDocument = await this.vault.storeSignedDocument(hydratedDocument, {
          source: "discovery-sync",
          listingCid,
          adapter: adapter.name,
          endpoint: adapter.endpoint,
          discoveryId: metadata.discoveryId,
          remoteCid: result.contentCid || listingCid,
          remoteUrl: result.url || null,
          hydratedImport:
            JSON.stringify(hydratedDocument.data) !== JSON.stringify(result.document.data),
          importVariant,
          remoteVerificationValid: remoteVerification.valid
        });
      }
    } catch (error) {
      importError = error;
      console.warn(
        `[ANP] Discovery document import skipped for ${listingCid}: ${error.message}`
      );
    }

    return {
      listingCid,
      observation,
      importedDocument,
      importError
    };
  }

  async fetchOpenListings(options = {}) {
    const adapter = this.getActiveAdapter(options);
    console.log(`Searching for jobs on ${adapter.name}...`);

    const result = await adapter.fetchOpenListings();
    const syncResults = await Promise.all(
      result.listings.map((listing) =>
        this.syncListingFromDiscovery(listing, {
          ...options,
          adapterInstance: adapter
        })
      )
    );

    const importedCount = syncResults.filter((entry) => entry.importedDocument).length;
    if (importedCount > 0) {
      console.log(
        `[ANP] Imported ${importedCount}/${result.listings.length} live listings into the local vault`
      );
    }

    return result.listings;
  }

  async publishDocument(document, options = {}) {
    const adapter = this.getActiveAdapter(options);
    const documentCid = computeCID(document);

    console.log(`[ANP] Publishing document ${documentCid} via ${adapter.name}`);
    const result = await adapter.publishDocument(document);

    await this.vault.recordPublication(documentCid, {
      adapter: adapter.name,
      endpoint: adapter.endpoint,
      status: result.status,
      response: result.body
    });

    console.log(`[ANP] Published document ${documentCid} via ${adapter.name}`);

    return {
      cid: documentCid,
      adapter: adapter.name,
      status: result.status,
      body: result.body
    };
  }

  async publishToMarketplace(document, options = {}) {
    const endpoint =
      options.endpoint ||
      process.env.ANP_MARKETPLACE_URL ||
      this.config.discovery.endpoint;

    if (!endpoint) {
      throw new Error(
        "No marketplace endpoint configured. Pass options.endpoint or set ANP_MARKETPLACE_URL."
      );
    }

    const adapter = new HttpMarketplaceAdapter({
      endpoint,
      headers: options.headers,
      fetchImpl: options.fetchImpl || this.config.discovery.fetchImpl,
      label: options.label || "marketplace"
    });

    return this.publishDocument(document, { adapterInstance: adapter });
  }

  async confirmBidPrompt(title, priceUsdc) {
    const rl = createInterface({ input, output });

    try {
      const answer = await rl.question(
        `Nájdená nová príležitosť: ${title}. Poslať Bid za ${priceUsdc}? (Y/N) `
      );

      return /^y(?:es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  }

  buildBidMessage(listing, context = {}) {
    return {
      listingCid: context.listingCid || getListingCid(listing),
      title: getListingTitle(listing),
      proposedPriceUsdc: String(
        context.priceUsdc || this.getSuggestedBidPriceUsdc(listing)
      ),
      proposedDeliverySeconds: String(
        context.deliverySeconds || this.getSuggestedDeliverySeconds(listing)
      ),
      summary:
        "Sovereign ANP node bid for API, orchestration, data, testing, and verification work.",
      source: "anp-sovereign-node"
    };
  }

  async handleMatchedListing(listing, options = {}) {
    const listingCid = getListingCid(listing);
    const title = getListingTitle(listing);
    const priceUsdc = String(
      options.priceUsdc || this.getSuggestedBidPriceUsdc(listing)
    );
    const deliverySeconds = String(
      options.deliverySeconds || this.getSuggestedDeliverySeconds(listing)
    );

    console.log(`[ANP] Match found: ${title} (${listingCid})`);

    const shouldPrompt = options.requireHumanConsent === true;
    const shouldPublish =
      options.sendBidOnMatch === true || options.requireHumanConsent === true;

    if (!shouldPublish) {
      return {
        status: "match",
        listingCid,
        title,
        priceUsdc
      };
    }

    if (shouldPrompt) {
      const approved = await this.confirmBidPrompt(title, `${priceUsdc} USDC`);
      if (!approved) {
        console.log(`[ANP] Bid skipped for ${title}`);
        return {
          status: "declined",
          listingCid,
          title,
          priceUsdc
        };
      }
    }

    const listingHash = this.resolveListingHash(listing);
    if (!listingHash) {
      throw new Error(`Could not resolve listingHash for ${listingCid}`);
    }

    const message = options.buildBidMessage
      ? await options.buildBidMessage(listing, {
          listingCid,
          title,
          priceUsdc,
          deliverySeconds
        })
      : this.buildBidMessage(listing, {
          listingCid,
          priceUsdc,
          deliverySeconds
        });

    const bidDocument = await this.createBid(
      listingCid,
      listingHash,
      priceUsdc,
      deliverySeconds,
      message
    );
    const publishResult = await this.publishDocument(bidDocument, options);

    return {
      status: "published",
      listingCid,
      title,
      priceUsdc,
      bidCid: publishResult.cid,
      publishResult
    };
  }

  async scanForOpportunities(options = {}) {
    await this.loadVault();
    const listings = await this.fetchOpenListings(options);
    const newMatches = [];

    for (const listing of listings) {
      const listingCid = getListingCid(listing);

      if (await this.vault.hasBidForListingCid(listingCid)) {
        continue;
      }

      if (!this.isGoodMatch(listing)) {
        continue;
      }

      newMatches.push(listing);
    }

    console.log(`[Success: ${newMatches.length} new listings found]`);

    const handledMatches = [];
    for (const listing of newMatches) {
      handledMatches.push(await this.handleMatchedListing(listing, options));
    }

    return {
      listings,
      matches: handledMatches
    };
  }

  startOpportunityScanner(options = {}) {
    const pollIntervalMs =
      options.pollIntervalMs || this.config.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;

    if (this.opportunityTimer) {
      clearInterval(this.opportunityTimer);
    }

    const runScan = async () => {
      if (this.scanInFlight) {
        console.log("[ANP] Scan skipped because a previous scan is still running.");
        return;
      }

      this.scanInFlight = true;

      try {
        await this.scanForOpportunities(options);
      } catch (error) {
        console.error(`[ANP] Opportunity scan failed: ${error.message}`);
      } finally {
        this.scanInFlight = false;
      }
    };

    void runScan();
    this.opportunityTimer = setInterval(runScan, pollIntervalMs);
    return this.opportunityTimer;
  }

  stopOpportunityScanner() {
    if (this.opportunityTimer) {
      clearInterval(this.opportunityTimer);
      this.opportunityTimer = null;
    }
  }

  async readSettlement(methodName, args = []) {
    return this.settlement.read(methodName, args);
  }

  async submitSettlement(methodName, args = [], overrides = {}, documentCid = null) {
    const wallet = await this.ensureWallet();
    const settlement = await this.settlement.submit(
      wallet,
      methodName,
      args,
      overrides
    );

    if (documentCid) {
      await this.vault.recordSettlement(documentCid, settlement);
    }

    return settlement;
  }
}

module.exports = {
  ANP_DOMAIN,
  ANP_TYPES: ANP_TYPES_CANONICAL,
  ANP_TYPES_CANONICAL,
  ANP_TYPES_LEGACY,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_VAULT_FILENAME,
  LISTING_MATCH_KEYWORDS,
  MarketplaceAdapter,
  HttpMarketplaceAdapter,
  DiscoveryLayer,
  NegotiationVault,
  OnChainSettlementClient,
  ANPManager,
  computeCID,
  computeContentHashHex,
  verifyDocument,
  toMicroUsdc
};

if (require.main === module) {
  const manager = new ANPManager();

  if (!manager.discovery.hasActiveAdapter()) {
    console.log(
      "[ANP] No discovery adapter configured. Set ANP_MARKETPLACE_ADAPTER and ANP_DISCOVERY_URL to start scanning."
    );
  } else {
    manager.startOpportunityScanner({
      requireHumanConsent: process.env.ANP_REQUIRE_CONSENT === "1",
      sendBidOnMatch: process.env.ANP_AUTO_BID === "1"
    });
  }
}
