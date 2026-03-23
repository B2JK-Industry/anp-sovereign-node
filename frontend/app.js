const STEP_LABELS = [
  "Discovery",
  "Signed Bid",
  "Negotiation",
  "Escrow / Funded",
  "Work Submitted"
];

const REFRESH_INTERVAL_MS = 45_000;

const elements = {
  feedback: document.querySelector("#api-feedback"),
  refreshButton: document.querySelector("#refresh-status"),
  fetchListingsButton: document.querySelector("#fetch-listings"),
  loadDemoButton: document.querySelector("#load-demo"),
  modeBanner: document.querySelector("#mode-banner"),
  walletChip: document.querySelector("#wallet-chip"),
  walletPower: document.querySelector("#wallet-power"),
  walletAddress: document.querySelector("#wallet-address"),
  walletMeta: document.querySelector("#wallet-meta"),
  reputationChip: document.querySelector("#reputation-chip"),
  reputationScore: document.querySelector("#reputation-score"),
  reputationSummary: document.querySelector("#reputation-summary"),
  heroWalletBadge: document.querySelector("#hero-wallet-badge"),
  heroDiscoveryBadge: document.querySelector("#hero-discovery-badge"),
  heroSettlementBadge: document.querySelector("#hero-settlement-badge"),
  lastUpdated: document.querySelector("#last-updated"),
  missionSummary: document.querySelector("#mission-summary"),
  metricProjects: document.querySelector("#metric-projects"),
  metricOpportunities: document.querySelector("#metric-opportunities"),
  metricAttestations: document.querySelector("#metric-attestations"),
  metricHumanPauses: document.querySelector("#metric-human-pauses"),
  projectCount: document.querySelector("#project-count"),
  projectBoard: document.querySelector("#project-board"),
  interventionCount: document.querySelector("#intervention-count"),
  interventions: document.querySelector("#manual-interventions"),
  activityFeed: document.querySelector("#activity-feed"),
  evidenceModal: document.querySelector("#evidence-modal"),
  evidenceTitle: document.querySelector("#evidence-title"),
  evidenceSummary: document.querySelector("#evidence-summary"),
  evidenceSwitcher: document.querySelector("#evidence-switcher"),
  evidenceMarket: document.querySelector("#evidence-market"),
  evidenceJson: document.querySelector("#evidence-json"),
  closeEvidenceButton: document.querySelector("#close-evidence")
};

const state = {
  status: null,
  snapshot: null,
  listings: [],
  projects: [],
  selectedProjectKey: null,
  selectedEvidenceId: null,
  pendingDecision: null
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncateMiddle(value, start = 12, end = 8) {
  const text = String(value || "");
  if (text.length <= start + end + 1) {
    return text;
  }

  return `${text.slice(0, start)}...${text.slice(-end)}`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toTimestamp(value) {
  if (!value) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareByRecent(left, right) {
  return toTimestamp(right.updatedAt || right.storedAt || right.recordedAt || right.observedAt) -
    toTimestamp(left.updatedAt || left.storedAt || left.recordedAt || left.observedAt);
}

function pickFirstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function getNestedValue(source, key) {
  const candidates = [
    source,
    source && source.data,
    source && source.payload,
    source && source.snapshot,
    source && source.document,
    source && source.document && source.document.data,
    source && source.listing
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && candidate[key] !== undefined) {
      return candidate[key];
    }
  }

  return null;
}

function getListingCid(listing) {
  return (
    pickFirstString(
      listing && listing.listingCid,
      listing && listing.cid,
      listing && listing.id,
      getNestedValue(listing, "listingCid"),
      getNestedValue(listing, "cid")
    ) || null
  );
}

function getListingHash(listing) {
  return (
    pickFirstString(
      listing && listing.listingHash,
      getNestedValue(listing, "listingHash")
    ) || null
  );
}

function getListingTitle(listing) {
  return (
    pickFirstString(
      listing && listing.title,
      listing && listing.name,
      getNestedValue(listing, "title"),
      getNestedValue(listing, "name"),
      listing && listing.description
    ) || "Untitled mission"
  );
}

function getListingDescription(listing) {
  return (
    pickFirstString(
      listing && listing.description,
      getNestedValue(listing, "description"),
      getNestedValue(listing, "summary")
    ) || "No context provided."
  );
}

function getListingBidCount(listing) {
  const fields = [
    "bidCount",
    "bidsCount",
    "proposalCount",
    "applicationCount",
    "offerCount",
    "responseCount"
  ];

  for (const field of fields) {
    const numeric = Number(getNestedValue(listing, field));
    if (Number.isFinite(numeric) && numeric >= 0) {
      return Math.floor(numeric);
    }
  }

  return 0;
}

function getListingUniqueAgentCount(listing) {
  const fields = [
    "uniqueAgentCount",
    "agentCount",
    "uniqueSignerCount",
    "providerCount"
  ];

  for (const field of fields) {
    const numeric = Number(getNestedValue(listing, field));
    if (Number.isFinite(numeric) && numeric >= 0) {
      return Math.floor(numeric);
    }
  }

  return null;
}

function getListingClient(listing) {
  return pickFirstString(
    listing && listing.clientAddress,
    getNestedValue(listing, "clientAddress"),
    getNestedValue(listing, "client"),
    getNestedValue(listing, "owner"),
    getNestedValue(listing, "buyer")
  );
}

function formatTimestamp(value) {
  if (!value) {
    return "n/a";
  }

  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return String(value);
  }

  return date.toLocaleString();
}

function formatEpochSeconds(value) {
  if (value === null || value === undefined || value === "") {
    return "No deadline";
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return String(value);
  }

  return formatTimestamp(numeric > 1e12 ? numeric : numeric * 1000);
}

function formatMicroUsdc(value) {
  if (value === null || value === undefined || value === "") {
    return "n/a";
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return String(value);
  }

  return `${(numeric / 1_000_000).toFixed(numeric % 1_000_000 === 0 ? 0 : 2)} USDC`;
}

function formatPlainUsdc(value) {
  if (value === null || value === undefined || value === "") {
    return "n/a";
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return String(value);
  }

  return `${numeric.toFixed(numeric % 1 === 0 ? 0 : 2)} USDC`;
}

function formatAddress(value) {
  return value ? truncateMiddle(value, 10, 8) : "Unknown";
}

function formatCompetition(bidCount) {
  if (bidCount >= 5) {
    return "Crowded";
  }

  if (bidCount >= 3) {
    return "Active";
  }

  if (bidCount >= 1) {
    return "Light";
  }

  return "Fresh";
}

function formatAgentsLabel(count) {
  const numeric = Number(count);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return "Unknown agents";
  }

  return `${numeric} ${numeric === 1 ? "agent" : "agents"}`;
}

function formatBidsLabel(count) {
  const numeric = Number(count);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return "Unknown bids";
  }

  return `${numeric} ${numeric === 1 ? "bid" : "bids"}`;
}

function buildMarketFact(project) {
  if (Number.isFinite(project.uniqueAgentCount)) {
    return `${project.competition} market · ${formatAgentsLabel(project.uniqueAgentCount)} / ${formatBidsLabel(project.bidCount)}`;
  }

  if (Number.isFinite(project.bidCount) && project.bidCount > 0) {
    return `${project.competition} market · ${formatBidsLabel(project.bidCount)}`;
  }

  return `${project.competition} market`;
}

function setFeedback(value, isError = false) {
  if (!elements.feedback) {
    return;
  }

  elements.feedback.textContent =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  elements.feedback.dataset.error = isError ? "true" : "false";
}

function setBusy(button, isBusy) {
  if (!button) {
    return;
  }

  button.disabled = isBusy;
  button.classList.toggle("is-busy", isBusy);
}

async function withBusyButton(button, action) {
  setBusy(button, true);
  try {
    return await action();
  } finally {
    setBusy(button, false);
  }
}

function setStatusPill(element, label, tone = "neutral") {
  if (!element) {
    return;
  }

  element.textContent = label;
  element.className = `status-pill status-${tone}`;
}

function renderModeBanner(status, listings = []) {
  if (!elements.modeBanner) {
    return;
  }

  if (status.discovery && status.discovery.configured) {
    elements.modeBanner.dataset.tone = "live";
    elements.modeBanner.innerHTML = `Live discovery is connected. <strong>${listings.length}</strong> ${
      listings.length === 1 ? "opportunity is" : "opportunities are"
    } visible from the active marketplace adapter.`;
    return;
  }

  elements.modeBanner.dataset.tone = "demo";
  elements.modeBanner.innerHTML =
    'Demo discovery is active. Use <strong>Load demo scenario</strong> for UI testing, or configure <code>ANP_MARKETPLACE_ADAPTER</code> and <code>ANP_DISCOVERY_URL</code> on the backend to switch this node to live network listings.';
}

function sortMostRecent(items) {
  return [...items].sort(compareByRecent);
}

function getObservationEntries(snapshot, listings) {
  const stored = Object.values(snapshot && snapshot.observations && snapshot.observations.listings
    ? snapshot.observations.listings
    : {});
  const live = Array.isArray(listings)
    ? listings.map((listing) => ({
        listingCid: getListingCid(listing),
        observedAt: listing.observedAt || listing.updatedAt || null,
        title: getListingTitle(listing),
        metadata: {
          adapter: "Discovery"
        },
        snapshot: listing
      }))
    : [];

  return [...stored, ...live];
}

function ensureProject(projects, key) {
  if (!projects.has(key)) {
    projects.set(key, {
      key,
      aliases: new Set(),
      listings: [],
      bids: [],
      acceptances: [],
      jobs: [],
      pauses: [],
      attestations: [],
      listingDocument: null,
      observation: null,
      latestUpdatedAt: null
    });
  }

  return projects.get(key);
}

function registerAliases(aliasMap, project, ...values) {
  for (const value of values) {
    if (!value) {
      continue;
    }

    aliasMap.set(value, project.key);
    project.aliases.add(value);
  }
}

function resolveProjectKey(aliasMap, ...values) {
  for (const value of values) {
    if (value && aliasMap.has(value)) {
      return aliasMap.get(value);
    }
  }

  return null;
}

function updateProjectTimestamp(project, ...values) {
  for (const value of values) {
    const timestamp = toTimestamp(value);
    if (timestamp && (!project.latestUpdatedAt || timestamp > toTimestamp(project.latestUpdatedAt))) {
      project.latestUpdatedAt = new Date(timestamp).toISOString();
    }
  }
}

function extractAttestationScore(attestation) {
  const candidates = [
    attestation && attestation.payload && attestation.payload.score,
    attestation && attestation.feedback && attestation.feedback.value,
    attestation && attestation.payload && attestation.payload.feedback && attestation.payload.feedback.value,
    attestation && attestation.payload && attestation.payload.value
  ];

  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  return null;
}

function getBidSummary(bid) {
  return pickFirstString(
    bid &&
      bid.metadata &&
      bid.metadata.message &&
      bid.metadata.message.summary,
    bid &&
      bid.metadata &&
      bid.metadata.message &&
      bid.metadata.message.message,
    bid &&
      bid.document &&
      bid.document.data &&
      typeof bid.document.data.message === "string"
      ? bid.document.data.message
      : null,
    bid &&
      bid.document &&
      bid.document.data &&
      bid.document.data.message &&
      bid.document.data.message.summary
  ) || "Signed bid published without additional commentary.";
}

function getBidPriceLabel(bid) {
  return pickFirstString(
    bid &&
      bid.metadata &&
      bid.metadata.message &&
      bid.metadata.message.proposedPriceUsdc
      ? `${bid.metadata.message.proposedPriceUsdc} USDC`
      : null,
    bid &&
      bid.document &&
      bid.document.data &&
      bid.document.data.price
      ? formatMicroUsdc(bid.document.data.price)
      : null
  ) || "Price unavailable";
}

function getBidDeliveryLabel(bid) {
  const deliveryValue =
    bid &&
    bid.document &&
    bid.document.data &&
    (bid.document.data.deliveryTime || bid.document.data.deliverySeconds);
  const numeric = Number(deliveryValue);

  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "Delivery n/a";
  }

  const days = numeric / 86_400;
  if (Number.isInteger(days)) {
    return `${days} ${days === 1 ? "day" : "days"}`;
  }

  const hours = numeric / 3_600;
  if (Number.isInteger(hours)) {
    return `${hours}h`;
  }

  return `${numeric}s`;
}

function buildMarketEvidenceSource(project) {
  const bids = project.bids.map((bid) => ({
    cid: bid.cid,
    signer: bid.document && bid.document.signer ? bid.document.signer : bid.signer || null,
    price: getBidPriceLabel(bid),
    delivery: getBidDeliveryLabel(bid),
    createdAt: bid.updatedAt || bid.storedAt || null,
    summary: getBidSummary(bid)
  }));

  return {
    id: `${project.key}:market`,
    label: "Market",
    meta: Number.isFinite(project.uniqueAgentCount)
      ? `${formatAgentsLabel(project.uniqueAgentCount)} · ${formatBidsLabel(project.bidCount)}`
      : formatBidsLabel(project.bidCount),
    kind: "market",
    market: {
      listingCid: project.listingCid,
      status: project.status.label,
      competition: project.competition,
      uniqueAgentCount: project.uniqueAgentCount,
      bidCount: project.bidCount,
      bids
    },
    payload: {
      listingCid: project.listingCid,
      title: project.title,
      status: project.status.label,
      competition: project.competition,
      uniqueAgentCount: project.uniqueAgentCount,
      bidCount: project.bidCount,
      clientAddress: project.clientAddress,
      proposedBidUsdc: project.proposedBidUsdc,
      bids
    }
  };
}

function buildProjectStatus(project) {
  const hasBid = project.bids.length > 0;
  const hasAcceptance = project.acceptances.length > 0;
  const pendingPause = project.pendingPause;
  const latestPause = project.latestPause;
  const jobStatus = String(
    (project.latestJob && (project.latestJob.statusLabel ||
      (project.latestJob.job && project.latestJob.job.statusLabel) ||
      (project.latestJob.job && project.latestJob.job.status))) ||
      (project.latestAcceptance &&
        project.latestAcceptance.metadata &&
        project.latestAcceptance.metadata.automation &&
        project.latestAcceptance.metadata.automation.settlementJobStatus) ||
      ""
  ).toLowerCase();
  const workSubmitted = /submitted|completed/.test(jobStatus);

  if (latestPause && latestPause.decision === "reject") {
    return {
      kind: "rejected",
      tone: "danger",
      label: "Rejected by owner",
      detail: latestPause.note || latestPause.reason || "Manual review rejected auto-bid."
    };
  }

  if (workSubmitted) {
    return {
      kind: "completed",
      tone: "ready",
      label: "Work submitted",
      detail: project.latestJob
        ? `ACP job ${project.latestJob.jobId} reached ${project.latestJob.statusLabel || "completion"}.`
        : "Acceptance completed and deliverable was submitted."
    };
  }

  if (hasAcceptance || project.jobs.length) {
    return {
      kind: "funded",
      tone: "accent",
      label: "Settlement armed",
      detail: project.latestJob
        ? `ACP job ${project.latestJob.jobId} is ${project.latestJob.statusLabel || "in flight"}.`
        : "Acceptance verified locally and ready for escrow."
    };
  }

  if (pendingPause) {
    return {
      kind: "paused",
      tone: "warning",
      label: "Human approval required",
      detail: pendingPause.reason || "Auto-bid paused until owner approval."
    };
  }

  if (hasBid) {
    return {
      kind: "negotiating",
      tone: "accent",
      label: "Negotiating",
      detail: project.proposedBidUsdc
        ? `Signed bid sent for ${project.proposedBidUsdc}.`
        : "Signed bid published and awaiting response."
    };
  }

  return {
    kind: "discovery",
    tone: "neutral",
    label: "Discovery active",
    detail: "Opportunity is tracked but no signed bid has been issued yet."
  };
}

function buildLifecycleSteps(project) {
  const hasDiscovery = Boolean(project.observation || project.listingDocument || project.listings.length);
  const hasBid = project.bids.length > 0;
  const hasAcceptance = project.acceptances.length > 0 || project.jobs.length > 0;
  const jobStatus = String(
    (project.latestJob && (project.latestJob.statusLabel ||
      (project.latestJob.job && project.latestJob.job.statusLabel) ||
      (project.latestJob.job && project.latestJob.job.status))) ||
      (project.latestAcceptance &&
        project.latestAcceptance.metadata &&
        project.latestAcceptance.metadata.automation &&
        project.latestAcceptance.metadata.automation.settlementJobStatus) ||
      ""
  ).toLowerCase();
  const hasWorkSubmitted = /submitted|completed/.test(jobStatus);
  const activeIndex = hasWorkSubmitted ? 4 : hasAcceptance ? 3 : hasBid ? 2 : 1;

  return STEP_LABELS.map((label, index) => {
    let complete = false;
    if (index === 0) {
      complete = hasDiscovery;
    } else if (index === 1) {
      complete = hasBid;
    } else if (index === 2) {
      complete = hasAcceptance;
    } else if (index === 3) {
      complete = hasAcceptance;
    } else if (index === 4) {
      complete = hasWorkSubmitted;
    }

    return {
      label,
      complete,
      active: !complete && index === activeIndex,
      waiting: !complete && index !== activeIndex
    };
  });
}

function buildEvidenceSources(project) {
  const sources = [];

  if (project.listingCid || project.bids.length || project.bidCount) {
    sources.push(buildMarketEvidenceSource(project));
  }

  if (project.listingDocument) {
    sources.push({
      id: `${project.key}:listing`,
      label: "Listing Intent",
      meta: project.listingDocument.cid || "listing",
      payload: project.listingDocument
    });
  }

  if (project.latestBid) {
    sources.push({
      id: `${project.key}:bid`,
      label: "Signed Bid",
      meta: project.latestBid.cid || "bid",
      payload: project.latestBid
    });
  }

  if (project.latestAcceptance) {
    sources.push({
      id: `${project.key}:acceptance`,
      label: "Acceptance",
      meta: project.latestAcceptance.cid || "acceptance",
      payload: project.latestAcceptance
    });
  }

  if (project.latestJob) {
    sources.push({
      id: `${project.key}:job`,
      label: "ACP Settlement",
      meta: project.latestJob.jobId || "acp-job",
      payload: project.latestJob
    });
  }

  if (project.latestAttestation) {
    sources.push({
      id: `${project.key}:attestation`,
      label: "Attestation",
      meta: project.latestAttestation.attestationKey || "attestation",
      payload: project.latestAttestation
    });
  }

  if (project.latestPause) {
    sources.push({
      id: `${project.key}:pause`,
      label: "Human Pause",
      meta: project.latestPause.listingCid || "pause",
      payload: project.latestPause
    });
  }

  return sources;
}

function buildProjects(snapshot, listings) {
  const aliasMap = new Map();
  const projects = new Map();
  const documents = sortMostRecent(Object.values((snapshot && snapshot.documents) || {}));

  for (const observation of getObservationEntries(snapshot, listings)) {
    const listing = observation.snapshot || observation;
    const candidates = [
      getListingHash(listing),
      observation.listingCid,
      getListingCid(listing),
      listing && listing.cid
    ];
    const projectKey = resolveProjectKey(aliasMap, ...candidates) ||
      candidates.find(Boolean) ||
      `project-${projects.size + 1}`;
    const project = ensureProject(projects, projectKey);

    if (!project.observation || compareByRecent(observation, project.observation) < 0) {
      project.observation = observation;
    }

    project.listings.push(listing);
    registerAliases(aliasMap, project, ...candidates);
    updateProjectTimestamp(project, observation.observedAt, listing.updatedAt);
  }

  for (const document of documents) {
    if (document.type === "listing") {
      const candidates = [document.typedHash, document.cid];
      const projectKey = resolveProjectKey(aliasMap, ...candidates) ||
        candidates.find(Boolean) ||
        document.cid;
      const project = ensureProject(projects, projectKey);

      if (!project.listingDocument) {
        project.listingDocument = document;
      }

      registerAliases(aliasMap, project, ...candidates);
      updateProjectTimestamp(project, document.updatedAt, document.storedAt);
      continue;
    }

    if (document.type === "bid") {
      const candidates = [
        document.document && document.document.data && document.document.data.listingHash,
        document.metadata && document.metadata.listingCid,
        document.cid,
        document.typedHash
      ];
      const projectKey = resolveProjectKey(aliasMap, ...candidates) ||
        candidates.find(Boolean) ||
        document.cid;
      const project = ensureProject(projects, projectKey);

      project.bids.push(document);
      registerAliases(aliasMap, project, ...candidates);
      updateProjectTimestamp(project, document.updatedAt, document.storedAt);
      continue;
    }

    if (document.type === "acceptance") {
      const candidates = [
        document.document && document.document.data && document.document.data.listingHash,
        document.metadata &&
          document.metadata.automation &&
          document.metadata.automation.settlement &&
          document.metadata.automation.settlement.listingHash,
        document.metadata &&
          document.metadata.automation &&
          document.metadata.automation.settlement &&
          document.metadata.automation.settlement.listingCid,
        document.cid,
        document.typedHash
      ];
      const projectKey = resolveProjectKey(aliasMap, ...candidates) ||
        (document.document &&
          document.document.data &&
          resolveProjectKey(aliasMap, document.document.data.bidHash)) ||
        candidates.find(Boolean) ||
        document.cid;
      const project = ensureProject(projects, projectKey);

      project.acceptances.push(document);
      registerAliases(
        aliasMap,
        project,
        ...candidates,
        document.document && document.document.data && document.document.data.bidHash
      );
      updateProjectTimestamp(project, document.updatedAt, document.storedAt);
    }
  }

  const jobs = Object.values((snapshot && snapshot.acp && snapshot.acp.jobs) || {});
  for (const job of jobs) {
    const candidates = [job.listingCid, job.acceptCid, job.bidCid, job.jobId];
    const projectKey = resolveProjectKey(aliasMap, ...candidates) ||
      candidates.find(Boolean) ||
      job.jobId;
    const project = ensureProject(projects, projectKey);

    project.jobs.push(job);
    registerAliases(aliasMap, project, ...candidates);
    updateProjectTimestamp(project, job.updatedAt);
  }

  const pauses = sortMostRecent(
    (((snapshot && snapshot.reputation) || {}).humanPauses) || []
  );
  for (const pause of pauses) {
    const candidates = [pause.listingCid];
    const projectKey = resolveProjectKey(aliasMap, ...candidates) ||
      candidates.find(Boolean) ||
      `pause-${pause.recordedAt}`;
    const project = ensureProject(projects, projectKey);

    project.pauses.push(pause);
    registerAliases(aliasMap, project, ...candidates);
    updateProjectTimestamp(project, pause.decidedAt, pause.recordedAt);
  }

  const attestations = sortMostRecent(
    (((snapshot && snapshot.reputation) || {}).attestations) || []
  );
  for (const attestation of attestations) {
    const candidates = [attestation.acceptCid, attestation.jobId, attestation.attestationKey];
    const projectKey = resolveProjectKey(aliasMap, ...candidates) ||
      candidates.find(Boolean) ||
      attestation.attestationKey;
    const project = ensureProject(projects, projectKey);

    project.attestations.push(attestation);
    registerAliases(aliasMap, project, ...candidates);
    updateProjectTimestamp(project, attestation.updatedAt, attestation.recordedAt);
  }

  const projectList = [...projects.values()].map((project) => {
    project.bids = sortMostRecent(project.bids);
    project.acceptances = sortMostRecent(project.acceptances);
    project.jobs = sortMostRecent(project.jobs);
    project.pauses = sortMostRecent(project.pauses);
    project.attestations = sortMostRecent(project.attestations);

    project.latestBid = project.bids[0] || null;
    project.latestAcceptance = project.acceptances[0] || null;
    project.latestJob = project.jobs[0] || null;
    project.latestPause = project.pauses[0] || null;
    project.pendingPause =
      project.pauses.find((entry) => !entry.decision && !entry.decidedAt) || null;
    project.latestAttestation = project.attestations[0] || null;

    const primaryListing = project.observation && project.observation.snapshot
      ? project.observation.snapshot
      : project.listings[0] || null;
    const listingDocumentData = project.listingDocument &&
      project.listingDocument.document &&
      project.listingDocument.document.data
      ? project.listingDocument.document.data
      : {};

    project.title =
      pickFirstString(
        project.observation && project.observation.title,
        primaryListing && getListingTitle(primaryListing),
        project.latestBid &&
          project.latestBid.metadata &&
          project.latestBid.metadata.message &&
          project.latestBid.metadata.message.title,
        project.latestPause && project.latestPause.title
      ) || "Untitled mission";
    project.description =
      pickFirstString(
        primaryListing && getListingDescription(primaryListing),
        project.latestBid &&
          project.latestBid.metadata &&
          project.latestBid.metadata.message &&
          project.latestBid.metadata.message.summary,
        project.latestPause && project.latestPause.reason,
        project.latestJob &&
          project.latestJob.job &&
          project.latestJob.job.description
      ) || "No mission context available.";
    project.clientAddress =
      pickFirstString(
        primaryListing && getListingClient(primaryListing),
        project.latestBid && project.latestBid.metadata && project.latestBid.metadata.clientId,
        project.latestPause && project.latestPause.clientId,
        project.latestJob && project.latestJob.client,
        project.latestAcceptance &&
          project.latestAcceptance.metadata &&
          project.latestAcceptance.metadata.automation &&
          project.latestAcceptance.metadata.automation.settlement &&
          project.latestAcceptance.metadata.automation.settlement.client
      ) || null;
    project.maxBudgetMicro =
      getNestedValue(primaryListing, "maxBudget") ||
      listingDocumentData.maxBudget ||
      (project.latestJob && project.latestJob.job && project.latestJob.job.budget) ||
      null;
    project.minBudgetMicro =
      getNestedValue(primaryListing, "minBudget") ||
      listingDocumentData.minBudget ||
      null;
    project.deadline =
      getNestedValue(primaryListing, "deadline") ||
      listingDocumentData.deadline ||
      (project.latestJob && project.latestJob.job && project.latestJob.job.expiredAt) ||
      null;
    const observedBidCount = primaryListing ? getListingBidCount(primaryListing) : 0;
    const observedUniqueAgentCount = primaryListing
      ? getListingUniqueAgentCount(primaryListing)
      : null;
    const uniqueBidSigners = new Set(
      project.bids
        .map((bid) => bid && bid.document && bid.document.signer)
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.toLowerCase())
    );
    project.bidCount = Math.max(observedBidCount, project.bids.length);
    project.uniqueAgentCount = uniqueBidSigners.size || observedUniqueAgentCount;
    project.competition = formatCompetition(project.bidCount);
    project.confidenceScore = Number(
      (project.latestBid &&
        project.latestBid.metadata &&
        project.latestBid.metadata.confidence &&
        project.latestBid.metadata.confidence.score) ||
        (project.latestPause && project.latestPause.confidence) ||
        NaN
    );
    project.proposedBidUsdc =
      pickFirstString(
        project.latestBid &&
          project.latestBid.metadata &&
          project.latestBid.metadata.message &&
          project.latestBid.metadata.message.proposedPriceUsdc,
        project.latestPause && project.latestPause.proposedBidUsdc
      ) ||
      (project.latestBid &&
      project.latestBid.document &&
      project.latestBid.document.data &&
      project.latestBid.document.data.price
        ? formatMicroUsdc(project.latestBid.document.data.price)
        : null);
    project.jobStatus =
      pickFirstString(
        project.latestJob && project.latestJob.statusLabel,
        project.latestJob &&
          project.latestJob.job &&
          project.latestJob.job.statusLabel,
        project.latestAcceptance &&
          project.latestAcceptance.metadata &&
          project.latestAcceptance.metadata.automation &&
          project.latestAcceptance.metadata.automation.settlementJobStatus
      ) || "Awaiting settlement";
    project.listingCid =
      pickFirstString(
        primaryListing && getListingCid(primaryListing),
        project.latestBid && project.latestBid.metadata && project.latestBid.metadata.listingCid,
        project.latestPause && project.latestPause.listingCid
      ) || null;
    project.status = buildProjectStatus(project);
    project.steps = buildLifecycleSteps(project);
    project.evidenceSources = buildEvidenceSources(project);
    project.primaryEvidenceId = project.evidenceSources[0] ? project.evidenceSources[0].id : null;

    return project;
  });

  const priority = {
    paused: 0,
    funded: 1,
    negotiating: 2,
    discovery: 3,
    completed: 4,
    rejected: 5
  };

  return projectList.sort((left, right) => {
    const leftPriority = priority[left.status.kind] ?? 99;
    const rightPriority = priority[right.status.kind] ?? 99;

    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }

    return toTimestamp(right.latestUpdatedAt) - toTimestamp(left.latestUpdatedAt);
  });
}

function deriveReputation(snapshot, projects) {
  const attestations = (((snapshot && snapshot.reputation) || {}).attestations) || [];
  const humanPauses = (((snapshot && snapshot.reputation) || {}).humanPauses) || [];
  const attestationScores = attestations
    .map(extractAttestationScore)
    .filter((value) => Number.isFinite(value));
  const completedJobs = projects.filter((project) => project.status.kind === "completed").length;
  const verifiedDocuments = Object.values((snapshot && snapshot.documents) || {}).filter(
    (entry) => entry.verification && entry.verification.valid
  ).length;
  const rejectedCount = humanPauses.filter((entry) => entry.decision === "reject").length;
  const pendingCount = humanPauses.filter((entry) => !entry.decision && !entry.decidedAt).length;
  const averageAttestation = attestationScores.length
    ? attestationScores.reduce((sum, value) => sum + value, 0) / attestationScores.length
    : null;
  const rawScore = averageAttestation === null
    ? 54 + completedJobs * 11 + attestations.length * 5 + verifiedDocuments * 1.2
    : averageAttestation + completedJobs * 2;
  const score = clamp(
    Math.round(rawScore - rejectedCount * 6 - pendingCount * 2),
    0,
    100
  );
  let label = "Cold start";

  if (score >= 90) {
    label = "Prime";
  } else if (score >= 75) {
    label = "Trusted";
  } else if (score >= 60) {
    label = "Stable";
  } else if (score >= 40) {
    label = "Building";
  }

  return {
    score,
    label,
    summary: `${attestations.length} attestations, ${completedJobs} completed settlement ${
      completedJobs === 1 ? "mission" : "missions"
    }, ${pendingCount} human ${
      pendingCount === 1 ? "pause" : "pauses"
    } waiting.`
  };
}

function buildMissionSummary(status, reputation, projects, listings) {
  const liveProjects = projects.filter((project) =>
    ["funded", "negotiating", "paused"].includes(project.status.kind)
  ).length;

  if (status.discovery.configured && status.settlement.configured) {
    return `Discovery and Base settlement are both armed. ${liveProjects} mission${
      liveProjects === 1 ? "" : "s"
    } are active, and reputation sits at ${reputation.score}/100.`;
  }

  if (status.discovery.configured) {
    return `Discovery is live with ${listings.length} visible opportunit${
      listings.length === 1 ? "y" : "ies"
    }. Settlement is still local-only until Base RPC is configured.`;
  }

  return `Running in sovereign local mode. ${projects.length} tracked mission${
    projects.length === 1 ? "" : "s"
  } can still be explored with demo listings and locally verified ANP evidence.`;
}

function renderStatus(status, snapshot, projects, listings) {
  const wallet = status.wallet || {};
  const baseWallet = wallet.base || {};
  const vaultCounts = status.vault && status.vault.counts ? status.vault.counts : {};
  const reputation = deriveReputation(snapshot, projects);

  setStatusPill(
    elements.walletChip,
    baseWallet.configured
      ? baseWallet.balances
        ? "Base linked"
        : "RPC degraded"
      : "Base offline",
    baseWallet.configured ? (baseWallet.balances ? "ready" : "warning") : "neutral"
  );
  setStatusPill(
    elements.reputationChip,
    reputation.label,
    reputation.score >= 75 ? "ready" : reputation.score >= 50 ? "accent" : "warning"
  );
  setStatusPill(
    elements.heroWalletBadge,
    wallet.address ? "Wallet armed" : "Wallet missing",
    wallet.address ? "ready" : "danger"
  );
  setStatusPill(
    elements.heroDiscoveryBadge,
    status.discovery && status.discovery.configured ? "Discovery live" : "Discovery offline",
    status.discovery && status.discovery.configured ? "ready" : "warning"
  );
  setStatusPill(
    elements.heroSettlementBadge,
    status.settlement && status.settlement.configured ? "Settlement armed" : "Settlement idle",
    status.settlement && status.settlement.configured ? "accent" : "warning"
  );

  if (baseWallet.configured && baseWallet.balances) {
    elements.walletPower.textContent = `${formatPlainUsdc(baseWallet.balances.usdcFormatted)}`;
    elements.walletAddress.textContent = wallet.address || "Unknown wallet";
    elements.walletMeta.textContent =
      `${Number(baseWallet.balances.nativeFormatted).toFixed(4)} ETH on Base | ${
        wallet.walletPath && wallet.walletPath.startsWith("env:")
          ? "Key loaded from environment"
          : wallet.walletPath || "Unknown source"
      }`;
  } else if (baseWallet.configured && baseWallet.error) {
    elements.walletPower.textContent = "RPC DEGRADED";
    elements.walletAddress.textContent = wallet.address || "Unknown wallet";
    elements.walletMeta.textContent = baseWallet.error;
  } else {
    elements.walletPower.textContent = "BASE LINK IDLE";
    elements.walletAddress.textContent = wallet.address || "Wallet unavailable";
    elements.walletMeta.textContent =
      "Set ANP_BASE_RPC_URL to show live Base balances and settlement readiness.";
  }

  elements.reputationScore.textContent = `${reputation.score}`;
  elements.reputationSummary.textContent = reputation.summary;
  elements.lastUpdated.textContent = `Updated ${formatTimestamp(status.timestamp)}`;
  elements.metricProjects.textContent = String(projects.length);
  elements.metricOpportunities.textContent = String(listings.length);
  elements.metricAttestations.textContent = String(vaultCounts.reputationAttestations || 0);
  elements.metricHumanPauses.textContent = String(vaultCounts.humanPauses || 0);
  elements.projectCount.textContent = `${projects.length} mission${projects.length === 1 ? "" : "s"}`;
  elements.missionSummary.textContent = buildMissionSummary(status, reputation, projects, listings);
  renderModeBanner(status, listings);
}

function renderProjectBoard(projects) {
  if (!projects.length) {
    elements.projectBoard.innerHTML =
      '<p class="empty-state">No negotiated projects yet. Pull listings or seed a demo scenario.</p>';
    return;
  }

  elements.projectBoard.innerHTML = projects
    .map((project) => {
      const confidence = Number.isFinite(project.confidenceScore)
        ? `${Math.round(project.confidenceScore * 100)}% confidence`
        : "Confidence pending";
      const facts = [
        project.maxBudgetMicro ? `Budget ceiling ${formatMicroUsdc(project.maxBudgetMicro)}` : null,
        project.proposedBidUsdc ? `Bid ${project.proposedBidUsdc}` : "No bid yet",
        project.bidCount || project.bidCount === 0
          ? buildMarketFact(project)
          : null,
        project.jobStatus ? `ACP ${project.jobStatus}` : null
      ].filter(Boolean);

      return `
        <article class="project-card project-card-${escapeHtml(project.status.tone)}">
          <div class="project-card-head">
            <div>
              <p class="panel-kicker">Mission</p>
              <h3>${escapeHtml(project.title)}</h3>
            </div>
            <span class="status-pill status-${escapeHtml(project.status.tone)}">
              ${escapeHtml(project.status.label)}
            </span>
          </div>

          <p class="project-description">${escapeHtml(project.description)}</p>

          <div class="project-facts">
            ${facts
              .map((fact) => `<span class="metric-chip">${escapeHtml(fact)}</span>`)
              .join("")}
          </div>

          <div class="project-meta-grid">
            <div class="meta-block">
              <span class="meta-label">Client</span>
              <strong title="${escapeHtml(project.clientAddress || "")}">
                ${escapeHtml(formatAddress(project.clientAddress))}
              </strong>
            </div>
            <div class="meta-block">
              <span class="meta-label">Deadline</span>
              <strong>${escapeHtml(formatEpochSeconds(project.deadline))}</strong>
            </div>
            <div class="meta-block">
              <span class="meta-label">Confidence</span>
              <strong>${escapeHtml(confidence)}</strong>
            </div>
            <div class="meta-block">
              <span class="meta-label">Last movement</span>
              <strong>${escapeHtml(formatTimestamp(project.latestUpdatedAt))}</strong>
            </div>
          </div>

          <ol class="stepper" aria-label="Project lifecycle">
            ${project.steps
              .map(
                (step) => `
                  <li class="step ${step.complete ? "is-complete" : ""} ${
                    step.active ? "is-active" : ""
                  } ${step.waiting ? "is-waiting" : ""}">
                    <span class="step-dot"></span>
                    <span class="step-label">${escapeHtml(step.label)}</span>
                  </li>
                `
              )
              .join("")}
          </ol>

          <div class="project-card-foot">
            <p class="project-detail">${escapeHtml(project.status.detail)}</p>
            <button
              class="button button-inline"
              type="button"
              data-action="view-evidence"
              data-project-key="${escapeHtml(project.key)}"
            >
              View Evidence
            </button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderInterventions(projects) {
  const pauses = projects
    .flatMap((project) =>
      project.pauses.map((pause) => ({
        ...pause,
        projectTitle: project.title,
        projectKey: project.key
      }))
    )
    .sort(compareByRecent);

  const unresolvedCount = pauses.filter((pause) => !pause.decision && !pause.decidedAt).length;
  elements.interventionCount.textContent = `${unresolvedCount} waiting`;

  if (!pauses.length) {
    elements.interventions.innerHTML =
      '<p class="empty-state">No human pauses waiting for a decision.</p>';
    return;
  }

  elements.interventions.innerHTML = pauses
    .map((pause) => {
      const resolved = Boolean(pause.decision || pause.decidedAt);
      const tone = pause.decision === "reject"
        ? "danger"
        : pause.approved === true
          ? "ready"
          : resolved
            ? "neutral"
            : "warning";
      const label = pause.decision === "approve"
        ? "Approved"
        : pause.decision === "reject"
          ? "Rejected"
          : "Awaiting decision";
      const pauseReference = pause.demoScenario || pause.listingCid;
      const isPending = state.pendingDecision === `${pauseReference}:approve` ||
        state.pendingDecision === `${pauseReference}:reject`;

      return `
        <article class="intervention-card">
          <div class="intervention-head">
            <div>
              <p class="panel-kicker">Manual pause</p>
              <h3>${escapeHtml(pause.projectTitle || pause.title || "Unlabeled mission")}</h3>
            </div>
            <span class="status-pill status-${tone}">${escapeHtml(label)}</span>
          </div>

          <p class="intervention-copy">${escapeHtml(
            pause.reason || "High-value opportunity requires explicit human review."
          )}</p>

          <div class="intervention-metrics">
            <span class="metric-chip">Proposed ${escapeHtml(pause.proposedBidUsdc || "n/a")} USDC</span>
            <span class="metric-chip">Confidence ${
              pause.confidence !== null && pause.confidence !== undefined
                ? `${Math.round(Number(pause.confidence) * 100)}%`
                : "n/a"
            }</span>
          </div>

          <div class="intervention-foot">
            <span class="muted">${escapeHtml(formatTimestamp(pause.recordedAt))}</span>
            ${
              resolved
                ? `<span class="muted">${escapeHtml(
                    `Resolved ${formatTimestamp(pause.decidedAt || pause.recordedAt)}`
                  )}</span>`
                : ""
            }
          </div>

          ${
            resolved
              ? ""
              : `
                <div class="intervention-actions">
                  <button
                    class="button button-approve"
                    type="button"
                    data-action="human-decision"
                    data-decision="approve"
                    data-listing-cid="${escapeHtml(pause.listingCid || "")}"
                    data-demo-scenario="${escapeHtml(pause.demoScenario || "")}"
                    ${isPending ? "disabled" : ""}
                  >
                    APPROVE BID
                  </button>
                  <button
                    class="button button-reject"
                    type="button"
                    data-action="human-decision"
                    data-decision="reject"
                    data-listing-cid="${escapeHtml(pause.listingCid || "")}"
                    data-demo-scenario="${escapeHtml(pause.demoScenario || "")}"
                    ${isPending ? "disabled" : ""}
                  >
                    REJECT
                  </button>
                </div>
              `
          }
        </article>
      `;
    })
    .join("");
}

function hideMarketWindow() {
  if (!elements.evidenceMarket) {
    return;
  }

  elements.evidenceMarket.classList.add("is-hidden");
  elements.evidenceMarket.innerHTML = "";
}

function renderMarketWindow(selectedSource) {
  if (!elements.evidenceMarket || !selectedSource || selectedSource.kind !== "market") {
    hideMarketWindow();
    return;
  }

  const market = selectedSource.market || {};
  const walletAddress = state.status &&
    state.status.wallet &&
    typeof state.status.wallet.address === "string"
    ? state.status.wallet.address.toLowerCase()
    : null;
  const bids = Array.isArray(market.bids) ? market.bids : [];

  elements.evidenceMarket.classList.remove("is-hidden");
  elements.evidenceMarket.innerHTML = `
    <div class="market-window-head">
      <div class="market-window-chips">
        <span class="metric-chip">${escapeHtml(market.competition || "Fresh")} market</span>
        <span class="metric-chip">${escapeHtml(formatBidsLabel(market.bidCount || 0))}</span>
        <span class="metric-chip">${escapeHtml(
          Number.isFinite(market.uniqueAgentCount)
            ? formatAgentsLabel(market.uniqueAgentCount)
            : "Agents unknown"
        )}</span>
        <span class="metric-chip">${escapeHtml(market.status || "Discovery")}</span>
      </div>
      ${
        market.listingCid
          ? `<span class="ghost-chip">${escapeHtml(truncateMiddle(market.listingCid, 16, 10))}</span>`
          : ""
      }
    </div>

    <div class="market-bid-list">
      ${
        bids.length
          ? bids
              .map((bid) => {
                const isOwnBid = walletAddress &&
                  typeof bid.signer === "string" &&
                  bid.signer.toLowerCase() === walletAddress;

                return `
                  <article class="market-bid-card ${isOwnBid ? "is-own-bid" : ""}">
                    <div class="market-bid-head">
                      <div>
                        <p class="panel-kicker">Bid contender</p>
                        <strong>${escapeHtml(formatAddress(bid.signer))}</strong>
                      </div>
                      <span class="status-pill status-${isOwnBid ? "ready" : "accent"}">
                        ${escapeHtml(isOwnBid ? "Our bid" : "External bid")}
                      </span>
                    </div>

                    <div class="market-bid-metrics">
                      <span class="metric-chip">${escapeHtml(bid.price || "Price unavailable")}</span>
                      <span class="metric-chip">${escapeHtml(bid.delivery || "Delivery n/a")}</span>
                      <span class="ghost-chip">${escapeHtml(formatTimestamp(bid.createdAt))}</span>
                    </div>

                    <p class="market-bid-copy">${escapeHtml(bid.summary || "No summary provided.")}</p>
                  </article>
                `;
              })
              .join("")
          : '<p class="empty-state">No signed bids are stored for this mission yet. Discovery may know the listing, but detailed market bids are not in the local vault.</p>'
      }
    </div>
  `;
}

function renderActivity(activity) {
  if (!activity.length) {
    elements.activityFeed.innerHTML =
      '<p class="empty-state">No activity recorded yet.</p>';
    return;
  }

  elements.activityFeed.innerHTML = activity
    .map((entry) => {
      const details = entry.details && typeof entry.details === "object"
        ? Object.entries(entry.details)
        : [];

      return `
        <article class="activity-item">
          <div class="activity-head">
            <div>
              <p class="panel-kicker">Vault event</p>
              <strong>${escapeHtml(entry.event)}</strong>
            </div>
            <span class="ghost-chip">${escapeHtml(formatTimestamp(entry.recordedAt))}</span>
          </div>
          ${
            details.length
              ? `
                <div class="activity-grid">
                  ${details
                    .slice(0, 6)
                    .map(
                      ([key, value]) => `
                        <div class="activity-row">
                          <span class="meta-label">${escapeHtml(key)}</span>
                          <span class="meta-value" title="${escapeHtml(
                            typeof value === "string" ? value : JSON.stringify(value)
                          )}">
                            ${escapeHtml(
                              typeof value === "string"
                                ? truncateMiddle(value, 22, 14)
                                : JSON.stringify(value)
                            )}
                          </span>
                        </div>
                      `
                    )
                    .join("")}
                </div>
              `
              : ""
          }
        </article>
      `;
    })
    .join("");
}

function syntaxHighlightJson(value) {
  const json = escapeHtml(JSON.stringify(value, null, 2) || "{}");

  return json.replace(
    /("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?/g,
    (match, stringToken, keySuffix) => {
      if (stringToken) {
        const raw = stringToken.slice(1, -1);

        if (keySuffix) {
          let keyClass = "token token-key";
          if (/signature/i.test(raw)) {
            keyClass += " token-key-signature";
          } else if (/cid|hash/i.test(raw)) {
            keyClass += " token-key-cid";
          }

          return `<span class="${keyClass}">${stringToken}</span>${keySuffix}`;
        }

        if (/^sha256-[0-9a-f]{64}$/i.test(raw)) {
          return `<span class="token token-cid">${stringToken}</span>`;
        }

        if (/^0x[a-f0-9]{130}$/i.test(raw)) {
          return `<span class="token token-signature">${stringToken}</span>`;
        }

        if (/^0x[a-f0-9]{64}$/i.test(raw)) {
          return `<span class="token token-hash">${stringToken}</span>`;
        }

        if (/^0x[a-f0-9]{40}$/i.test(raw)) {
          return `<span class="token token-address">${stringToken}</span>`;
        }

        return `<span class="token token-string">${stringToken}</span>`;
      }

      if (/true|false/.test(match)) {
        return `<span class="token token-boolean">${match}</span>`;
      }

      if (/null/.test(match)) {
        return `<span class="token token-null">${match}</span>`;
      }

      return `<span class="token token-number">${match}</span>`;
    }
  );
}

function getProjectByKey(projectKey) {
  return state.projects.find((project) => project.key === projectKey) || null;
}

function openEvidence(projectKey) {
  const project = getProjectByKey(projectKey);
  if (!project || !project.evidenceSources.length) {
    return;
  }

  state.selectedProjectKey = projectKey;
  state.selectedEvidenceId = project.primaryEvidenceId || project.evidenceSources[0].id;
  renderEvidenceModal();
}

function closeEvidenceModal() {
  state.selectedProjectKey = null;
  state.selectedEvidenceId = null;
  renderEvidenceModal();
}

function renderEvidenceModal() {
  const project = state.selectedProjectKey ? getProjectByKey(state.selectedProjectKey) : null;
  if (!project) {
    elements.evidenceModal.classList.add("is-hidden");
    elements.evidenceModal.setAttribute("aria-hidden", "true");
    hideMarketWindow();
    return;
  }

  const selectedSource =
    project.evidenceSources.find((entry) => entry.id === state.selectedEvidenceId) ||
    project.evidenceSources[0];

  if (!selectedSource) {
    closeEvidenceModal();
    return;
  }

  state.selectedEvidenceId = selectedSource.id;
  elements.evidenceModal.classList.remove("is-hidden");
  elements.evidenceModal.setAttribute("aria-hidden", "false");
  elements.evidenceTitle.textContent = `${project.title} · ${selectedSource.label}`;
  elements.evidenceSummary.textContent =
    `CID / signature / verification context for ${selectedSource.label.toLowerCase()}. ${selectedSource.meta}`;
  elements.evidenceSwitcher.innerHTML = project.evidenceSources
    .map(
      (source) => `
        <button
          class="switch-chip ${source.id === selectedSource.id ? "is-active" : ""}"
          type="button"
          data-action="switch-evidence"
          data-evidence-id="${escapeHtml(source.id)}"
          data-project-key="${escapeHtml(project.key)}"
        >
          ${escapeHtml(source.label)}
        </button>
      `
    )
    .join("");
  renderMarketWindow(selectedSource);
  elements.evidenceJson.innerHTML = syntaxHighlightJson(selectedSource.payload);
}

async function fetchJson(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || `${response.status} ${response.statusText}`);
  }

  return data;
}

async function loadDashboard() {
  const [status, snapshot, listingsPayload] = await Promise.all([
    fetchJson("/api/status"),
    fetchJson("/api/vault?full=1"),
    fetchJson("/api/listings/open")
  ]);

  state.status = status;
  state.snapshot = snapshot;
  state.listings = listingsPayload.listings || [];
  state.projects = buildProjects(snapshot, state.listings);

  renderStatus(status, snapshot, state.projects, state.listings);
  renderProjectBoard(state.projects);
  renderInterventions(state.projects);
  renderActivity(sortMostRecent(snapshot.activity || []).slice(0, 12));
  renderEvidenceModal();
  setFeedback({
    status: {
      timestamp: status.timestamp,
      discovery: status.discovery,
      settlement: status.settlement
    },
    projects: state.projects.length,
    listings: state.listings.length
  });
}

async function loadDemoData() {
  const payload = await fetchJson("/api/demo/seed", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({})
  });

  await loadDashboard();
  setFeedback(payload);
}

function applyResolvedPauseLocally(resolvedPause) {
  if (!resolvedPause || !state.snapshot) {
    return;
  }

  const reputation = state.snapshot.reputation || (state.snapshot.reputation = {});
  const pauses = Array.isArray(reputation.humanPauses)
    ? reputation.humanPauses
    : (reputation.humanPauses = []);
  const matchesResolvedPause = (pause) =>
    pause.listingCid === resolvedPause.listingCid ||
    (
      resolvedPause.demoScenario &&
      pause.demoScenario &&
      pause.demoScenario === resolvedPause.demoScenario
    ) ||
    (
      resolvedPause.title &&
      pause.title &&
      pause.title === resolvedPause.title
    );
  const unresolvedIndex = pauses.findIndex((pause) =>
    matchesResolvedPause(pause) &&
      !pause.decision &&
      !pause.decidedAt
  );
  const latestIndex = unresolvedIndex >= 0
    ? unresolvedIndex
    : pauses.findIndex((pause) => matchesResolvedPause(pause));

  if (latestIndex >= 0) {
    pauses[latestIndex] = {
      ...pauses[latestIndex],
      ...resolvedPause
    };
  } else {
    pauses.push(resolvedPause);
  }

  state.projects = buildProjects(state.snapshot, state.listings);
  renderStatus(state.status, state.snapshot, state.projects, state.listings);
  renderProjectBoard(state.projects);
  renderInterventions(state.projects);
}

async function submitHumanDecision(listingCid, decision, options = {}) {
  const pendingReference = options.demoScenario || listingCid;
  state.pendingDecision = `${pendingReference}:${decision}`;
  renderInterventions(state.projects);

  try {
    const payload = await fetchJson("/api/interventions/human-pauses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        listingCid,
        demoScenario: options.demoScenario || null,
        decision,
        note: `Resolved from Mission Control (${decision}).`
      })
    });
    applyResolvedPauseLocally(payload.pause);
    setFeedback(payload);

    const shouldSkipReload = Boolean(payload.volatile) ||
      Boolean(
        state.status &&
          state.status.storage &&
          typeof state.status.storage.vaultPath === "string" &&
          state.status.storage.vaultPath.startsWith("/tmp/")
      );

    if (!shouldSkipReload) {
      try {
        await loadDashboard();
      } catch (syncError) {
        setFeedback({
          ...payload,
          syncWarning: syncError.message
        });
      }
    }
  } finally {
    state.pendingDecision = null;
    renderInterventions(state.projects);
  }
}

elements.refreshButton.addEventListener("click", async () => {
  try {
    await withBusyButton(elements.refreshButton, loadDashboard);
  } catch (error) {
    setFeedback(error.message, true);
  }
});

elements.fetchListingsButton.addEventListener("click", async () => {
  try {
    await withBusyButton(elements.fetchListingsButton, loadDashboard);
  } catch (error) {
    setFeedback(error.message, true);
  }
});

elements.loadDemoButton.addEventListener("click", async () => {
  try {
    await withBusyButton(elements.loadDemoButton, loadDemoData);
  } catch (error) {
    setFeedback(error.message, true);
  }
});

elements.projectBoard.addEventListener("click", (event) => {
  const button = event.target.closest('[data-action="view-evidence"]');
  if (!button) {
    return;
  }

  openEvidence(button.dataset.projectKey);
});

elements.interventions.addEventListener("click", async (event) => {
  const button = event.target.closest('[data-action="human-decision"]');
  if (!button) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  if (!button.dataset.listingCid || !button.dataset.decision) {
    setFeedback("Missing listingCid or decision for manual intervention.", true);
    return;
  }

  try {
    await submitHumanDecision(button.dataset.listingCid, button.dataset.decision, {
      demoScenario: button.dataset.demoScenario || null
    });
  } catch (error) {
    setFeedback(error.message, true);
  }
});

elements.evidenceSwitcher.addEventListener("click", (event) => {
  const button = event.target.closest('[data-action="switch-evidence"]');
  if (!button) {
    return;
  }

  state.selectedProjectKey = button.dataset.projectKey;
  state.selectedEvidenceId = button.dataset.evidenceId;
  renderEvidenceModal();
});

elements.closeEvidenceButton.addEventListener("click", closeEvidenceModal);
elements.evidenceModal.addEventListener("click", (event) => {
  if (event.target.matches('[data-close-modal="true"]')) {
    closeEvidenceModal();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.evidenceModal.classList.contains("is-hidden")) {
    closeEvidenceModal();
  }
});

loadDashboard().catch((error) => {
  setFeedback(error.message, true);
});

window.setInterval(() => {
  loadDashboard().catch((error) => {
    setFeedback(error.message, true);
  });
}, REFRESH_INTERVAL_MS);
