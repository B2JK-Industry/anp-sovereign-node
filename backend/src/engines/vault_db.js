"use strict";

/**
 * SqliteNegotiationVault — persistent vault backed by libsql / Turso.
 *
 * Uses @libsql/client which supports both local files (file:./path.db) and
 * remote Turso databases (libsql://name.turso.io).  All public methods are
 * async.  Pass TURSO_DATABASE_URL + TURSO_AUTH_TOKEN env vars to use remote
 * storage; otherwise falls back to a local .db file.
 */

const { createClient } = require("@libsql/client");
const { randomBytes } = require("node:crypto");
const { promises: fs } = require("node:fs");
const path = require("node:path");

const VAULT_VERSION = 1;

// Individual CREATE TABLE statements (libsql does not support multi-statement exec)
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS documents (
    cid               TEXT PRIMARY KEY,
    typed_hash        TEXT NOT NULL,
    protocol          TEXT,
    doc_type          TEXT NOT NULL,
    stored_at         TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    document_json     TEXT NOT NULL,
    verification_json TEXT NOT NULL,
    metadata_json     TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS publications (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    document_cid TEXT NOT NULL,
    published_at TEXT NOT NULL,
    data_json    TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settlements (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    document_cid TEXT NOT NULL,
    recorded_at  TEXT NOT NULL,
    data_json    TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS bids_by_listing (
    listing_cid TEXT NOT NULL,
    bid_cid     TEXT NOT NULL,
    PRIMARY KEY (listing_cid, bid_cid)
  )`,
  `CREATE TABLE IF NOT EXISTS acp_jobs (
    job_id     TEXT PRIMARY KEY,
    updated_at TEXT NOT NULL,
    data_json  TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS acp_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    recorded_at TEXT NOT NULL,
    data_json   TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS activity (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event        TEXT NOT NULL,
    recorded_at  TEXT NOT NULL,
    details_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS listing_observations (
    listing_cid   TEXT PRIMARY KEY,
    title         TEXT,
    observed_at   TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    snapshot_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reputation_attestations (
    attestation_key TEXT PRIMARY KEY,
    recorded_at     TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    data_json       TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS human_pauses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_cid TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    decided_at  TEXT,
    data_json   TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS peers (
    url          TEXT PRIMARY KEY,
    added_at     TEXT NOT NULL,
    last_seen_at TEXT,
    status       TEXT NOT NULL DEFAULT 'unknown'
  )`
];

class SqliteNegotiationVault {
  /**
   * @param {string} dbPathOrUrl - File path OR libsql:// URL. If a bare file
   *   path is given it is converted to a file: URL automatically.
   * @param {object} helpers - Injected helper functions from anp_engine.js
   * @param {object} [options]
   * @param {string} [options.authToken] - Turso auth token (remote only)
   */
  constructor(dbPathOrUrl, helpers = {}, { authToken = null } = {}) {
    const raw = dbPathOrUrl || ":memory:";
    if (raw === ":memory:") {
      this._url = "file::memory:?cache=shared";
    } else if (raw.startsWith("libsql://") || raw.startsWith("https://") || raw.startsWith("file:")) {
      this._url = raw;
    } else {
      this._url = `file:${path.resolve(raw)}`;
    }
    this.vaultPath = dbPathOrUrl; // kept for runtime.js compatibility
    this._authToken = authToken || null;
    this._helpers = helpers;
    this._client = null;
    this._ready = null; // Promise from _init(), reused across calls
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  _getClient() {
    if (!this._client) {
      this._client = createClient({
        url: this._url,
        ...(this._authToken ? { authToken: this._authToken } : {})
      });
    }
    return this._client;
  }

  async _init() {
    if (this._ready) return this._ready;
    this._ready = (async () => {
      const client = this._getClient();
      await client.batch(SCHEMA_STATEMENTS.map((sql) => ({ sql, args: [] })), "deferred");
    })();
    return this._ready;
  }

  _now() { return new Date().toISOString(); }
  _j(v)  { return JSON.stringify(v ?? null); }
  _p(t)  { try { return JSON.parse(t); } catch (err) { console.error(`[VAULT] JSON parse error: ${err.message}`); return null; } }

  async _hydrateDocument(row) {
    if (!row) return null;
    const client = this._getClient();
    const [pubs, setts] = await Promise.all([
      client.execute({
        sql: "SELECT published_at, data_json FROM publications WHERE document_cid = ? ORDER BY id ASC",
        args: [row.cid]
      }),
      client.execute({
        sql: "SELECT recorded_at, data_json FROM settlements WHERE document_cid = ? ORDER BY id ASC",
        args: [row.cid]
      })
    ]);
    return {
      cid:          row.cid,
      typedHash:    row.typed_hash,
      protocol:     row.protocol,
      type:         row.doc_type,
      storedAt:     row.stored_at,
      updatedAt:    row.updated_at,
      document:     this._p(row.document_json),
      verification: this._p(row.verification_json),
      metadata:     this._p(row.metadata_json),
      publications: pubs.rows.map((p) => ({ publishedAt: p.published_at, ...this._p(p.data_json) })),
      settlements:  setts.rows.map((s) => ({ recordedAt: s.recorded_at, ...this._p(s.data_json) }))
    };
  }

  // ─── Migration ─────────────────────────────────────────────────────────────

  async _migrateFromJson() {
    const jsonPath = this.vaultPath && !this.vaultPath.startsWith("libsql://")
      ? String(this.vaultPath).replace(/\.db$/, ".json")
      : null;
    if (!jsonPath) return;

    let raw;
    try { raw = await fs.readFile(jsonPath, "utf8"); } catch { return; }

    let state;
    try { state = JSON.parse(raw); } catch { return; }
    if (!state || typeof state !== "object") return;

    const client = this._getClient();
    const countRes = await client.execute("SELECT COUNT(*) as n FROM documents");
    if (Number(countRes.rows[0].n) > 0) return; // already has data

    const now = this._now();
    const stmts = [];

    const docs = state.documents || {};
    for (const [cid, entry] of Object.entries(docs)) {
      stmts.push({
        sql: `INSERT OR IGNORE INTO documents
              (cid, typed_hash, protocol, doc_type, stored_at, updated_at, document_json, verification_json, metadata_json)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          cid, entry.typedHash || "", entry.protocol || null, entry.type || "listing",
          entry.storedAt || now, entry.updatedAt || now,
          this._j(entry.document), this._j(entry.verification), this._j(entry.metadata)
        ]
      });
      for (const pub of (Array.isArray(entry.publications) ? entry.publications : [])) {
        const { publishedAt, ...rest } = pub;
        stmts.push({ sql: "INSERT INTO publications (document_cid, published_at, data_json) VALUES (?, ?, ?)", args: [cid, publishedAt || now, this._j(rest)] });
      }
      for (const sett of (Array.isArray(entry.settlements) ? entry.settlements : [])) {
        const { recordedAt, ...rest } = sett;
        stmts.push({ sql: "INSERT INTO settlements (document_cid, recorded_at, data_json) VALUES (?, ?, ?)", args: [cid, recordedAt || now, this._j(rest)] });
      }
    }
    for (const [listingCid, bidCids] of Object.entries(state.bidsByListingCid || {})) {
      if (!Array.isArray(bidCids)) continue;
      for (const bidCid of bidCids) {
        stmts.push({ sql: "INSERT OR IGNORE INTO bids_by_listing (listing_cid, bid_cid) VALUES (?, ?)", args: [listingCid, bidCid] });
      }
    }
    for (const [jobId, data] of Object.entries((state.acp || {}).jobs || {})) {
      stmts.push({ sql: "INSERT OR IGNORE INTO acp_jobs (job_id, updated_at, data_json) VALUES (?, ?, ?)", args: [jobId, data.updatedAt || now, this._j(data)] });
    }
    for (const ev of ((state.acp || {}).events || [])) {
      const { recordedAt, ...rest } = ev;
      stmts.push({ sql: "INSERT INTO acp_events (recorded_at, data_json) VALUES (?, ?)", args: [recordedAt || now, this._j(rest)] });
    }
    for (const act of (state.activity || [])) {
      stmts.push({ sql: "INSERT INTO activity (event, recorded_at, details_json) VALUES (?, ?, ?)", args: [act.event || "unknown", act.recordedAt || now, this._j(act.details)] });
    }
    for (const [listingCid, obs] of Object.entries((state.observations || {}).listings || {})) {
      stmts.push({
        sql: "INSERT OR IGNORE INTO listing_observations (listing_cid, title, observed_at, metadata_json, snapshot_json) VALUES (?, ?, ?, ?, ?)",
        args: [listingCid, obs.title || null, obs.observedAt || now, this._j(obs.metadata), this._j(obs.snapshot)]
      });
    }
    for (const att of ((state.reputation || {}).attestations || [])) {
      const key = att.attestationKey || `migrated-${randomBytes(16).toString("hex")}`;
      stmts.push({ sql: "INSERT OR IGNORE INTO reputation_attestations (attestation_key, recorded_at, updated_at, data_json) VALUES (?, ?, ?, ?)", args: [key, att.recordedAt || now, att.updatedAt || now, this._j(att)] });
    }
    for (const pause of ((state.reputation || {}).humanPauses || [])) {
      stmts.push({ sql: "INSERT INTO human_pauses (listing_cid, recorded_at, decided_at, data_json) VALUES (?, ?, ?, ?)", args: [pause.listingCid || "", pause.recordedAt || now, pause.decidedAt || null, this._j(pause)] });
    }

    if (stmts.length > 0) await client.batch(stmts, "write");

    try { await fs.rename(jsonPath, jsonPath.replace(/\.json$/, ".json.migrated")); } catch { /* best-effort */ }
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  async load() {
    await this._init();
    await this._migrateFromJson();

    const client = this._getClient();
    const now = this._now();

    const [docRes, bidRes, obsRes, actRes, jobRes, evRes, attRes, pauseRes] = await Promise.all([
      client.execute("SELECT * FROM documents ORDER BY stored_at ASC"),
      client.execute("SELECT listing_cid, bid_cid FROM bids_by_listing"),
      client.execute("SELECT * FROM listing_observations"),
      client.execute("SELECT event, recorded_at, details_json FROM activity ORDER BY id ASC"),
      client.execute("SELECT job_id, updated_at, data_json FROM acp_jobs"),
      client.execute("SELECT recorded_at, data_json FROM acp_events ORDER BY id ASC"),
      client.execute("SELECT attestation_key, recorded_at, updated_at, data_json FROM reputation_attestations"),
      client.execute("SELECT id, listing_cid, recorded_at, decided_at, data_json FROM human_pauses ORDER BY id ASC")
    ]);

    const documents = {};
    await Promise.all(docRes.rows.map(async (row) => {
      documents[row.cid] = await this._hydrateDocument(row);
    }));

    const listing    = docRes.rows.filter((r) => r.doc_type === "listing").map((r) => r.cid);
    const bid        = docRes.rows.filter((r) => r.doc_type === "bid").map((r) => r.cid);
    const acceptance = docRes.rows.filter((r) => r.doc_type === "acceptance").map((r) => r.cid);
    const byTypedHash = {};
    for (const row of docRes.rows) { if (row.typed_hash) byTypedHash[row.typed_hash] = row.cid; }

    const bidsByListingCid = {};
    for (const row of bidRes.rows) {
      bidsByListingCid[row.listing_cid] = bidsByListingCid[row.listing_cid] || [];
      if (!bidsByListingCid[row.listing_cid].includes(row.bid_cid)) bidsByListingCid[row.listing_cid].push(row.bid_cid);
    }

    const obsListings = {};
    for (const row of obsRes.rows) {
      obsListings[row.listing_cid] = { listingCid: row.listing_cid, title: row.title, observedAt: row.observed_at, metadata: this._p(row.metadata_json), snapshot: this._p(row.snapshot_json) };
    }

    const activity = actRes.rows.map((r) => ({ event: r.event, recordedAt: r.recorded_at, details: this._p(r.details_json) || {} }));

    const acpJobs = {};
    for (const row of jobRes.rows) { acpJobs[row.job_id] = { ...this._p(row.data_json), jobId: row.job_id, updatedAt: row.updated_at }; }

    const acpEvents = evRes.rows.map((r) => ({ ...this._p(r.data_json), recordedAt: r.recorded_at }));

    const attestations = attRes.rows.map((r) => ({ ...this._p(r.data_json), attestationKey: r.attestation_key, recordedAt: r.recorded_at, updatedAt: r.updated_at }));

    const humanPauses = pauseRes.rows.map((r) => ({ ...this._p(r.data_json), listingCid: r.listing_cid, recordedAt: r.recorded_at, decidedAt: r.decided_at || undefined }));

    const firstDoc = docRes.rows[0];
    const createdAt = (firstDoc && firstDoc.stored_at) || now;

    return {
      version: VAULT_VERSION, createdAt, updatedAt: now, documents,
      indexes: { listing, bid, acceptance, byTypedHash },
      bidsByListingCid,
      observations: { listings: obsListings },
      activity,
      acp: { jobs: acpJobs, events: acpEvents },
      reputation: { attestations, humanPauses }
    };
  }

  async storeSignedDocument(document, metadata = {}) {
    const {
      computeCID, normalizeDocumentType, getPrimaryTypeForDocument,
      buildTypedData, TypedDataEncoder, verifyDocument,
      normalizeForCanonicalJson, getEnvelopeVariant, isNonEmptyString, ANP_DOMAIN
    } = this._helpers;

    await this._init();
    const client = this._getClient();
    const now = this._now();
    const cid = computeCID(document);
    const documentType = normalizeDocumentType(document.type);
    const primaryType = getPrimaryTypeForDocument(document);
    const typedData = buildTypedData(primaryType, document.data, ANP_DOMAIN, { variant: getEnvelopeVariant(document) });
    const typedHash = TypedDataEncoder.hash(typedData.domain, typedData.types, typedData.message);
    const verification = verifyDocument(document);
    const normalizedDoc = normalizeForCanonicalJson(document);
    const normalizedMeta = normalizeForCanonicalJson(metadata);

    const existingRes = await client.execute({ sql: "SELECT cid, stored_at, metadata_json FROM documents WHERE cid = ?", args: [cid] });
    const existing = existingRes.rows[0] || null;
    const storedAt = existing ? existing.stored_at : now;
    const mergedMeta = normalizeForCanonicalJson({ ...(existing ? this._p(existing.metadata_json) : {}), ...normalizedMeta });

    const stmts = [
      {
        sql: `INSERT INTO documents (cid, typed_hash, protocol, doc_type, stored_at, updated_at, document_json, verification_json, metadata_json)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(cid) DO UPDATE SET
                typed_hash = excluded.typed_hash, protocol = excluded.protocol,
                doc_type = excluded.doc_type, updated_at = excluded.updated_at,
                document_json = excluded.document_json,
                verification_json = excluded.verification_json,
                metadata_json = excluded.metadata_json`,
        args: [cid, typedHash, document.protocol || null, documentType, storedAt, now, this._j(normalizedDoc), this._j(verification), this._j(mergedMeta)]
      },
      {
        sql: "INSERT INTO activity (event, recorded_at, details_json) VALUES (?, ?, ?)",
        args: ["document-stored", now, this._j({ cid, type: documentType, listingCid: normalizedMeta.listingCid || null })]
      }
    ];

    if (documentType === "bid" && isNonEmptyString(normalizedMeta.listingCid)) {
      stmts.push({ sql: "INSERT OR IGNORE INTO bids_by_listing (listing_cid, bid_cid) VALUES (?, ?)", args: [normalizedMeta.listingCid, cid] });
    }

    await client.batch(stmts, "write");

    const rowRes = await client.execute({ sql: "SELECT * FROM documents WHERE cid = ?", args: [cid] });
    return this._hydrateDocument(rowRes.rows[0]);
  }

  async removeDocuments(predicate, details = {}) {
    if (typeof predicate !== "function") throw new TypeError("removeDocuments expects a predicate function.");
    const { normalizeForCanonicalJson } = this._helpers;

    await this._init();
    const client = this._getClient();
    const now = this._now();
    const docRes = await client.execute("SELECT * FROM documents");
    const removed = [];
    const stmts = [];

    for (const row of docRes.rows) {
      const entry = await this._hydrateDocument(row);
      if (!predicate(entry, row.cid)) continue;
      removed.push({ cid: row.cid, type: row.doc_type, typedHash: row.typed_hash });
      stmts.push({ sql: "DELETE FROM documents WHERE cid = ?", args: [row.cid] });
      stmts.push({ sql: "DELETE FROM publications WHERE document_cid = ?", args: [row.cid] });
      stmts.push({ sql: "DELETE FROM settlements WHERE document_cid = ?", args: [row.cid] });
      stmts.push({ sql: "DELETE FROM bids_by_listing WHERE bid_cid = ?", args: [row.cid] });
    }

    if (removed.length > 0) {
      stmts.push({ sql: "INSERT INTO activity (event, recorded_at, details_json) VALUES (?, ?, ?)", args: ["documents-removed", now, this._j(normalizeForCanonicalJson({ count: removed.length, removed, ...details }))] });
      await client.batch(stmts, "write");
    }
    return removed;
  }

  async recordListingObservation(listing, metadata = {}) {
    const { getListingCid, getListingTitle, normalizeForCanonicalJson } = this._helpers;
    await this._init();
    const client = this._getClient();
    const now = this._now();
    const listingCid = getListingCid(listing);
    const title = getListingTitle(listing);
    const normalizedMeta = normalizeForCanonicalJson(metadata);
    const snapshot = normalizeForCanonicalJson(listing);

    await client.batch([
      {
        sql: `INSERT INTO listing_observations (listing_cid, title, observed_at, metadata_json, snapshot_json)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(listing_cid) DO UPDATE SET
                title = excluded.title, observed_at = excluded.observed_at,
                metadata_json = excluded.metadata_json, snapshot_json = excluded.snapshot_json`,
        args: [listingCid, title, now, this._j(normalizedMeta), this._j(snapshot)]
      },
      { sql: "INSERT INTO activity (event, recorded_at, details_json) VALUES (?, ?, ?)", args: ["listing-observed", now, this._j({ listingCid, adapter: normalizedMeta.adapter || null })] }
    ], "write");

    return { listingCid, title, observedAt: now, metadata: normalizedMeta, snapshot };
  }

  async recordPublication(documentCid, publication) {
    const { normalizeForCanonicalJson } = this._helpers;
    await this._init();
    const client = this._getClient();
    const existsRes = await client.execute({ sql: "SELECT cid FROM documents WHERE cid = ?", args: [documentCid] });
    if (!existsRes.rows[0]) throw new Error(`Cannot record publication; unknown document ${documentCid}`);
    const now = this._now();
    const { publishedAt, ...rest } = normalizeForCanonicalJson(publication);
    await client.batch([
      { sql: "INSERT INTO publications (document_cid, published_at, data_json) VALUES (?, ?, ?)", args: [documentCid, publishedAt || now, this._j(rest)] },
      { sql: "INSERT INTO activity (event, recorded_at, details_json) VALUES (?, ?, ?)", args: ["document-published", now, this._j({ documentCid, adapter: publication.adapter || null })] }
    ], "write");
  }

  async recordSettlement(documentCid, settlement) {
    const { normalizeForCanonicalJson } = this._helpers;
    await this._init();
    const client = this._getClient();
    const existsRes = await client.execute({ sql: "SELECT cid FROM documents WHERE cid = ?", args: [documentCid] });
    if (!existsRes.rows[0]) throw new Error(`Cannot record settlement; unknown document ${documentCid}`);
    const now = this._now();
    const { recordedAt, ...rest } = normalizeForCanonicalJson(settlement);
    await client.batch([
      { sql: "INSERT INTO settlements (document_cid, recorded_at, data_json) VALUES (?, ?, ?)", args: [documentCid, recordedAt || now, this._j(rest)] },
      { sql: "INSERT INTO activity (event, recorded_at, details_json) VALUES (?, ?, ?)", args: ["settlement-recorded", now, this._j({ documentCid, txHash: settlement.txHash || null })] }
    ], "write");
  }

  async hasBidForListingCid(listingCid) {
    await this._init();
    const client = this._getClient();
    const res = await client.execute({ sql: "SELECT COUNT(*) as n FROM bids_by_listing WHERE listing_cid = ?", args: [listingCid] });
    return Number(res.rows[0].n) > 0;
  }

  async getDocument(documentCid) {
    await this._init();
    await this._migrateFromJson();
    const client = this._getClient();
    const res = await client.execute({ sql: "SELECT * FROM documents WHERE cid = ?", args: [documentCid] });
    return this._hydrateDocument(res.rows[0] || null);
  }

  async getDocumentByTypedHash(typedHash) {
    await this._init();
    await this._migrateFromJson();
    const client = this._getClient();
    const res = await client.execute({ sql: "SELECT * FROM documents WHERE typed_hash = ?", args: [typedHash] });
    return this._hydrateDocument(res.rows[0] || null);
  }

  async recordACPJob(jobId, data = {}) {
    const { normalizeForCanonicalJson } = this._helpers;
    await this._init();
    const client = this._getClient();
    const now = this._now();
    const key = String(jobId);
    const existRes = await client.execute({ sql: "SELECT data_json FROM acp_jobs WHERE job_id = ?", args: [key] });
    const merged = { ...(existRes.rows[0] ? this._p(existRes.rows[0].data_json) : {}), ...normalizeForCanonicalJson(data), jobId: key, updatedAt: now };
    await client.batch([
      { sql: "INSERT INTO acp_jobs (job_id, updated_at, data_json) VALUES (?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET updated_at = excluded.updated_at, data_json = excluded.data_json", args: [key, now, this._j(merged)] },
      { sql: "INSERT INTO activity (event, recorded_at, details_json) VALUES (?, ?, ?)", args: ["acp-job-recorded", now, this._j({ jobId: key })] }
    ], "write");
    return { ...merged };
  }

  async recordACPEvent(eventData = {}) {
    const { normalizeForCanonicalJson } = this._helpers;
    await this._init();
    const client = this._getClient();
    const now = this._now();
    const normalized = normalizeForCanonicalJson(eventData);
    await client.batch([
      { sql: "INSERT INTO acp_events (recorded_at, data_json) VALUES (?, ?)", args: [now, this._j(normalized)] },
      { sql: "INSERT INTO activity (event, recorded_at, details_json) VALUES (?, ?, ?)", args: ["acp-event-recorded", now, this._j({ eventName: eventData.eventName || null, jobId: eventData.jobId || null })] }
    ], "write");
    return { ...normalized, recordedAt: now };
  }

  async recordHumanPause(pause = {}) {
    const { normalizeForCanonicalJson } = this._helpers;
    await this._init();
    const client = this._getClient();
    const now = this._now();
    const normalized = normalizeForCanonicalJson(pause);
    await client.batch([
      { sql: "INSERT INTO human_pauses (listing_cid, recorded_at, decided_at, data_json) VALUES (?, ?, ?, ?)", args: [pause.listingCid || "", now, null, this._j({ ...normalized, recordedAt: now })] },
      { sql: "INSERT INTO activity (event, recorded_at, details_json) VALUES (?, ?, ?)", args: ["human-pause-recorded", now, this._j({ listingCid: pause.listingCid || null, title: pause.title || null })] }
    ], "write");
    return { ...normalized, recordedAt: now };
  }

  async resolveHumanPause({ listingCid, decision, actor, note } = {}) {
    if (!listingCid) throw new Error("listingCid is required to resolve a human pause.");
    if (!["approve", "reject"].includes(decision)) throw new Error('decision must be "approve" or "reject".');
    const { normalizeForCanonicalJson } = this._helpers;
    await this._init();
    const client = this._getClient();
    const now = this._now();
    const pausesRes = await client.execute({ sql: "SELECT id, data_json, recorded_at, decided_at FROM human_pauses WHERE listing_cid = ? ORDER BY id DESC", args: [listingCid] });
    if (!pausesRes.rows.length) throw new Error(`No human pause found for listing ${listingCid}.`);
    const target = pausesRes.rows.find((r) => !this._p(r.data_json).decidedAt && !r.decided_at) || pausesRes.rows[0];
    const existing = this._p(target.data_json);
    const resolved = normalizeForCanonicalJson({ ...existing, approved: decision === "approve", decision, decidedAt: now, decidedBy: actor || "owner", note: note || existing.note || null });
    await client.batch([
      { sql: "UPDATE human_pauses SET decided_at = ?, data_json = ? WHERE id = ?", args: [now, this._j(resolved), target.id] },
      { sql: "INSERT INTO activity (event, recorded_at, details_json) VALUES (?, ?, ?)", args: ["human-pause-resolved", now, this._j({ listingCid, decision, title: resolved.title || null })] }
    ], "write");
    return resolved;
  }

  async getMostRecentHumanPauseForListing(listingCid) {
    await this._init();
    const client = this._getClient();
    const res = await client.execute({ sql: "SELECT data_json, recorded_at FROM human_pauses WHERE listing_cid = ? ORDER BY id DESC LIMIT 1", args: [listingCid] });
    if (!res.rows[0]) return null;
    return { ...this._p(res.rows[0].data_json), recordedAt: res.rows[0].recorded_at };
  }

  async getReputationAttestationByKey(attestationKey) {
    await this._init();
    const client = this._getClient();
    const res = await client.execute({ sql: "SELECT * FROM reputation_attestations WHERE attestation_key = ?", args: [attestationKey] });
    if (!res.rows[0]) return null;
    const row = res.rows[0];
    return { ...this._p(row.data_json), attestationKey: row.attestation_key, recordedAt: row.recorded_at, updatedAt: row.updated_at };
  }

  async recordReputationAttestation(attestation = {}) {
    const { normalizeForCanonicalJson } = this._helpers;
    await this._init();
    const client = this._getClient();
    const now = this._now();
    const normalized = normalizeForCanonicalJson(attestation);
    const key = normalized.attestationKey || null;

    let record;
    if (key) {
      const existRes = await client.execute({ sql: "SELECT * FROM reputation_attestations WHERE attestation_key = ?", args: [key] });
      record = { ...(existRes.rows[0] ? this._p(existRes.rows[0].data_json) : {}), ...normalized, updatedAt: now };
      if (!record.recordedAt) record.recordedAt = now;
      await client.execute({ sql: "INSERT INTO reputation_attestations (attestation_key, recorded_at, updated_at, data_json) VALUES (?, ?, ?, ?) ON CONFLICT(attestation_key) DO UPDATE SET updated_at = excluded.updated_at, data_json = excluded.data_json", args: [key, record.recordedAt, now, this._j(record)] });
    } else {
      record = { ...normalized, updatedAt: now };
      if (!record.recordedAt) record.recordedAt = now;
      const generatedKey = `anon-${Date.now()}-${randomBytes(8).toString("hex")}`;
      await client.execute({ sql: "INSERT INTO reputation_attestations (attestation_key, recorded_at, updated_at, data_json) VALUES (?, ?, ?, ?)", args: [generatedKey, record.recordedAt, now, this._j(record)] });
    }

    await client.execute({ sql: "INSERT INTO activity (event, recorded_at, details_json) VALUES (?, ?, ?)", args: ["reputation-attestation-recorded", now, this._j({ attestationKey: record.attestationKey || null, jobId: record.jobId || null, published: Boolean(record.onchain && record.onchain.published) })] });
    return record;
  }

  // ─── Peer-to-peer discovery ────────────────────────────────────────────────

  async addPeer(url) {
    await this._init();
    const client = this._getClient();
    const now = this._now();
    const normalized = url.replace(/\/$/, "");
    await client.execute({ sql: "INSERT INTO peers (url, added_at, status) VALUES (?, ?, 'unknown') ON CONFLICT(url) DO NOTHING", args: [normalized, now] });
    return this.getPeer(normalized);
  }

  async getPeer(url) {
    await this._init();
    const client = this._getClient();
    const res = await client.execute({ sql: "SELECT * FROM peers WHERE url = ?", args: [url.replace(/\/$/, "")] });
    if (!res.rows[0]) return null;
    const row = res.rows[0];
    return { url: row.url, addedAt: row.added_at, lastSeenAt: row.last_seen_at, status: row.status };
  }

  async listPeers() {
    await this._init();
    const client = this._getClient();
    const res = await client.execute("SELECT * FROM peers ORDER BY added_at ASC");
    return res.rows.map((r) => ({ url: r.url, addedAt: r.added_at, lastSeenAt: r.last_seen_at, status: r.status }));
  }

  async removePeer(url) {
    await this._init();
    const client = this._getClient();
    await client.execute({ sql: "DELETE FROM peers WHERE url = ?", args: [url.replace(/\/$/, "")] });
  }

  async updatePeerStatus(url, status) {
    await this._init();
    const client = this._getClient();
    const now = this._now();
    await client.execute({ sql: "UPDATE peers SET status = ?, last_seen_at = ? WHERE url = ?", args: [status, now, url.replace(/\/$/, "")] });
  }

  async listACPJobs() {
    await this._init();
    await this._migrateFromJson();
    const client = this._getClient();
    const res = await client.execute("SELECT job_id, updated_at, data_json FROM acp_jobs ORDER BY updated_at DESC");
    return res.rows.map((r) => ({ ...this._p(r.data_json), jobId: r.job_id, updatedAt: r.updated_at }));
  }

  async getACPJob(jobId) {
    await this._init();
    await this._migrateFromJson();
    const client = this._getClient();
    const res = await client.execute({ sql: "SELECT job_id, updated_at, data_json FROM acp_jobs WHERE job_id = ?", args: [String(jobId)] });
    if (!res.rows[0]) return null;
    const row = res.rows[0];
    return { ...this._p(row.data_json), jobId: row.job_id, updatedAt: row.updated_at };
  }
}

module.exports = { SqliteNegotiationVault };
