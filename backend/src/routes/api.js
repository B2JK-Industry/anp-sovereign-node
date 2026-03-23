const express = require("express");
const { toMicroUsdc } = require("../engines/anp_engine");

const {
  getAcpManager,
  getAnpManager,
  getDashboardState,
  getHunter,
  getVaultSnapshot,
  syncFromPeer,
  summarizeDocument
} = require("../services/runtime");
const { getDemoListings, seedDemoData } = require("../services/demo_data");

const router = express.Router();

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function asyncHandler(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

function getBaseUrl(req) {
  const forwardedProto = req.get("x-forwarded-proto");
  const protocol =
    typeof forwardedProto === "string" && forwardedProto.trim()
      ? forwardedProto.split(",")[0].trim()
      : req.protocol;
  return `${protocol}://${req.get("host")}`;
}

function getDocumentEnvelopeVariant(document) {
  const data = document && typeof document.data === "object" ? document.data : {};
  const hasCanonicalHash = [data.contentHash, data.listingHash, data.bidHash].some(
    (value) => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value.trim())
  );

  return document &&
    document.protocol === "ANP" &&
    String(document.version || "1") === "1"
    ? "canonical"
    : hasCanonicalHash
      ? "canonical"
      : "legacy";
}

function getPrimaryTypeForEntry(entry) {
  if (!entry) {
    return null;
  }

  if (entry.type === "listing") {
    return "ListingIntent";
  }

  if (entry.type === "bid") {
    return "BidIntent";
  }

  if (entry.type === "acceptance") {
    return "AcceptIntent";
  }

  return null;
}

function toUnixSeconds(value) {
  if (!value) {
    return null;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.floor(numeric > 1e12 ? numeric / 1000 : numeric);
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null;
}

function paginate(items, pageValue, limitValue) {
  const page = Math.max(1, Number.parseInt(pageValue || "1", 10) || 1);
  const requestedLimit = Number.parseInt(limitValue || "20", 10) || 20;
  const limit = Math.min(Math.max(requestedLimit, 1), 100);
  const total = items.length;
  const pages = total === 0 ? 0 : Math.ceil(total / limit);
  const start = (page - 1) * limit;

  return {
    items: items.slice(start, start + limit),
    pagination: {
      page,
      limit,
      total,
      pages
    }
  };
}

function getBidsForListing(snapshot, listingEntry) {
  const listingCid = listingEntry.cid;
  const listingHash = listingEntry.typedHash;

  return Object.values(snapshot.documents)
    .filter((entry) => entry.type === "bid")
    .filter((entry) => {
      const data = entry.document && entry.document.data ? entry.document.data : {};
      return (
        data.listingCid === listingCid ||
        (entry.metadata && entry.metadata.listingCid === listingCid) ||
        data.listingHash === listingHash
      );
    })
    .sort((left, right) => Date.parse(right.updatedAt || right.storedAt || 0) -
      Date.parse(left.updatedAt || left.storedAt || 0));
}

function getAcceptancesForListing(snapshot, listingEntry) {
  const listingCid = listingEntry.cid;
  const listingHash = listingEntry.typedHash;

  return Object.values(snapshot.documents)
    .filter((entry) => entry.type === "acceptance")
    .filter((entry) => {
      const data = entry.document && entry.document.data ? entry.document.data : {};
      return (
        data.listingCid === listingCid ||
        data.listingHash === listingHash ||
        (
          entry.metadata &&
          entry.metadata.automation &&
          entry.metadata.automation.settlement &&
          entry.metadata.automation.settlement.listingCid === listingCid
        )
      );
    })
    .sort((left, right) => Date.parse(right.updatedAt || right.storedAt || 0) -
      Date.parse(left.updatedAt || left.storedAt || 0));
}

function countUniqueBidSigners(bids) {
  return new Set(
    bids
      .map((entry) => entry && entry.document && entry.document.signer)
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.toLowerCase())
  ).size;
}

function getObservationForListing(snapshot, listingEntry) {
  return Object.values(snapshot.observations && snapshot.observations.listings
    ? snapshot.observations.listings
    : {})
    .find((observation) => {
      const listing = observation.snapshot || {};
      return (
        observation.listingCid === listingEntry.cid ||
        listing.documentCid === listingEntry.cid ||
        listing.cid === listingEntry.cid ||
        listing.listingHash === listingEntry.typedHash
      );
    }) || null;
}

function summarizeAnpListing(snapshot, entry) {
  const bids = getBidsForListing(snapshot, entry);
  const acceptances = getAcceptancesForListing(snapshot, entry);
  const observation = getObservationForListing(snapshot, entry);
  const observationSnapshot = observation && observation.snapshot ? observation.snapshot : {};
  const data = {
    ...((observationSnapshot && observationSnapshot.data) || {}),
    ...entry.document.data
  };

  if (!data.title && observationSnapshot.title) {
    data.title = observationSnapshot.title;
  }

  if (!data.description && observationSnapshot.description) {
    data.description = observationSnapshot.description;
  }

  const status = acceptances.length > 0 ? "accepted" : bids.length > 0 ? "negotiating" : "open";

  return {
    cid: entry.cid,
    signer: entry.document.signer,
    status,
    bidCount: bids.length,
    uniqueAgentCount: countUniqueBidSigners(bids),
    data,
    createdAt: toUnixSeconds(entry.storedAt || entry.updatedAt),
    updatedAt: toUnixSeconds(entry.updatedAt || entry.storedAt)
  };
}

function summarizeAnpBid(entry) {
  const data = entry && entry.document && entry.document.data ? entry.document.data : {};
  const message = data.message && typeof data.message === "object"
    ? data.message
    : null;

  return {
    cid: entry.cid,
    signer: entry.document.signer,
    listingCid:
      data.listingCid ||
      (entry.metadata && entry.metadata.listingCid) ||
      null,
    priceMicroUsdc: data.price || null,
    priceUsdc:
      data.price === null || typeof data.price === "undefined"
        ? null
        : Number(data.price) / 1_000_000,
    deliverySeconds: data.deliveryTime || null,
    messageSummary:
      (message && (message.summary || message.message || message.title)) ||
      (typeof data.message === "string" ? data.message : null),
    document: entry.document,
    createdAt: toUnixSeconds(entry.storedAt || entry.updatedAt)
  };
}

function matchesListingReference(listing, reference) {
  if (!listing || !reference) {
    return false;
  }

  const normalizedReference = String(reference).trim().toLowerCase();
  const candidates = [
    listing.listingCid,
    listing.cid,
    listing.id,
    listing.discoveryId,
    listing.documentCid,
    listing.listingHash
  ]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim().toLowerCase());

  return candidates.includes(normalizedReference);
}

function findDemoListingForPause(demoListings, reference, demoScenario) {
  const listings = Array.isArray(demoListings) ? demoListings : [];
  if (!listings.length) {
    return null;
  }

  const exactReferenceMatch = listings.find((listing) =>
    matchesListingReference(listing, reference)
  );
  if (exactReferenceMatch) {
    return exactReferenceMatch;
  }

  const normalizedScenario =
    typeof demoScenario === "string" && demoScenario.trim()
      ? demoScenario.trim().toLowerCase()
      : null;
  if (normalizedScenario) {
    const scenarioMatch = listings.find((listing) =>
      [listing.id, listing.discoveryId]
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim().toLowerCase())
        .includes(normalizedScenario)
    );
    if (scenarioMatch) {
      return scenarioMatch;
    }
  }

  const pausedScenario = listings.find((listing) =>
    ["demo-listing-high-value", "paused"]
      .includes(
        String(listing.id || listing.scenario || "")
          .trim()
          .toLowerCase()
      )
  );
  if (pausedScenario) {
    return pausedScenario;
  }

  return null;
}

function deriveDemoPauseBidUsdc(listing) {
  const maxBudget = Number(
    (listing && listing.maxBudget) ||
      (listing && listing.data && listing.data.maxBudget) ||
      0
  );
  if (!Number.isFinite(maxBudget) || maxBudget <= 0) {
    return null;
  }

  const bidCount = Number(listing && listing.bidCount);
  const ratio = Number.isFinite(bidCount) && bidCount >= 3 ? 0.7 : 0.9;
  return String(Number(((maxBudget / 1_000_000) * ratio).toFixed(2)));
}

function buildSyntheticResolvedPause(listing, decision, note, requestedListingCid = null) {
  const approved = decision === "approve";

  return {
    listingCid:
      requestedListingCid ||
      (listing && listing.listingCid) ||
      (listing && listing.cid) ||
      null,
    demoScenario:
      (listing && listing.id) ||
      (listing && listing.discoveryId) ||
      null,
    title: (listing && listing.title) || "Demo mission",
    clientId:
      (listing && listing.clientAddress) ||
      (listing && listing.clientId) ||
      null,
    proposedBidUsdc: deriveDemoPauseBidUsdc(listing),
    confidence: 0.5,
    reason: "Demo high-value listing waiting for manual approval.",
    approved,
    decision,
    decidedAt: new Date().toISOString(),
    decidedBy: "dashboard-owner",
    note: note || `Resolved from stateless demo fallback (${decision}).`,
    synthetic: true,
    volatile: true
  };
}

function isVolatileRuntime(anp) {
  return Boolean(
    anp &&
      anp.vault &&
      typeof anp.vault.vaultPath === "string" &&
      anp.vault.vaultPath.startsWith("/tmp/")
  );
}

function derivePublishMetadata(document) {
  const data = document && document.data && typeof document.data === "object"
    ? document.data
    : {};

  return {
    source: "api-anp-publish",
    listingCid: data.listingCid || null,
    bidCid: data.bidCid || null
  };
}

function resolveReferencedEntry(snapshot, options = {}) {
  if (options.cid && snapshot.documents[options.cid]) {
    return snapshot.documents[options.cid];
  }

  if (options.typedHash) {
    return (
      Object.values(snapshot.documents).find((entry) => entry.typedHash === options.typedHash) ||
      null
    );
  }

  return null;
}

function buildApiMeta(req) {
  const baseUrl = getBaseUrl(req);
  const apiBaseUrl = `${baseUrl}/api`;

  return {
    ok: true,
    service: "anp-backend",
    baseUrl,
    dashboardUrl: `${baseUrl}/`,
    skillUrl: `${baseUrl}/SKILL.md`,
    openApiUrl: `${baseUrl}/openapi.json`,
    notes: [
      "If discovery is not configured, GET /api/listings/open returns demo listings.",
      "The API currently has no authentication. Do not expose write routes without protection.",
      "Signed ANP documents are verified locally from the document payload and signature."
    ],
    endpoints: [
      {
        name: "health",
        method: "GET",
        path: "/api/health",
        url: `${apiBaseUrl}/health`,
        description: "Basic liveness check."
      },
      {
        name: "status",
        method: "GET",
        path: "/api/status",
        url: `${apiBaseUrl}/status`,
        description: "Runtime status for wallet, discovery, settlement, and vault counts."
      },
      {
        name: "vault",
        method: "GET",
        path: "/api/vault",
        url: `${apiBaseUrl}/vault`,
        description: "Vault summary. Add ?full=1 for the full snapshot."
      },
      {
        name: "openListings",
        method: "GET",
        path: "/api/listings",
        url: `${apiBaseUrl}/listings`,
        description: "Alias for /api/listings/open."
      },
      {
        name: "openListings",
        method: "GET",
        path: "/api/listings/open",
        url: `${apiBaseUrl}/listings/open`,
        description: "List current opportunities from live discovery or demo mode."
      },
      {
        name: "createListing",
        method: "POST",
        path: "/api/listings",
        url: `${apiBaseUrl}/listings`,
        description: "Create a signed listing with the node wallet and optionally publish it.",
        jsonBody: {
          title: "Build a token price API",
          description: "REST endpoint returning the top 50 token prices with 24h change.",
          minBudgetUsdc: 10,
          maxBudgetUsdc: 50,
          deadlineHours: 168,
          jobDurationHours: 72,
          publish: false
        }
      },
      {
        name: "scanListings",
        method: "POST",
        path: "/api/listings/scan",
        url: `${apiBaseUrl}/listings/scan`,
        description: "Run hunter scan and optional bid generation.",
        jsonBody: {
          sendBidOnMatch: true,
          deliverySeconds: 86400
        }
      },
      {
        name: "createBid",
        method: "POST",
        path: "/api/bids",
        url: `${apiBaseUrl}/bids`,
        description: "Create a signed ANP bid. Set publish=true to publish it via the active adapter.",
        jsonBody: {
          listingCid: "demo-listing-api-verification",
          listingHash: "0x...",
          priceUsdc: "11.2",
          deliverySeconds: 86400,
          message: {
            summary: "Demo bid for API verification work."
          },
          publish: false
        }
      },
      {
        name: "resolveHumanPause",
        method: "POST",
        path: "/api/interventions/human-pauses",
        url: `${apiBaseUrl}/interventions/human-pauses`,
        description: "Approve or reject a manual intervention pause for a listing.",
        jsonBody: {
          listingCid: "demo-listing-high-value",
          decision: "approve",
          note: "Reviewed by owner from dashboard."
        }
      },
      {
        name: "prepareAcpJob",
        method: "POST",
        path: "/api/acp/jobs/prepare",
        url: `${apiBaseUrl}/acp/jobs/prepare`,
        description: "Prepare ACP settlement parameters from an ANP acceptance CID.",
        jsonBody: {
          acceptCid: "sha256-..."
        }
      },
      {
        name: "createAcpJob",
        method: "POST",
        path: "/api/acp/jobs/create",
        url: `${apiBaseUrl}/acp/jobs/create`,
        description: "Create an on-chain ACP job from an accepted ANP negotiation.",
        jsonBody: {
          acceptCid: "sha256-..."
        }
      },
      {
        name: "fundAcpJob",
        method: "POST",
        path: "/api/acp/jobs/fund",
        url: `${apiBaseUrl}/acp/jobs/fund`,
        description: "Fund an ACP job by locking USDC in the escrow contract. Handles ERC-20 approval automatically.",
        jsonBody: {
          jobId: "1"
        }
      },
      {
        name: "submitAcpWork",
        method: "POST",
        path: "/api/acp/jobs/submit",
        url: `${apiBaseUrl}/acp/jobs/submit`,
        description: "Provider submits a deliverable hash for an ACP job.",
        jsonBody: {
          jobId: "1",
          deliverable: "ipfs://Qm... or any string reference"
        }
      },
      {
        name: "evaluateAcpJob",
        method: "POST",
        path: "/api/acp/jobs/evaluate",
        url: `${apiBaseUrl}/acp/jobs/evaluate`,
        description: "Evaluator approves (releases USDC to provider) or rejects (refunds client) submitted work.",
        jsonBody: {
          jobId: "1",
          decision: "approve",
          reason: "Work meets requirements"
        }
      },
      {
        name: "anpPublish",
        method: "POST",
        path: "/api/anp/publish",
        url: `${apiBaseUrl}/anp/publish`,
        description: "Publish a signed ANP document with local verification and CID dedupe."
      },
      {
        name: "anpListings",
        method: "GET",
        path: "/api/anp/listings",
        url: `${apiBaseUrl}/anp/listings`,
        description: "Browse published ANP listings stored in the sovereign vault."
      },
      {
        name: "anpObject",
        method: "GET",
        path: "/api/anp/objects/:cid",
        url: `${apiBaseUrl}/anp/objects/sha256-...`,
        description: "Resolve any stored ANP object by CID."
      },
      {
        name: "demoListings",
        method: "GET",
        path: "/api/demo/listings",
        url: `${apiBaseUrl}/demo/listings`,
        description: "Return deterministic demo listings."
      },
      {
        name: "demoSeed",
        method: "POST",
        path: "/api/demo/seed",
        url: `${apiBaseUrl}/demo/seed`,
        description: "Seed demo documents, bid, acceptance, ACP job, and reputation records."
      }
    ],
    examples: {
      health: `curl -L ${apiBaseUrl}/health`,
      status: `curl -L ${apiBaseUrl}/status`,
      listings: `curl -L ${apiBaseUrl}/listings/open`,
      demoSeed: `curl -L -X POST ${apiBaseUrl}/demo/seed`,
      scan: `curl -L -X POST ${apiBaseUrl}/listings/scan -H "Content-Type: application/json" -d '{"sendBidOnMatch":true}'`
    }
  };
}

async function getOpenListingsPayload(req) {
  const anp = getAnpManager();
  const useDemo =
    req.query.demo === "1" || !anp.discovery.hasActiveAdapter();
  const listings = useDemo
    ? await getDemoListings(anp)
    : await anp.fetchOpenListings();

  return {
    ok: true,
    mode: useDemo ? "demo" : "live",
    count: listings.length,
    listings
  };
}

function normalizeBudgetInput(microValue, usdcValue, fieldName) {
  if (
    microValue !== null &&
    typeof microValue !== "undefined" &&
    String(microValue).trim() !== ""
  ) {
    return String(microValue).trim();
  }

  if (
    usdcValue !== null &&
    typeof usdcValue !== "undefined" &&
    String(usdcValue).trim() !== ""
  ) {
    return toMicroUsdc(usdcValue);
  }

  throw createHttpError(400, `${fieldName} or ${fieldName}Usdc is required.`);
}

function normalizeFutureTimestampSeconds(rawValue, hoursValue, fieldName) {
  if (
    rawValue !== null &&
    typeof rawValue !== "undefined" &&
    String(rawValue).trim() !== ""
  ) {
    const parsed = toUnixSeconds(rawValue);
    if (!parsed || parsed <= 0) {
      throw createHttpError(400, `${fieldName} must be a valid timestamp.`);
    }

    return String(parsed);
  }

  const numericHours = Number(hoursValue);
  if (!Number.isFinite(numericHours) || numericHours <= 0) {
    throw createHttpError(400, `${fieldName}Hours must be a positive number.`);
  }

  return String(Math.floor(Date.now() / 1000) + Math.round(numericHours * 3600));
}

function normalizeDurationSeconds(rawValue, hoursValue) {
  if (
    rawValue !== null &&
    typeof rawValue !== "undefined" &&
    String(rawValue).trim() !== ""
  ) {
    const numeric = Number(rawValue);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      throw createHttpError(400, "jobDuration must be a positive integer number of seconds.");
    }

    return String(Math.round(numeric));
  }

  const numericHours = Number(hoursValue);
  if (!Number.isFinite(numericHours) || numericHours <= 0) {
    throw createHttpError(400, "jobDurationHours must be a positive number.");
  }

  return String(Math.round(numericHours * 3600));
}

router.get(
  "/meta",
  asyncHandler(async (req, res) => {
    res.json(buildApiMeta(req));
  })
);

router.get(
  "/health",
  asyncHandler(async (req, res) => {
    res.json({
      ok: true,
      service: "anp-backend",
      timestamp: new Date().toISOString(),
      nodeVersion: process.version
    });
  })
);

router.get(
  "/status",
  asyncHandler(async (req, res) => {
    res.json(await getDashboardState());
  })
);

router.get(
  "/vault",
  asyncHandler(async (req, res) => {
    const snapshot = await getVaultSnapshot();

    if (req.query.full === "1") {
      res.json(snapshot);
      return;
    }

    const documents = Object.values(snapshot.documents)
      .sort((left, right) => {
        const leftTime = Date.parse(left.updatedAt || left.storedAt || 0);
        const rightTime = Date.parse(right.updatedAt || right.storedAt || 0);
        return rightTime - leftTime;
      })
      .slice(0, 20)
      .map(summarizeDocument);

    res.json({
      counts: {
        documents: Object.keys(snapshot.documents).length,
        listings: snapshot.indexes.listing.length,
        bids: snapshot.indexes.bid.length,
        acceptances: snapshot.indexes.acceptance.length,
        acpJobs: Object.keys(snapshot.acp.jobs).length,
        acpEvents: snapshot.acp.events.length,
        reputationAttestations: snapshot.reputation.attestations.length,
        humanPauses: snapshot.reputation.humanPauses.length
      },
      documents,
      recentActivity: [...snapshot.activity].slice(-20).reverse()
    });
  })
);

router.get(
  "/listings",
  asyncHandler(async (req, res) => {
    res.json(await getOpenListingsPayload(req));
  })
);

router.get(
  "/listings/open",
  asyncHandler(async (req, res) => {
    res.json(await getOpenListingsPayload(req));
  })
);

router.post(
  "/listings",
  asyncHandler(async (req, res) => {
    const {
      title,
      description,
      minBudget,
      minBudgetUsdc,
      maxBudget,
      maxBudgetUsdc,
      deadline,
      deadlineHours,
      jobDuration,
      jobDurationHours,
      preferredEvaluator,
      publish
    } = req.body || {};

    if (!title || !String(title).trim()) {
      throw createHttpError(400, "title is required.");
    }

    if (!description || !String(description).trim()) {
      throw createHttpError(400, "description is required.");
    }

    const anp = getAnpManager();
    const document = await anp.createListing({
      title: String(title).trim(),
      description: String(description).trim(),
      minBudget: normalizeBudgetInput(minBudget, minBudgetUsdc, "minBudget"),
      maxBudget: normalizeBudgetInput(maxBudget, maxBudgetUsdc, "maxBudget"),
      deadline: normalizeFutureTimestampSeconds(deadline, deadlineHours, "deadline"),
      jobDuration: normalizeDurationSeconds(jobDuration, jobDurationHours),
      preferredEvaluator:
        preferredEvaluator && String(preferredEvaluator).trim()
          ? String(preferredEvaluator).trim()
          : "0x0000000000000000000000000000000000000000"
    });
    const cid = anp.computeCID(document);
    const publication = publish === true ? await anp.publishDocument(document) : null;

    res.status(201).json({
      ok: true,
      cid,
      document,
      publication
    });
  })
);

router.get(
  "/demo/listings",
  asyncHandler(async (req, res) => {
    const listings = await getDemoListings(getAnpManager());

    res.json({
      ok: true,
      mode: "demo",
      count: listings.length,
      listings
    });
  })
);

router.post(
  "/demo/seed",
  asyncHandler(async (req, res) => {
    const result = await seedDemoData(getAnpManager());

    res.status(result.seeded ? 201 : 200).json({
      ok: true,
      mode: "demo",
      ...result
    });
  })
);

router.post(
  "/listings/scan",
  asyncHandler(async (req, res) => {
    const hunter = getHunter();
    const result = await hunter.scanListingsWithLogic({
      sendBidOnMatch: req.body && req.body.sendBidOnMatch === true,
      deliverySeconds: req.body ? req.body.deliverySeconds : undefined
    });

    res.json({
      ok: true,
      count: result.listings.length,
      matches: result.matches
    });
  })
);

router.post(
  "/interventions/human-pauses",
  asyncHandler(async (req, res) => {
    const { listingCid, decision, note, demoScenario } = req.body || {};

    if (!listingCid) {
      throw createHttpError(400, "listingCid is required.");
    }

    if (!["approve", "reject"].includes(decision)) {
      throw createHttpError(400, 'decision must be either "approve" or "reject".');
    }

    const anp = getAnpManager();
    let pause;

    try {
      pause = await anp.vault.resolveHumanPause({
        listingCid,
        decision,
        note,
        actor: "dashboard-owner"
      });
    } catch (error) {
      if (/^No human pause found for listing /i.test(error.message)) {
        const demoListings = await getDemoListings(anp);
        const demoListing = findDemoListingForPause(
          demoListings,
          listingCid,
          demoScenario
        );

        if (demoListing) {
          res.json({
            ok: true,
            pause: buildSyntheticResolvedPause(demoListing, decision, note, listingCid),
            volatile: true,
            synthetic: true
          });
          return;
        }
      }

      throw error;
    }

    res.json({
      ok: true,
      pause,
      volatile: isVolatileRuntime(anp)
    });
  })
);

router.post(
  "/bids",
  asyncHandler(async (req, res) => {
    const {
      listingCid,
      listingHash,
      priceUsdc,
      deliverySeconds,
      message,
      publish
    } = req.body || {};

    if (!listingCid || !listingHash || !priceUsdc || !deliverySeconds || !message) {
      throw createHttpError(
        400,
        "listingCid, listingHash, priceUsdc, deliverySeconds, and message are required."
      );
    }

    const anp = getAnpManager();
    const document = await anp.createBid(
      listingCid,
      listingHash,
      priceUsdc,
      deliverySeconds,
      message
    );
    const cid = anp.computeCID(document);
    const publication = publish === true ? await anp.publishDocument(document) : null;

    res.status(201).json({
      ok: true,
      cid,
      document,
      publication
    });
  })
);

router.post(
  "/acp/jobs/prepare",
  asyncHandler(async (req, res) => {
    const { acceptCid } = req.body || {};

    if (!acceptCid) {
      throw createHttpError(400, "acceptCid is required.");
    }

    const acp = getAcpManager();
    const prepared = await acp.prepareJobParamsFromAcceptIntent(acceptCid);

    res.json({
      ok: true,
      prepared
    });
  })
);

router.post(
  "/anp/publish",
  asyncHandler(async (req, res) => {
    const document = req.body;

    if (!document || typeof document !== "object") {
      throw createHttpError(400, "Signed ANPDocument body is required.");
    }

    const anp = getAnpManager();
    const verification = anp.verifyDocument(document);

    if (!verification.valid) {
      throw createHttpError(
        400,
        verification.error || "Invalid ANP document signature."
      );
    }

    const cid = anp.computeCID(document);
    const snapshot = await getVaultSnapshot();
    const existing = snapshot.documents[cid];
    if (existing) {
      res.status(200).json({
        cid,
        type: existing.type,
        signer: existing.document.signer,
        duplicate: true
      });
      return;
    }

    if (document.type === "bid") {
      const listingRef = resolveReferencedEntry(snapshot, {
        cid: document.data && document.data.listingCid,
        typedHash: document.data && document.data.listingHash
      });
      if (!listingRef) {
        throw createHttpError(422, "Bid references unknown listing CID or listingHash.");
      }
    }

    if (document.type === "acceptance") {
      const listingRef = resolveReferencedEntry(snapshot, {
        cid: document.data && document.data.listingCid,
        typedHash: document.data && document.data.listingHash
      });
      const bidRef = resolveReferencedEntry(snapshot, {
        cid: document.data && document.data.bidCid,
        typedHash: document.data && document.data.bidHash
      });
      if (!listingRef || !bidRef) {
        throw createHttpError(
          422,
          "Acceptance references unknown listing or bid."
        );
      }
    }

    await anp.vault.storeSignedDocument(document, derivePublishMetadata(document));

    res.status(201).json({
      cid,
      type: document.type,
      signer: document.signer
    });
  })
);

router.get(
  "/anp/listings",
  asyncHandler(async (req, res) => {
    const snapshot = await getVaultSnapshot();
    const clientFilter = typeof req.query.client === "string"
      ? req.query.client.toLowerCase()
      : null;
    const statusFilter = typeof req.query.status === "string"
      ? req.query.status.toLowerCase()
      : null;
    const listings = Object.values(snapshot.documents)
      .filter((entry) => entry.type === "listing")
      .map((entry) => summarizeAnpListing(snapshot, entry))
      .filter((entry) => !clientFilter || entry.signer.toLowerCase() === clientFilter)
      .filter((entry) => !statusFilter || entry.status === statusFilter)
      .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0));
    const paginated = paginate(listings, req.query.page, req.query.limit);

    res.json({
      listings: paginated.items,
      pagination: paginated.pagination
    });
  })
);

router.get(
  "/anp/listings/:cid",
  asyncHandler(async (req, res) => {
    const snapshot = await getVaultSnapshot();
    const entry = snapshot.documents[req.params.cid];

    if (!entry || entry.type !== "listing") {
      throw createHttpError(404, `Unknown listing CID: ${req.params.cid}`);
    }

    const bids = getBidsForListing(snapshot, entry).map(summarizeAnpBid);
    const summary = summarizeAnpListing(snapshot, entry);

    res.json({
      cid: entry.cid,
      signer: entry.document.signer,
      status: summary.status,
      bidCount: summary.bidCount,
      uniqueAgentCount: summary.uniqueAgentCount,
      market: {
        bidCount: summary.bidCount,
        uniqueAgentCount: summary.uniqueAgentCount,
        signers: [...new Set(bids.map((bid) => bid.signer.toLowerCase()))]
      },
      document: entry.document,
      bids
    });
  })
);

router.get(
  "/anp/listings/:cid/bids",
  asyncHandler(async (req, res) => {
    const snapshot = await getVaultSnapshot();
    const entry = snapshot.documents[req.params.cid];

    if (!entry || entry.type !== "listing") {
      throw createHttpError(404, `Unknown listing CID: ${req.params.cid}`);
    }

    const bids = getBidsForListing(snapshot, entry).map(summarizeAnpBid);
    const paginated = paginate(bids, req.query.page, req.query.limit);

    res.json({
      listingCid: entry.cid,
      bids: paginated.items,
      pagination: paginated.pagination
    });
  })
);

router.get(
  "/anp/objects/:cid",
  asyncHandler(async (req, res) => {
    const snapshot = await getVaultSnapshot();
    const entry = snapshot.documents[req.params.cid];

    if (!entry) {
      throw createHttpError(404, `Unknown ANP object CID: ${req.params.cid}`);
    }

    res.set("X-Content-CID", entry.cid);
    res.json(entry.document);
  })
);

router.get(
  "/anp/verify/:cid",
  asyncHandler(async (req, res) => {
    const snapshot = await getVaultSnapshot();
    const entry = snapshot.documents[req.params.cid];

    if (!entry) {
      throw createHttpError(404, `Unknown ANP object CID: ${req.params.cid}`);
    }

    const anp = getAnpManager();
    const verification = anp.verifyDocument(entry.document);

    res.json({
      cid: entry.cid,
      valid: verification.valid,
      recomputedCid: anp.computeCID(entry.document),
      protocol: entry.document.protocol,
      version: entry.document.version || null,
      type: entry.document.type,
      signer: verification.recoveredSigner || entry.document.signer
    });
  })
);

router.post(
  "/anp/settle",
  asyncHandler(async (req, res) => {
    const { listing_cid, bid_cid, acceptance_cid } = req.body || {};

    if (!listing_cid || !bid_cid || !acceptance_cid) {
      throw createHttpError(
        400,
        "listing_cid, bid_cid, and acceptance_cid are required."
      );
    }

    const snapshot = await getVaultSnapshot();
    const listingEntry = snapshot.documents[listing_cid];
    const bidEntry = snapshot.documents[bid_cid];
    const acceptanceEntry = snapshot.documents[acceptance_cid];

    if (!listingEntry || listingEntry.type !== "listing") {
      throw createHttpError(404, `Unknown listing CID: ${listing_cid}`);
    }
    if (!bidEntry || bidEntry.type !== "bid") {
      throw createHttpError(404, `Unknown bid CID: ${bid_cid}`);
    }
    if (!acceptanceEntry || acceptanceEntry.type !== "acceptance") {
      throw createHttpError(404, `Unknown acceptance CID: ${acceptance_cid}`);
    }

    const anp = getAnpManager();
    const listing = anp.prepareTypedData(
      "ListingIntent",
      listingEntry.document.data,
      { variant: getDocumentEnvelopeVariant(listingEntry.document) }
    ).message;
    const bid = anp.prepareTypedData(
      "BidIntent",
      bidEntry.document.data,
      { variant: getDocumentEnvelopeVariant(bidEntry.document) }
    ).message;
    const acceptance = anp.prepareTypedData(
      "AcceptIntent",
      acceptanceEntry.document.data,
      { variant: getDocumentEnvelopeVariant(acceptanceEntry.document) }
    ).message;

    res.json({
      listing,
      listingSig: listingEntry.document.signature,
      bid,
      bidSig: bidEntry.document.signature,
      acceptance,
      acceptSig: acceptanceEntry.document.signature
    });
  })
);

router.post(
  "/anp/link",
  asyncHandler(async (req, res) => {
    const { listing_cid, settlement_id, acp_job_id } = req.body || {};

    if (!listing_cid) {
      throw createHttpError(400, "listing_cid is required.");
    }

    const snapshot = await getVaultSnapshot();
    const entry = snapshot.documents[listing_cid];
    if (!entry || entry.type !== "listing") {
      throw createHttpError(404, `Unknown listing CID: ${listing_cid}`);
    }

    await getAnpManager().vault.recordSettlement(listing_cid, {
      source: "api-anp-link",
      settlementId: settlement_id || null,
      acpJobId: acp_job_id || null,
      linkedAt: new Date().toISOString()
    });

    res.json({ ok: true });
  })
);

// ─── Sovereign write endpoints under /api/anp/ ────────────────────────────

/**
 * POST /api/anp/listings
 * Create and sign a new listing with this node's wallet.
 * Body: { title, description, min_budget, max_budget, deadline_hours, job_duration_hours }
 */
router.post(
  "/anp/listings",
  asyncHandler(async (req, res) => {
    const {
      title,
      description,
      min_budget, minBudget,
      max_budget, maxBudget,
      deadline_hours, deadlineHours,
      job_duration_hours, jobDurationHours,
      preferred_evaluator, preferredEvaluator
    } = req.body || {};

    if (!title || !String(title).trim()) throw createHttpError(400, "title is required.");
    if (!description || !String(description).trim()) throw createHttpError(400, "description is required.");

    const anp = getAnpManager();
    const document = await anp.createListing({
      title: String(title).trim(),
      description: String(description).trim(),
      minBudget: normalizeBudgetInput(min_budget ?? minBudget, undefined, "minBudget"),
      maxBudget: normalizeBudgetInput(max_budget ?? maxBudget, undefined, "maxBudget"),
      deadline: normalizeFutureTimestampSeconds(undefined, deadline_hours ?? deadlineHours, "deadline"),
      jobDuration: normalizeDurationSeconds(undefined, job_duration_hours ?? jobDurationHours ?? 24),
      preferredEvaluator:
        (preferred_evaluator || preferredEvaluator || "").trim() ||
        "0x0000000000000000000000000000000000000000"
    });
    const cid = anp.computeCID(document);

    res.status(201).json({ ok: true, cid, document });
  })
);

/**
 * POST /api/anp/bids
 * Create and sign a bid on a listing using this node's wallet.
 * The listingHash is auto-resolved from the vault — caller only needs listing_cid.
 * Body: { listing_cid, price, delivery_hours, message }
 */
router.post(
  "/anp/bids",
  asyncHandler(async (req, res) => {
    const {
      listing_cid, listingCid,
      price, priceUsdc,
      delivery_hours, deliveryHours, deliverySeconds,
      message
    } = req.body || {};

    const resolvedListingCid = listing_cid || listingCid;
    const resolvedPrice = price ?? priceUsdc;
    const resolvedDeliverySeconds = deliverySeconds ??
      ((delivery_hours ?? deliveryHours) ? (delivery_hours ?? deliveryHours) * 3600 : null);

    if (!resolvedListingCid) throw createHttpError(400, "listing_cid is required.");
    if (resolvedPrice == null) throw createHttpError(400, "price is required.");
    if (!resolvedDeliverySeconds) throw createHttpError(400, "delivery_hours is required.");
    if (!message) throw createHttpError(400, "message is required.");

    const anp = getAnpManager();
    const vault = anp.vault;

    // Auto-resolve listingHash from vault (or from peers if not local)
    const listingEntry = await vault.getDocument(resolvedListingCid);
    if (!listingEntry || listingEntry.type !== "listing") {
      throw createHttpError(404, `Listing not found: ${resolvedListingCid}. Publish it first via POST /api/anp/publish.`);
    }
    const listingHash = listingEntry.typedHash;

    const document = await anp.createBid(
      resolvedListingCid,
      listingHash,
      resolvedPrice,
      resolvedDeliverySeconds,
      message
    );
    const cid = anp.computeCID(document);

    res.status(201).json({ ok: true, cid, document });
  })
);

// ─── Peer-to-peer discovery ────────────────────────────────────────────────

/**
 * GET /api/anp/peers
 * List all known peer nodes.
 */
router.get(
  "/anp/peers",
  asyncHandler(async (req, res) => {
    const peers = await getAnpManager().vault.listPeers();
    res.json({ ok: true, count: peers.length, peers });
  })
);

/**
 * POST /api/anp/peers
 * Register a new peer node for discovery sync.
 * Body: { url: "https://other-node.vercel.app" }
 */
router.post(
  "/anp/peers",
  asyncHandler(async (req, res) => {
    const { url } = req.body || {};
    if (!url || !String(url).startsWith("http")) {
      throw createHttpError(400, "url is required and must start with http.");
    }
    const peer = await getAnpManager().vault.addPeer(String(url).trim());
    res.status(201).json({ ok: true, peer });
  })
);

/**
 * DELETE /api/anp/peers/:url
 * Remove a peer (URL must be base64url-encoded or passed as query param).
 * Simpler: POST /api/anp/peers/remove with { url }
 */
router.post(
  "/anp/peers/remove",
  asyncHandler(async (req, res) => {
    const { url } = req.body || {};
    if (!url) throw createHttpError(400, "url is required.");
    await getAnpManager().vault.removePeer(String(url).trim());
    res.json({ ok: true });
  })
);

/**
 * POST /api/anp/peers/sync
 * Manually trigger a sync pull from all known peers.
 */
router.post(
  "/anp/peers/sync",
  asyncHandler(async (req, res) => {
    const peers = await getAnpManager().vault.listPeers();
    if (peers.length === 0) {
      return res.json({ ok: true, message: "No peers registered.", results: [] });
    }
    const results = await Promise.all(peers.map((p) => syncFromPeer(p.url)));
    const total = results.reduce((sum, r) => sum + r.count, 0);
    res.json({ ok: true, synced: total, results });
  })
);

// ─── Phase 2: Multi-agent platform endpoints ──────────────────────────────

/**
 * POST /api/anp/accept
 * Client agent signs + stores an AcceptIntent for a listing/bid pair.
 * Body: { listingCid, bidCid }
 */
router.post(
  "/anp/accept",
  asyncHandler(async (req, res) => {
    const { listingCid, listing_cid, bidCid, bid_cid } = req.body || {};
    const resolvedListingCid = listingCid || listing_cid;
    const resolvedBidCid = bidCid || bid_cid;

    if (!resolvedListingCid) throw createHttpError(400, "listingCid is required.");
    if (!resolvedBidCid) throw createHttpError(400, "bidCid is required.");

    const anp = getAnpManager();
    const vault = anp.vault;

    const listingEntry = await vault.getDocument(resolvedListingCid);
    if (!listingEntry || listingEntry.type !== "listing") {
      throw createHttpError(404, `Unknown listing CID: ${resolvedListingCid}`);
    }

    const bidEntry = await vault.getDocument(resolvedBidCid);
    if (!bidEntry || bidEntry.type !== "bid") {
      throw createHttpError(404, `Unknown bid CID: ${resolvedBidCid}`);
    }

    // Derive listing/bid hashes from the stored typed hashes
    const listingHash = listingEntry.typedHash || null;
    const bidHash = bidEntry.typedHash || null;

    const document = await anp.createAcceptance({ listingCid: resolvedListingCid, bidCid: resolvedBidCid, listingHash, bidHash });
    const cid = anp.computeCID(document);

    res.status(201).json({ ok: true, cid, document });
  })
);

/**
 * GET /api/acp/jobs
 * List all tracked ACP jobs from the vault.
 * Query: ?enrich=1 to include on-chain status
 */
router.get(
  "/acp/jobs",
  asyncHandler(async (req, res) => {
    const vault = getAnpManager().vault;
    const jobs = await vault.listACPJobs();

    if (req.query.enrich === "1") {
      const acp = getAcpManager();
      const enriched = await Promise.all(
        jobs.map(async (job) => {
          if (!acp.rpcUrl || !job.jobId) return { ...job, onChain: null };
          try {
            const onChain = await acp.getJob(job.jobId);
            return { ...job, onChain };
          } catch {
            return { ...job, onChain: null };
          }
        })
      );
      return res.json({ ok: true, count: enriched.length, jobs: enriched });
    }

    res.json({ ok: true, count: jobs.length, jobs });
  })
);

/**
 * GET /api/acp/jobs/:id
 * On-chain + local state for a single tracked ACP job.
 */
router.get(
  "/acp/jobs/:id",
  asyncHandler(async (req, res) => {
    const jobId = req.params.id;
    const vault = getAnpManager().vault;
    const local = await vault.getACPJob(jobId);

    let onChain = null;
    const acp = getAcpManager();
    if (acp.rpcUrl) {
      try {
        onChain = await acp.getJob(jobId);
      } catch {
        onChain = null;
      }
    }

    if (!local && !onChain) {
      throw createHttpError(404, `ACP job ${jobId} not found.`);
    }

    res.json({ ok: true, jobId, onChain, local });
  })
);

/**
 * POST /api/acp/jobs/:id/record
 * Agent records a Base transaction it executed for this job.
 * Body: { action, txHash, acceptCid?, data? }
 */
router.post(
  "/acp/jobs/:id/record",
  asyncHandler(async (req, res) => {
    const jobId = req.params.id;
    const { action, txHash, acceptCid, data } = req.body || {};

    if (!action) throw createHttpError(400, "action is required.");
    if (!txHash) throw createHttpError(400, "txHash is required.");

    const vault = getAnpManager().vault;
    const recorded = await vault.recordACPJob(jobId, {
      action,
      txHash,
      ...(acceptCid ? { acceptCid } : {}),
      ...(data && typeof data === "object" ? data : {})
    });

    res.json({ ok: true, jobId, action, recorded });
  })
);

// ─── ACP on-chain settlement endpoints ──────────────────────────────────────

/**
 * POST /api/acp/jobs/create
 * Create an on-chain ACP job from an accepted ANP negotiation.
 * Body: { acceptCid, evaluator?, expiredAt?, description?, hook? }
 */
router.post(
  "/acp/jobs/create",
  asyncHandler(async (req, res) => {
    const { acceptCid, evaluator, expiredAt, description, hook } = req.body || {};

    if (!acceptCid) throw createHttpError(400, "acceptCid is required.");

    const acp = getAcpManager();
    const prepared = await acp.prepareJobParamsFromAcceptIntent(acceptCid);
    const params = {
      ...prepared,
      ...(evaluator ? { evaluator } : {}),
      ...(expiredAt ? { expiredAt } : {}),
      ...(description ? { description } : {}),
      ...(hook ? { hook } : {})
    };

    const result = await acp.createJob(params);

    await getAnpManager().vault.recordSettlement(prepared.acceptCid || acceptCid, {
      acpJobId: result.jobId,
      txHash: result.txHash,
      action: "createJob"
    });

    res.json({ ok: true, ...result });
  })
);

/**
 * POST /api/acp/jobs/fund
 * Fund an on-chain ACP job. Handles USDC approval automatically.
 * Body: { jobId, amount? }
 * If amount is omitted, uses the job's on-chain budget.
 */
router.post(
  "/acp/jobs/fund",
  asyncHandler(async (req, res) => {
    const { jobId, amount } = req.body || {};

    if (!jobId) throw createHttpError(400, "jobId is required.");

    const acp = getAcpManager();
    const job = await acp.getJob(jobId);

    if (!job) throw createHttpError(404, `Job ${jobId} not found on-chain.`);

    const fundAmount = amount || job.budget;

    let fundMicro;
    try {
      fundMicro = BigInt(fundAmount);
    } catch {
      throw createHttpError(400, `Invalid amount: ${fundAmount}`);
    }
    if (fundMicro === 0n) {
      throw createHttpError(400, "Job has no budget set. Use setBudget first or provide amount.");
    }

    const result = await acp.fundJob(jobId, fundAmount);

    res.json({ ok: true, ...result });
  })
);

/**
 * POST /api/acp/jobs/submit
 * Provider submits work deliverable for an on-chain ACP job.
 * Body: { jobId, deliverable }
 * deliverable: a string or bytes32 hash referencing the work output.
 */
router.post(
  "/acp/jobs/submit",
  asyncHandler(async (req, res) => {
    const { jobId, deliverable } = req.body || {};

    if (!jobId) throw createHttpError(400, "jobId is required.");
    if (!deliverable) throw createHttpError(400, "deliverable is required.");

    const acp = getAcpManager();
    const result = await acp.submitWork(jobId, deliverable);

    res.json({ ok: true, ...result });
  })
);

/**
 * POST /api/acp/jobs/evaluate
 * Evaluator approves or rejects submitted work.
 * Body: { jobId, decision: "approve"|"reject", reason? }
 * approve → releases USDC to provider. reject → refunds USDC to client.
 */
router.post(
  "/acp/jobs/evaluate",
  asyncHandler(async (req, res) => {
    const { jobId, decision, reason } = req.body || {};

    if (!jobId) throw createHttpError(400, "jobId is required.");
    if (!decision || !["approve", "reject"].includes(decision)) {
      throw createHttpError(400, "decision must be 'approve' or 'reject'.");
    }

    const acp = getAcpManager();
    const result = decision === "approve"
      ? await acp.completeJob(jobId, reason || "approved")
      : await acp.rejectJob(jobId, reason || "rejected");

    res.json({ ok: true, decision, ...result });
  })
);

router.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: `Unknown API route: ${req.method} ${req.originalUrl}`
  });
});

module.exports = {
  router
};
