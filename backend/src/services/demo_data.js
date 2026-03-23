const { Wallet, ZeroAddress } = require("ethers");

const { ANPManager } = require("../engines/anp_engine");

const DEMO_SEED_ID = "demo-seed-v2";
const DEMO_BASE_UNIX = Math.floor(Date.UTC(2027, 0, 15, 12, 0, 0) / 1000);
const LEGACY_DEMO_SEED_IDS = new Set(["demo-seed-v1", DEMO_SEED_ID]);
const DEMO_CLIENT_ALPHA = new Wallet(
  "0x1000000000000000000000000000000000000000000000000000000000000001"
);
const DEMO_CLIENT_BETA = new Wallet(
  "0x2000000000000000000000000000000000000000000000000000000000000002"
);
const DEMO_EVALUATOR = new Wallet(
  "0x3000000000000000000000000000000000000000000000000000000000000003"
);

function toUnixOffset(days) {
  return String(DEMO_BASE_UNIX + days * 24 * 60 * 60);
}

function buildDemoListingCatalog() {
  return [
    {
      id: "demo-listing-api-verification",
      scenario: "completed",
      clientWallet: DEMO_CLIENT_ALPHA,
      title: "API verification sprint",
      description:
        "Need automated verification flows, API assertions, and regression coverage for a multi-agent workflow.",
      minBudget: "5000000",
      maxBudget: "14000000",
      deadline: toUnixOffset(3),
      jobDuration: "86400",
      bidCount: 2,
      preferredEvaluator: DEMO_EVALUATOR.address,
      listingNonce: "41001",
      proposedBidUsdc: "11.2",
      confidence: {
        score: 0.92,
        label: "trusted"
      },
      strategy: {
        mode: "profit-maximizing",
        ratioPercent: 90
      },
      jobId: "demo-job-api-1",
      jobStatus: 3,
      jobStatusLabel: "Completed",
      attestationKey: "demo-attestation-api-1"
    },
    {
      id: "demo-listing-orchestration",
      scenario: "negotiating",
      clientWallet: DEMO_CLIENT_BETA,
      title: "Agent orchestration data pipeline",
      description:
        "Looking for a builder to connect data ingestion, orchestration, and test evidence across multiple agents.",
      minBudget: "9000000",
      maxBudget: "25000000",
      deadline: toUnixOffset(5),
      jobDuration: "172800",
      bidCount: 4,
      preferredEvaluator: DEMO_EVALUATOR.address,
      listingNonce: "41002",
      proposedBidUsdc: "17.5",
      confidence: {
        score: 0.74,
        label: "solid"
      },
      strategy: {
        mode: "competitive",
        ratioPercent: 70
      }
    },
    {
      id: "demo-listing-high-value",
      scenario: "paused",
      clientWallet: DEMO_CLIENT_ALPHA,
      title: "High-value verification and trust layer",
      description:
        "Large engagement for API security, verification, and trust attestations between agents.",
      minBudget: "35000000",
      maxBudget: "150000000",
      deadline: toUnixOffset(7),
      jobDuration: "259200",
      bidCount: 6,
      preferredEvaluator: DEMO_EVALUATOR.address,
      listingNonce: "41003",
      proposedBidUsdc: "105",
      confidence: {
        score: 0.5,
        label: "manual-review"
      }
    },
    {
      id: "demo-listing-escrow-automation",
      scenario: "funded",
      clientWallet: DEMO_CLIENT_BETA,
      title: "Escrow-backed release automation",
      description:
        "Need a provider to wire escrow release logic, evaluator hooks, and human-readable settlement evidence.",
      minBudget: "12000000",
      maxBudget: "40000000",
      deadline: toUnixOffset(6),
      jobDuration: "172800",
      bidCount: 1,
      preferredEvaluator: DEMO_EVALUATOR.address,
      listingNonce: "41004",
      proposedBidUsdc: "28",
      confidence: {
        score: 0.86,
        label: "high"
      },
      strategy: {
        mode: "profit-maximizing",
        ratioPercent: 90
      },
      jobId: "demo-job-escrow-1",
      jobStatus: 1,
      jobStatusLabel: "Funded"
    },
    {
      id: "demo-listing-test-harness",
      scenario: "discovery",
      clientWallet: DEMO_CLIENT_ALPHA,
      title: "Multi-agent test harness",
      description:
        "Seeking a lightweight build of data fixtures, verification checkpoints, and evaluation prompts for agent collaboration.",
      minBudget: "6000000",
      maxBudget: "12000000",
      deadline: toUnixOffset(4),
      jobDuration: "86400",
      bidCount: 0,
      preferredEvaluator: DEMO_EVALUATOR.address,
      listingNonce: "41005"
    }
  ];
}

function buildListingContent(definition) {
  return {
    title: definition.title,
    description: definition.description
  };
}

async function signDocumentWithWallet(anpManager, wallet, primaryType, data) {
  const typedData = anpManager.prepareTypedData(primaryType, data);
  const signature = await wallet.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message
  );

  return {
    protocol: "ANP",
    version: "1",
    type: primaryType === "ListingIntent"
      ? "listing"
      : primaryType === "BidIntent"
        ? "bid"
        : "acceptance",
    data: {
      ...data,
      ...typedData.message
    },
    signer: wallet.address,
    signature,
    timestamp: Math.floor(Date.now() / 1000)
  };
}

async function createListingBundle(anpManager, definition) {
  const content = buildListingContent(definition);
  const contentHash = ANPManager.computeContentHashHex(content);
  const intent = {
    title: definition.title,
    description: definition.description,
    contentHash,
    minBudget: definition.minBudget,
    maxBudget: definition.maxBudget,
    deadline: definition.deadline,
    jobDuration: definition.jobDuration,
    preferredEvaluator: definition.preferredEvaluator,
    nonce: definition.listingNonce
  };
  const document = await signDocumentWithWallet(
    anpManager,
    definition.clientWallet,
    "ListingIntent",
    intent
  );
  const listingHash = anpManager.hashTypedData("ListingIntent", document.data);
  const cid = anpManager.computeCID(document);

  return {
    id: definition.id,
    scenario: definition.scenario,
    definition,
    cid,
    content,
    contentHash,
    document,
    listingHash,
    publicListing: {
      cid,
      id: definition.id,
      listingCid: cid,
      discoveryId: definition.id,
      documentCid: cid,
      title: definition.title,
      description: definition.description,
      status: "open",
      minBudget: definition.minBudget,
      maxBudget: definition.maxBudget,
      deadline: definition.deadline,
      jobDuration: definition.jobDuration,
      preferredEvaluator: definition.preferredEvaluator,
      clientAddress: definition.clientWallet.address,
      bidCount: definition.bidCount,
      listingHash,
      data: document.data
    }
  };
}

async function buildDemoListings(anpManager) {
  const definitions = buildDemoListingCatalog();
  const bundles = [];

  for (const definition of definitions) {
    bundles.push(await createListingBundle(anpManager, definition));
  }

  return bundles;
}

function isDemoMetadata(metadata = {}) {
  return (
    LEGACY_DEMO_SEED_IDS.has(metadata.demoSeedId) ||
    metadata.source === "demo-seed" ||
    metadata.adapter === "Demo"
  );
}

function getObservationListingId(observation = {}) {
  const snapshot = observation.snapshot || {};
  return snapshot.id || snapshot.discoveryId || observation.listingId || null;
}

function findObservationForDefinition(state, definition) {
  return Object.values((state.observations && state.observations.listings) || {})
    .find((entry) => {
      const snapshot = entry.snapshot || {};
      const metadata = entry.metadata || {};
      return (
        getObservationListingId(entry) === definition.id ||
        metadata.demoScenario === definition.id ||
        entry.title === definition.title
      );
    }) || null;
}

function findDocumentByScenario(state, type, scenarioId) {
  return Object.values(state.documents || {})
    .find((entry) =>
      entry.type === type &&
      entry.metadata &&
      entry.metadata.demoScenario === scenarioId
    ) || null;
}

function findListingEntry(state, definition, observation) {
  if (observation) {
    const snapshot = observation.snapshot || {};
    if (snapshot.documentCid && state.documents[snapshot.documentCid]) {
      return state.documents[snapshot.documentCid];
    }

    if (snapshot.cid && state.documents[snapshot.cid]) {
      return state.documents[snapshot.cid];
    }

    if (snapshot.listingHash) {
      const typedHashCid = state.indexes &&
        state.indexes.byTypedHash &&
        state.indexes.byTypedHash[snapshot.listingHash];
      if (typedHashCid && state.documents[typedHashCid]) {
        return state.documents[typedHashCid];
      }
    }
  }

  return (
    findDocumentByScenario(state, "listing", definition.id) ||
    Object.values(state.documents || {}).find((entry) =>
      entry.type === "listing" &&
      entry.document &&
      entry.document.signer === definition.clientWallet.address &&
      entry.document.data &&
      entry.document.data.title === definition.title
    ) ||
    null
  );
}

function toPublicListing(definition, listingEntry, observation) {
  const document = listingEntry && listingEntry.document ? listingEntry.document : null;
  const documentData = document && document.data ? document.data : {};
  const snapshot = observation && observation.snapshot ? observation.snapshot : {};
  const listingHash = listingEntry ? listingEntry.typedHash : snapshot.listingHash || null;
  const documentCid = listingEntry ? listingEntry.cid : snapshot.documentCid || snapshot.cid || null;
  const listingCid = snapshot.listingCid || documentCid || definition.id;

  return {
    cid: documentCid || listingCid,
    id: definition.id,
    listingCid,
    discoveryId: definition.id,
    documentCid,
    title: snapshot.title || documentData.title || definition.title,
    description: snapshot.description || documentData.description || definition.description,
    status: snapshot.status || "open",
    minBudget: snapshot.minBudget || documentData.minBudget || definition.minBudget,
    maxBudget: snapshot.maxBudget || documentData.maxBudget || definition.maxBudget,
    deadline: snapshot.deadline || documentData.deadline || definition.deadline,
    jobDuration: snapshot.jobDuration || documentData.jobDuration || definition.jobDuration,
    preferredEvaluator:
      snapshot.preferredEvaluator ||
      documentData.preferredEvaluator ||
      definition.preferredEvaluator,
    clientAddress:
      snapshot.clientAddress ||
      (document ? document.signer : null) ||
      definition.clientWallet.address,
    bidCount:
      snapshot.bidCount === 0 || snapshot.bidCount
        ? snapshot.bidCount
        : definition.bidCount,
    listingHash,
    data: documentData
  };
}

async function ensureListingScenario(anpManager, definition) {
  const state = await anpManager.vault.load();
  const existingObservation = findObservationForDefinition(state, definition);
  let listingEntry = findListingEntry(state, definition, existingObservation);
  let changed = false;

  if (!listingEntry) {
    const created = await createListingBundle(anpManager, definition);
    listingEntry = await anpManager.vault.storeSignedDocument(created.document, {
      source: "demo-seed",
      demoSeedId: DEMO_SEED_ID,
      demoScenario: definition.id,
      demoRole: "listing"
    });
    changed = true;
  } else if (
    !listingEntry.metadata ||
    listingEntry.metadata.demoScenario !== definition.id ||
    listingEntry.metadata.demoRole !== "listing" ||
    listingEntry.metadata.demoSeedId !== DEMO_SEED_ID
  ) {
    listingEntry = await anpManager.vault.storeSignedDocument(listingEntry.document, {
      ...(listingEntry.metadata || {}),
      source: "demo-seed",
      demoSeedId: DEMO_SEED_ID,
      demoScenario: definition.id,
      demoRole: "listing"
    });
    changed = true;
  }

  const publicListing = toPublicListing(definition, listingEntry, existingObservation);
  if (!existingObservation) {
    await anpManager.vault.recordListingObservation(publicListing, {
      adapter: "Demo",
      endpoint: "local://demo",
      demoSeedId: DEMO_SEED_ID,
      demoScenario: definition.id
    });
    changed = true;
  }

  return {
    changed,
    definition,
    listingEntry,
    publicListing,
    listingCid: publicListing.listingCid,
    listingHash: publicListing.listingHash || (listingEntry ? listingEntry.typedHash : null),
    documentCid: listingEntry ? listingEntry.cid : publicListing.documentCid || publicListing.cid
  };
}

function buildDemoBidMessage(definition, listingRef) {
  return {
    listingCid: listingRef.listingCid,
    title: definition.title,
    proposedPriceUsdc: definition.proposedBidUsdc,
    summary: `Demo ${definition.scenario} scenario for sovereign ANP negotiation.`,
    confidence: definition.confidence,
    source: "demo-seed"
  };
}

async function ensureMockPublication(anpManager, documentCid) {
  const entry = await anpManager.vault.getDocument(documentCid);
  if (entry && Array.isArray(entry.publications) && entry.publications.length > 0) {
    return false;
  }

  await anpManager.vault.recordPublication(documentCid, {
    adapter: "Demo",
    endpoint: "local://demo",
    status: 200,
    response: {
      ok: true,
      mode: "mock"
    }
  });
  return true;
}

async function ensureBidScenario(anpManager, definition, listingRef) {
  let bidEntry = findDocumentByScenario(await anpManager.vault.load(), "bid", definition.id);
  let changed = false;

  if (!bidEntry) {
    const bidDocument = await anpManager.createBid(
      listingRef.listingCid,
      listingRef.listingHash,
      definition.proposedBidUsdc,
      listingRef.publicListing.jobDuration,
      buildDemoBidMessage(definition, listingRef),
      {
        metadata: {
          demoSeedId: DEMO_SEED_ID,
          demoScenario: definition.id,
          demoRole: "bid",
          clientId: definition.clientWallet.address,
          confidence: definition.confidence || null,
          strategy: definition.strategy || null
        }
      }
    );
    const bidCid = anpManager.computeCID(bidDocument);
    bidEntry = await anpManager.vault.getDocument(bidCid);
    changed = true;
  } else if (
    !bidEntry.metadata ||
    bidEntry.metadata.demoScenario !== definition.id ||
    bidEntry.metadata.demoRole !== "bid" ||
    bidEntry.metadata.demoSeedId !== DEMO_SEED_ID
  ) {
    bidEntry = await anpManager.vault.storeSignedDocument(bidEntry.document, {
      ...(bidEntry.metadata || {}),
      source: "demo-seed",
      demoSeedId: DEMO_SEED_ID,
      demoScenario: definition.id,
      demoRole: "bid",
      listingCid: listingRef.listingCid,
      clientId: definition.clientWallet.address,
      confidence: definition.confidence || null,
      strategy: definition.strategy || null
    });
    changed = true;
  }

  if (await ensureMockPublication(anpManager, bidEntry.cid)) {
    changed = true;
  }

  return {
    changed,
    bidEntry,
    bidCid: bidEntry.cid,
    bidHash: bidEntry.typedHash
  };
}

async function ensureAcceptanceScenario(
  anpManager,
  definition,
  listingRef,
  bidRef,
  automationPatch = {}
) {
  let acceptanceEntry = findDocumentByScenario(
    await anpManager.vault.load(),
    "acceptance",
    definition.id
  );
  let changed = false;

  if (!acceptanceEntry) {
    const acceptanceDocument = await signDocumentWithWallet(
      anpManager,
      definition.clientWallet,
      "AcceptIntent",
      {
        listingCid: listingRef.listingCid,
        bidCid: bidRef.bidCid,
        listingHash: listingRef.listingHash,
        bidHash: bidRef.bidHash,
        nonce: `${definition.listingNonce}99`
      }
    );
    acceptanceEntry = await anpManager.vault.storeSignedDocument(acceptanceDocument, {
      source: "demo-seed",
      demoSeedId: DEMO_SEED_ID,
      demoScenario: definition.id,
      demoRole: "acceptance",
      automation: automationPatch
    });
    changed = true;
  } else {
    const nextMetadata = {
      ...(acceptanceEntry.metadata || {}),
      source: "demo-seed",
      demoSeedId: DEMO_SEED_ID,
      demoScenario: definition.id,
      demoRole: "acceptance",
      automation: {
        ...((acceptanceEntry.metadata && acceptanceEntry.metadata.automation) || {}),
        ...automationPatch
      }
    };
    const needsUpdate =
      !acceptanceEntry.metadata ||
      acceptanceEntry.metadata.demoScenario !== definition.id ||
      acceptanceEntry.metadata.demoRole !== "acceptance" ||
      acceptanceEntry.metadata.demoSeedId !== DEMO_SEED_ID ||
      Object.entries(automationPatch).some(([key, value]) => {
        return (
          !acceptanceEntry.metadata ||
          !acceptanceEntry.metadata.automation ||
          acceptanceEntry.metadata.automation[key] !== value
        );
      });

    if (needsUpdate) {
      acceptanceEntry = await anpManager.vault.storeSignedDocument(
        acceptanceEntry.document,
        nextMetadata
      );
      changed = true;
    }
  }

  return {
    changed,
    acceptanceEntry,
    acceptCid: acceptanceEntry.cid
  };
}

async function ensureAcpJobScenario(anpManager, definition, listingRef, bidRef, acceptRef) {
  const operatorAddress = await anpManager.getAddress();
  const state = await anpManager.vault.load();
  const existing = state.acp && state.acp.jobs ? state.acp.jobs[definition.jobId] : null;
  const expectedBudget =
    bidRef.bidEntry &&
    bidRef.bidEntry.document &&
    bidRef.bidEntry.document.data &&
    bidRef.bidEntry.document.data.price
      ? bidRef.bidEntry.document.data.price
      : null;
  const nextRecord = {
    source: "demo-seed",
    demoSeedId: DEMO_SEED_ID,
    demoScenario: definition.id,
    acceptCid: acceptRef.acceptCid,
    bidCid: bidRef.bidCid,
    listingCid: listingRef.listingCid,
    client: definition.clientWallet.address,
    provider: operatorAddress,
    evaluator: definition.preferredEvaluator,
    job: {
      client: definition.clientWallet.address,
      provider: operatorAddress,
      evaluator: definition.preferredEvaluator,
      description: `Demo ACP job for ${definition.title}`,
      budget: expectedBudget,
      expiredAt: listingRef.publicListing.deadline,
      status: definition.jobStatus,
      statusLabel: definition.jobStatusLabel,
      hook: ZeroAddress,
      deliverable:
        definition.scenario === "completed"
          ? "0x" + "11".repeat(32)
          : "0x" + "22".repeat(32)
    },
    statusLabel: definition.jobStatusLabel,
    action: "demo-seed"
  };
  const needsUpdate =
    !existing ||
    existing.acceptCid !== acceptRef.acceptCid ||
    existing.statusLabel !== definition.jobStatusLabel;

  if (!needsUpdate) {
    return {
      changed: false,
      job: existing
    };
  }

  const job = await anpManager.vault.recordACPJob(definition.jobId, nextRecord);
  return {
    changed: true,
    job
  };
}

async function ensureReputationAttestation(anpManager, definition, acceptRef) {
  if (!definition.attestationKey) {
    return {
      changed: false,
      record: null
    };
  }

  const existing = await anpManager.vault.getReputationAttestationByKey(
    definition.attestationKey
  );
  const nextRecord = {
    attestationKey: definition.attestationKey,
    protocol: "erc-8004/v1",
    kind: "reputation-attestation",
    jobId: definition.jobId,
    acceptCid: acceptRef.acceptCid,
    target: {
      agentId: "demo-agent-1",
      agentRegistry: "demo://registry"
    },
    payload: {
      score: 96,
      summary: `Demo attestation for ${definition.title}.`
    },
    onchain: {
      published: false,
      status: "demo-local"
    }
  };

  if (existing) {
    const matches =
      existing.acceptCid === nextRecord.acceptCid &&
      existing.jobId === nextRecord.jobId &&
      existing.onchain &&
      existing.onchain.status === "demo-local";
    if (matches) {
      return {
        changed: false,
        record: existing
      };
    }
  }

  return {
    changed: true,
    record: await anpManager.vault.recordReputationAttestation(nextRecord)
  };
}

async function ensureHumanPause(anpManager, definition, listingRef) {
  const existing = await anpManager.vault.getMostRecentHumanPauseForListing(
    listingRef.listingCid
  );
  if (existing && !existing.decision && !existing.decidedAt) {
    return {
      changed: false,
      pause: existing
    };
  }

  return {
    changed: true,
    pause: await anpManager.vault.recordHumanPause({
      demoSeedId: DEMO_SEED_ID,
      demoScenario: definition.id,
      listingCid: listingRef.listingCid,
      title: definition.title,
      clientId: definition.clientWallet.address,
      proposedBidUsdc: definition.proposedBidUsdc,
      confidence: definition.confidence ? definition.confidence.score : null,
      approved: false,
      interactive: false,
      reason: "Demo high-value listing waiting for manual approval."
    })
  };
}

async function reconcileLegacyCompletedAcceptance(anpManager, definition, listingRef) {
  const state = await anpManager.vault.load();
  const acceptanceEntry = Object.values(state.documents || {}).find((entry) =>
    entry.type === "acceptance" &&
    entry.metadata &&
    isDemoMetadata(entry.metadata) &&
    entry.document &&
    entry.document.data &&
    entry.document.data.listingHash === listingRef.listingHash
  );

  if (!acceptanceEntry) {
    return false;
  }

  const automation = acceptanceEntry.metadata && acceptanceEntry.metadata.automation
    ? acceptanceEntry.metadata.automation
    : {};
  const desiredAutomation = {
    ...automation,
    status: "completed-local-attestation",
    role: automation.role || "provider",
    settlementJobId: automation.settlementJobId || definition.jobId,
    settlementJobStatus: automation.settlementJobStatus || definition.jobStatusLabel,
    reputationPublished: false,
    reputationPublishStatus: "demo-local",
    reputationAttestationKey:
      automation.reputationAttestationKey || definition.attestationKey
  };
  const alreadyReconciled =
    acceptanceEntry.metadata &&
    acceptanceEntry.metadata.demoSeedId === DEMO_SEED_ID &&
    acceptanceEntry.metadata.demoScenario === definition.id &&
    acceptanceEntry.metadata.demoRole === "acceptance" &&
    Object.entries(desiredAutomation).every(([key, value]) => automation[key] === value);

  if (alreadyReconciled) {
    return false;
  }

  await anpManager.vault.storeSignedDocument(acceptanceEntry.document, {
    ...(acceptanceEntry.metadata || {}),
    source: "demo-seed",
    demoSeedId: DEMO_SEED_ID,
    demoScenario: definition.id,
    demoRole: "acceptance",
    automation: desiredAutomation
  });
  return true;
}

function getScenarioSummary(definitions, state) {
  return {
    listings: definitions.length,
    documents: Object.keys(state.documents || {}).length,
    jobs: Object.keys((state.acp && state.acp.jobs) || {}).length,
    attestations: ((state.reputation && state.reputation.attestations) || []).length,
    humanPauses: ((state.reputation && state.reputation.humanPauses) || []).length
  };
}

async function getDemoListings(anpManager = new ANPManager()) {
  await anpManager.loadVault();
  const state = await anpManager.vault.load();
  const definitions = buildDemoListingCatalog();
  const listings = [];

  for (const definition of definitions) {
    const observation = findObservationForDefinition(state, definition);
    const listingEntry = findListingEntry(state, definition, observation);

    if (listingEntry || observation) {
      listings.push(toPublicListing(definition, listingEntry, observation));
      continue;
    }

    const bundle = await createListingBundle(anpManager, definition);
    listings.push(bundle.publicListing);
  }

  return listings;
}

async function seedDemoData(anpManager) {
  await anpManager.loadVault();
  await anpManager.ensureWallet();

  const definitions = buildDemoListingCatalog();
  const scenarioRefs = new Map();
  let changeCount = 0;

  for (const definition of definitions) {
    const listingRef = await ensureListingScenario(anpManager, definition);
    scenarioRefs.set(definition.id, listingRef);
    if (listingRef.changed) {
      changeCount += 1;
    }
  }

  const completedDefinition = definitions.find((definition) => definition.scenario === "completed");
  const completedListing = scenarioRefs.get(completedDefinition.id);
  if (await reconcileLegacyCompletedAcceptance(anpManager, completedDefinition, completedListing)) {
    changeCount += 1;
  }
  const completedBid = await ensureBidScenario(
    anpManager,
    completedDefinition,
    completedListing
  );
  changeCount += Number(Boolean(completedBid.changed));
  const completedAcceptance = await ensureAcceptanceScenario(
    anpManager,
    completedDefinition,
    completedListing,
    completedBid,
    {
      status: "completed-local-attestation",
      role: "provider",
      settlementJobId: completedDefinition.jobId,
      settlementJobStatus: completedDefinition.jobStatusLabel,
      reputationPublished: false,
      reputationPublishStatus: "demo-local",
      reputationAttestationKey: completedDefinition.attestationKey
    }
  );
  changeCount += Number(Boolean(completedAcceptance.changed));
  const completedJob = await ensureAcpJobScenario(
    anpManager,
    completedDefinition,
    completedListing,
    completedBid,
    completedAcceptance
  );
  changeCount += Number(Boolean(completedJob.changed));
  const completedAttestation = await ensureReputationAttestation(
    anpManager,
    completedDefinition,
    completedAcceptance
  );
  changeCount += Number(Boolean(completedAttestation.changed));

  const negotiatingDefinition = definitions.find(
    (definition) => definition.scenario === "negotiating"
  );
  const negotiatingListing = scenarioRefs.get(negotiatingDefinition.id);
  const negotiatingBid = await ensureBidScenario(
    anpManager,
    negotiatingDefinition,
    negotiatingListing
  );
  changeCount += Number(Boolean(negotiatingBid.changed));

  const fundedDefinition = definitions.find((definition) => definition.scenario === "funded");
  const fundedListing = scenarioRefs.get(fundedDefinition.id);
  const fundedBid = await ensureBidScenario(anpManager, fundedDefinition, fundedListing);
  changeCount += Number(Boolean(fundedBid.changed));
  const fundedAcceptance = await ensureAcceptanceScenario(
    anpManager,
    fundedDefinition,
    fundedListing,
    fundedBid,
    {
      status: "prepared",
      role: "provider",
      settlementJobId: fundedDefinition.jobId,
      settlementJobStatus: fundedDefinition.jobStatusLabel
    }
  );
  changeCount += Number(Boolean(fundedAcceptance.changed));
  const fundedJob = await ensureAcpJobScenario(
    anpManager,
    fundedDefinition,
    fundedListing,
    fundedBid,
    fundedAcceptance
  );
  changeCount += Number(Boolean(fundedJob.changed));

  const pausedDefinition = definitions.find((definition) => definition.scenario === "paused");
  const pausedListing = scenarioRefs.get(pausedDefinition.id);
  const pauseResult = await ensureHumanPause(anpManager, pausedDefinition, pausedListing);
  changeCount += Number(Boolean(pauseResult.changed));

  const state = await anpManager.vault.load();
  return {
    seeded: changeCount > 0,
    reason: changeCount > 0 ? null : "Demo data already loaded.",
    listings: await getDemoListings(anpManager),
    summary: getScenarioSummary(definitions, state)
  };
}

module.exports = {
  DEMO_SEED_ID,
  getDemoListings,
  seedDemoData
};
