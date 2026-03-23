const { createInterface } = require("node:readline/promises");
const { stdin: input, stdout: output } = require("node:process");

const {
  Contract,
  JsonRpcProvider,
  Wallet,
  getAddress: normalizeAddress,
  keccak256,
  toUtf8Bytes
} = require("ethers");

const {
  ANPManager,
  computeCID,
  toMicroUsdc
} = require("../engines/anp_engine");
const { ACPManager, ACP_STATUS } = require("../engines/acp_engine");
const {
  canonicalJson,
  isNonEmptyString,
  isPlainObject,
  normalizeForCanonicalJson,
  pickFirstString
} = require("../lib/common");

const DEFAULT_COMPETITIVE_RATIO_PERCENT = 70n;
const DEFAULT_PROFIT_RATIO_PERCENT = 90n;
const DEFAULT_COMPETITIVE_BID_THRESHOLD = 3;
const DEFAULT_HIGH_VALUE_THRESHOLD_MICRO_USDC = 100_000_000n;
const FEEDBACK_DECIMALS = 0;
const FEEDBACK_VALUE_COMPLETED = 100n;
const ERC8004_REGISTRY_ABI = Object.freeze([
  {
    inputs: [
      { internalType: "uint256", name: "agentId", type: "uint256" },
      { internalType: "int128", name: "value", type: "int128" },
      { internalType: "uint8", name: "valueDecimals", type: "uint8" },
      { internalType: "string", name: "tag1", type: "string" },
      { internalType: "string", name: "tag2", type: "string" },
      { internalType: "string", name: "endpoint", type: "string" },
      { internalType: "string", name: "feedbackURI", type: "string" },
      { internalType: "bytes32", name: "feedbackHash", type: "bytes32" }
    ],
    name: "giveFeedback",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [],
    name: "getIdentityRegistry",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  }
]);

function toBigIntOrNull(value) {
  if (value === null || typeof value === "undefined") {
    return null;
  }

  try {
    return BigInt(value);
  } catch (error) {
    return null;
  }
}

function formatMicroUsdc(value) {
  const amount = typeof value === "bigint" ? value : BigInt(value);
  const negative = amount < 0n;
  const normalized = negative ? -amount : amount;
  const whole = normalized / 1_000_000n;
  const fraction = `${normalized % 1_000_000n}`.padStart(6, "0");
  const trimmedFraction = fraction.replace(/0+$/, "");
  const body = trimmedFraction ? `${whole}.${trimmedFraction}` : `${whole}`;
  return negative ? `-${body}` : body;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getListingObjects(listing) {
  return [
    listing,
    listing && listing.data,
    listing && listing.payload,
    listing && listing.intent,
    listing && listing.job,
    listing && listing.listing,
    listing && listing.message
  ].filter(Boolean);
}

function getListingField(listing, fieldNames) {
  const keys = Array.isArray(fieldNames) ? fieldNames : [fieldNames];

  for (const candidate of getListingObjects(listing)) {
    for (const key of keys) {
      if (typeof candidate[key] !== "undefined" && candidate[key] !== null) {
        return candidate[key];
      }
    }
  }

  return null;
}

function getListingBidCount(listing) {
  const numericFields = [
    "bidCount",
    "bidsCount",
    "proposalCount",
    "proposalsCount",
    "applicationCount",
    "applicationsCount",
    "responseCount",
    "responsesCount",
    "offerCount",
    "offersCount"
  ];
  const arrayFields = ["bids", "proposals", "applications", "offers", "responses"];

  for (const field of numericFields) {
    const value = Number(getListingField(listing, field));
    if (Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
  }

  for (const field of arrayFields) {
    const value = getListingField(listing, field);
    if (Array.isArray(value)) {
      return value.length;
    }
  }

  return 0;
}

function getListingBudgetMicroUsdc(listing, field) {
  const value = getListingField(listing, field);
  const parsed = toBigIntOrNull(value);
  if (parsed !== null) {
    return parsed;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(toMicroUsdc(value));
  }

  if (typeof value === "string" && value.includes(".")) {
    return BigInt(toMicroUsdc(value));
  }

  return null;
}

function getListingTitle(listing) {
  return (
    pickFirstString(
      getListingField(listing, ["title", "name", "headline"]),
      getListingField(listing, ["description", "summary"])
    ) || "Untitled opportunity"
  );
}

function getListingCid(listing) {
  return (
    pickFirstString(
      getListingField(listing, [
        "listingCid",
        "cid",
        "id",
        "hash",
        "intentHash",
        "listingHash"
      ])
    ) || `listing-${computeCID(normalizeForCanonicalJson(listing)).slice(7, 19)}`
  );
}

function getListingClientId(listing) {
  return pickFirstString(
    getListingField(listing, [
      "client",
      "clientAddress",
      "owner",
      "ownerAddress",
      "creator",
      "createdBy",
      "requester",
      "requesterAddress",
      "buyer",
      "buyerAddress",
      "poster",
      "postedBy",
      "employer",
      "signer"
    ])
  );
}

function confidenceLabel(score) {
  if (score >= 0.8) {
    return "high";
  }

  if (score >= 0.6) {
    return "medium";
  }

  return "low";
}

class LogicEngine {
  constructor(options = {}) {
    this.anp = options.anpManager || new ANPManager();
    this.acp = options.acpManager || new ACPManager({ anpManager: this.anp });
    this.notifier = options.notifier || null;
    this.config = {
      competitiveRatioPercent: BigInt(
        options.competitiveRatioPercent ||
          process.env.ANP_COMPETITIVE_BID_RATIO_PERCENT ||
          DEFAULT_COMPETITIVE_RATIO_PERCENT
      ),
      profitRatioPercent: BigInt(
        options.profitRatioPercent ||
          process.env.ANP_PROFIT_BID_RATIO_PERCENT ||
          DEFAULT_PROFIT_RATIO_PERCENT
      ),
      competitiveBidThreshold: Number(
        options.competitiveBidThreshold ||
          process.env.ANP_COMPETITIVE_BID_THRESHOLD ||
          DEFAULT_COMPETITIVE_BID_THRESHOLD
      ),
      highValueThresholdMicroUsdc: BigInt(
        options.highValueThresholdMicroUsdc ||
          process.env.ANP_HIGH_VALUE_THRESHOLD_MICRO_USDC ||
          DEFAULT_HIGH_VALUE_THRESHOLD_MICRO_USDC
      ),
      reputationRegistryAddress:
        options.reputationRegistryAddress ||
        process.env.ANP_REPUTATION_REGISTRY_ADDRESS ||
        null,
      agentId: options.agentId || process.env.ANP_AGENT_ID || null,
      agentRegistry:
        options.agentRegistry || process.env.ANP_AGENT_REGISTRY || null,
      agentEndpoint:
        options.agentEndpoint || process.env.ANP_AGENT_ENDPOINT || "",
      feedbackBaseUri:
        options.feedbackBaseUri ||
        process.env.ANP_REPUTATION_FEEDBACK_BASE_URI ||
        "anp://local-feedback",
      reviewerPrivateKey:
        options.reviewerPrivateKey ||
        process.env.ANP_REPUTATION_REVIEWER_PRIVATE_KEY ||
        null
    };
    this.clientHistoryCache = {
      version: null,
      byClient: new Map()
    };
  }

  getListingContext(listing) {
    const minBudgetMicroUsdc = getListingBudgetMicroUsdc(listing, "minBudget");
    const maxBudgetMicroUsdc = getListingBudgetMicroUsdc(listing, "maxBudget");
    const existingBidCount = getListingBidCount(listing);

    return {
      listingCid: getListingCid(listing),
      title: getListingTitle(listing),
      clientId: getListingClientId(listing),
      minBudgetMicroUsdc,
      maxBudgetMicroUsdc,
      existingBidCount
    };
  }

  async calculateConfidence(listing) {
    const { byClient } = await this.getClientHistoryIndex();
    const context = this.getListingContext(listing);
    const clientId = context.clientId;

    if (!clientId) {
      return {
        score: 0.5,
        label: confidenceLabel(0.5),
        clientId: null,
        history: {
          completedJobs: 0,
          failedJobs: 0,
          acceptedNegotiations: 0
        },
        reason: "No client identity available in listing data."
      };
    }

    const history = byClient.get(clientId.toLowerCase()) || {
      completedJobs: 0,
      failedJobs: 0,
      acceptedNegotiations: 0
    };
    const { completedJobs, failedJobs, acceptedNegotiations } = history;

    let score;
    let reason;
    if (completedJobs + failedJobs > 0) {
      score = (completedJobs + 1) / (completedJobs + failedJobs + 2);
      reason = "Confidence derived from concluded ACP job history for this client.";
    } else if (acceptedNegotiations > 0) {
      score = Math.min(0.85, 0.55 + acceptedNegotiations * 0.1);
      reason = "Confidence estimated from prior accepted negotiations for this client.";
    } else {
      score = 0.5;
      reason = "No historical client record was found in the negotiation vault.";
    }

    const normalizedScore = Number(clamp(score, 0.1, 0.95).toFixed(2));
    return {
      score: normalizedScore,
      label: confidenceLabel(normalizedScore),
      clientId,
      history: {
        completedJobs,
        failedJobs,
        acceptedNegotiations
      },
      reason
    };
  }

  async getClientHistoryIndex() {
    const state = await this.anp.vault.load();
    const version = `${state.updatedAt}:${Object.keys(state.documents).length}:${Object.keys(
      state.acp.jobs
    ).length}`;

    if (this.clientHistoryCache.version === version) {
      return this.clientHistoryCache;
    }

    const byClient = new Map();
    const getOrCreateHistory = (clientId) => {
      const key = String(clientId).toLowerCase();
      if (!byClient.has(key)) {
        byClient.set(key, {
          completedJobs: 0,
          failedJobs: 0,
          acceptedNegotiations: 0
        });
      }

      return byClient.get(key);
    };

    for (const jobRecord of Object.values(state.acp.jobs)) {
      const job = isPlainObject(jobRecord.job) ? jobRecord.job : jobRecord;
      const jobClient = pickFirstString(job.client, job.clientAddress, jobRecord.client);

      if (!jobClient) {
        continue;
      }

      const history = getOrCreateHistory(jobClient);
      const statusLabel = String(job.statusLabel || jobRecord.statusLabel || "").toLowerCase();
      if (statusLabel === "completed") {
        history.completedJobs += 1;
      } else if (statusLabel === "rejected" || statusLabel === "expired") {
        history.failedJobs += 1;
      }
    }

    for (const cid of state.indexes.acceptance || []) {
      const entry = state.documents[cid];
      const signer = entry && entry.document ? entry.document.signer : null;

      if (!signer) {
        continue;
      }

      const history = getOrCreateHistory(signer);
      history.acceptedNegotiations += 1;
    }

    this.clientHistoryCache = {
      version,
      byClient
    };

    return this.clientHistoryCache;
  }

  calculateOptimalBid(listing) {
    const context = this.getListingContext(listing);
    const maxBudgetMicroUsdc =
      context.maxBudgetMicroUsdc || context.minBudgetMicroUsdc;

    if (maxBudgetMicroUsdc === null) {
      throw new Error(
        `Listing ${context.listingCid} does not expose minBudget/maxBudget.`
      );
    }

    const competitive =
      context.existingBidCount >= this.config.competitiveBidThreshold;
    const ratioPercent = competitive
      ? this.config.competitiveRatioPercent
      : this.config.profitRatioPercent;
    let bidMicroUsdc = (maxBudgetMicroUsdc * ratioPercent) / 100n;

    if (
      context.minBudgetMicroUsdc !== null &&
      bidMicroUsdc < context.minBudgetMicroUsdc
    ) {
      bidMicroUsdc = context.minBudgetMicroUsdc;
    }

    if (bidMicroUsdc > maxBudgetMicroUsdc) {
      bidMicroUsdc = maxBudgetMicroUsdc;
    }

    return {
      listingCid: context.listingCid,
      title: context.title,
      existingBidCount: context.existingBidCount,
      priceMicroUsdc: bidMicroUsdc.toString(),
      priceUsdc: formatMicroUsdc(bidMicroUsdc),
      minBudgetUsdc:
        context.minBudgetMicroUsdc === null
          ? null
          : formatMicroUsdc(context.minBudgetMicroUsdc),
      maxBudgetUsdc: formatMicroUsdc(maxBudgetMicroUsdc),
      ratioPercent: Number(ratioPercent),
      mode: competitive ? "competitive" : "profit-maximizing",
      reason: competitive
        ? "High market competition detected, bid reduced to 70% of maxBudget."
        : "Default profit-maximizing bid set to 90% of maxBudget."
    };
  }

  requiresHumanPause(listing) {
    const { maxBudgetMicroUsdc } = this.getListingContext(listing);
    return Boolean(
      maxBudgetMicroUsdc !== null &&
        maxBudgetMicroUsdc > this.config.highValueThresholdMicroUsdc
    );
  }

  async requestHumanPause(listing, context = {}) {
    const listingContext = this.getListingContext(listing);
    const pauseRecord = {
      listingCid: listingContext.listingCid,
      title: listingContext.title,
      clientId: listingContext.clientId,
      proposedBidUsdc: context.priceUsdc || null,
      confidence: context.confidence ? context.confidence.score : null,
      reason:
        context.reason ||
        "High-value listing exceeded the auto-bid threshold and requires explicit approval."
    };
    const recentPause = await this.anp.vault.getMostRecentHumanPauseForListing(
      listingContext.listingCid
    );
    if (
      recentPause &&
      Date.now() - Date.parse(recentPause.recordedAt || 0) < 6 * 60 * 60 * 1000
    ) {
      return {
        approved: recentPause.approved === true,
        interactive: false,
        deduped: true
      };
    }

    if (typeof this.notifier === "function") {
      await this.notifier({
        type: "human-pause",
        ...pauseRecord
      });
    }

    console.log(
      `[PAUSE] High-value opportunity detected: ${listingContext.title} (${listingContext.listingCid})`
    );

    if (!input.isTTY || !output.isTTY) {
      console.log(
        "[PAUSE] Non-interactive runtime detected; bid will not be auto-published until approval is provided."
      );
      const result = {
        approved: false,
        interactive: false
      };
      await this.anp.vault.recordHumanPause({
        ...pauseRecord,
        ...result
      });
      return result;
    }

    const rl = createInterface({ input, output });
    try {
      const answer = await rl.question(
        `High-value job "${listingContext.title}" found. Send bid for ${context.priceUsdc} USDC? (Y/N) `
      );

      const result = {
        approved: /^y(?:es)?$/i.test(answer.trim()),
        interactive: true
      };
      await this.anp.vault.recordHumanPause({
        ...pauseRecord,
        ...result
      });
      return result;
    } finally {
      rl.close();
    }
  }

  async buildBidDecision(listing, options = {}) {
    const strategy = this.calculateOptimalBid(listing);
    const confidence = await this.calculateConfidence(listing);
    const deliverySeconds = String(
      options.deliverySeconds ||
        this.anp.getSuggestedDeliverySeconds(listing)
    );
    const requiresHumanPause = this.requiresHumanPause(listing);
    let humanPause = {
      requested: requiresHumanPause,
      approved: true
    };

    if (requiresHumanPause) {
      humanPause = {
        requested: true,
        ...(await this.requestHumanPause(listing, {
          priceUsdc: strategy.priceUsdc,
          confidence,
          reason: "Budget above 100 USDC threshold."
        }))
      };
    }

    return {
      listingCid: strategy.listingCid,
      title: strategy.title,
      clientId: confidence.clientId,
      deliverySeconds,
      priceUsdc: strategy.priceUsdc,
      priceMicroUsdc: strategy.priceMicroUsdc,
      confidence,
      strategy,
      requiresHumanPause,
      humanPause,
      shouldBid: !requiresHumanPause || humanPause.approved === true
    };
  }

  buildBidMessage(listing, context = {}) {
    const decision = context.decision || null;

    return {
      listingCid: context.listingCid || getListingCid(listing),
      title: context.title || getListingTitle(listing),
      proposedPriceUsdc: String(
        context.priceUsdc ||
          (decision ? decision.priceUsdc : this.calculateOptimalBid(listing).priceUsdc)
      ),
      proposedDeliverySeconds: String(
        context.deliverySeconds ||
          (decision ? decision.deliverySeconds : this.anp.getSuggestedDeliverySeconds(listing))
      ),
      confidence: decision ? decision.confidence : null,
      negotiation: decision
        ? {
            mode: decision.strategy.mode,
            ratioPercent: decision.strategy.ratioPercent,
            existingBidCount: decision.strategy.existingBidCount,
            rationale: decision.strategy.reason
          }
        : null,
      summary:
        "Sovereign ANP node bid optimized for profit, competition, and client reliability.",
      source: "anp-logic-engine"
    };
  }

  getReputationProvider() {
    if (!this.acp.rpcUrl) {
      throw new Error(
        "No Base RPC URL configured. Set ANP_BASE_RPC_URL to use ERC-8004 reputation publishing."
      );
    }

    return new JsonRpcProvider(this.acp.rpcUrl, this.acp.chainId);
  }

  getReputationRegistry(runner = null) {
    if (!this.config.reputationRegistryAddress) {
      throw new Error(
        "No ERC-8004 reputation registry configured. Set ANP_REPUTATION_REGISTRY_ADDRESS."
      );
    }

    return new Contract(
      this.config.reputationRegistryAddress,
      ERC8004_REGISTRY_ABI,
      runner || this.getReputationProvider()
    );
  }

  async resolveAgentRegistry() {
    if (this.config.agentRegistry) {
      return this.config.agentRegistry;
    }

    try {
      const registry = this.getReputationRegistry();
      const identityRegistryAddress = await registry.getIdentityRegistry();
      return `eip155:${this.acp.chainId}:${identityRegistryAddress}`;
    } catch (error) {
      return null;
    }
  }

  async createReputationAttestation({ prepared, jobId, job }) {
    const agentRegistry = await this.resolveAgentRegistry();
    const attestationPayload = {
      standard: "erc-8004-feedback",
      version: "1",
      agentRegistry,
      agentId: this.config.agentId,
      clientAddress: prepared.params.client,
      value: FEEDBACK_VALUE_COMPLETED.toString(),
      valueDecimals: FEEDBACK_DECIMALS,
      tag1: "starred",
      tag2: "anp-acp-completed-job",
      endpoint: this.config.agentEndpoint,
      feedbackURI: `${this.config.feedbackBaseUri}/${prepared.acceptCid}`,
      references: {
        acceptCid: prepared.acceptCid,
        bidCid: prepared.params.bidCid,
        listingCid: prepared.params.listingCid,
        jobId: String(jobId)
      },
      participants: {
        client: prepared.params.client,
        provider: prepared.params.provider,
        evaluator: prepared.params.evaluator
      },
      job: {
        description: job.description,
        budget: job.budget,
        expiredAt: job.expiredAt,
        status: job.statusLabel
      },
      createdAt: new Date().toISOString()
    };
    const feedbackHash = keccak256(toUtf8Bytes(canonicalJson(attestationPayload)));
    const attestationKey = [
      "erc8004",
      prepared.acceptCid,
      String(jobId),
      String(this.config.agentId || "unconfigured")
    ].join(":");

    return {
      attestationKey,
      cid: computeCID(attestationPayload),
      protocol: "erc-8004/v1",
      kind: "reputation-attestation",
      jobId: String(jobId),
      acceptCid: prepared.acceptCid,
      target: {
        agentId: this.config.agentId,
        agentRegistry
      },
      feedback: {
        value: FEEDBACK_VALUE_COMPLETED.toString(),
        valueDecimals: FEEDBACK_DECIMALS,
        tag1: "starred",
        tag2: "anp-acp-completed-job",
        endpoint: this.config.agentEndpoint,
        feedbackURI: attestationPayload.feedbackURI,
        feedbackHash
      },
      payload: attestationPayload,
      onchain: {
        published: false,
        status: "pending"
      }
    };
  }

  async publishReputationAttestation(attestation) {
    if (!this.config.agentId || !this.config.reputationRegistryAddress) {
      return {
        published: false,
        status: "not-configured",
        reason:
          "ANP_AGENT_ID and ANP_REPUTATION_REGISTRY_ADDRESS are required for ERC-8004 publishing."
      };
    }

    if (!this.config.reviewerPrivateKey) {
      return {
        published: false,
        status: "pending-external-reviewer",
        reason:
          "ERC-8004 feedback should come from a client/reviewer identity, so automatic self-publication is disabled without a separate reviewer key."
      };
    }

    const provider = this.getReputationProvider();
    const publisher = new Wallet(this.config.reviewerPrivateKey, provider);
    const operatorAddress = normalizeAddress(await this.anp.getAddress());
    const publisherAddress = normalizeAddress(await publisher.getAddress());

    if (publisherAddress === operatorAddress) {
      return {
        published: false,
        status: "rejected-self-feedback",
        reason:
          "Refusing to publish ERC-8004 feedback from the agent operator wallet."
      };
    }

    const registry = this.getReputationRegistry(publisher);
    const tx = await registry.giveFeedback(
      BigInt(this.config.agentId),
      BigInt(attestation.feedback.value),
      Number(attestation.feedback.valueDecimals),
      attestation.feedback.tag1,
      attestation.feedback.tag2,
      attestation.feedback.endpoint || "",
      attestation.feedback.feedbackURI || "",
      attestation.feedback.feedbackHash
    );
    const receipt = await tx.wait();

    return {
      published: true,
      status: "published",
      txHash: receipt.hash,
      publisher: publisherAddress
    };
  }

  async attestSuccessfulJob({ prepared, jobId, job }) {
    if (prepared.role !== "provider") {
      return {
        generated: false,
        published: false,
        reason: "Reputation attestation is only generated for our provider-side completed jobs."
      };
    }

    const attestation = await this.createReputationAttestation({
      prepared,
      jobId,
      job
    });
    const existing = await this.anp.vault.getReputationAttestationByKey(
      attestation.attestationKey
    );

    if (existing) {
      if (existing.onchain && !existing.onchain.published) {
        let onchainResult;
        try {
          onchainResult = await this.publishReputationAttestation(existing);
        } catch (error) {
          onchainResult = {
            published: false,
            status: "publish-error",
            reason: error.message
          };
        }

        const updatedRecord = await this.anp.vault.recordReputationAttestation({
          ...existing,
          onchain: onchainResult
        });

        return {
          generated: false,
          published: Boolean(onchainResult && onchainResult.published),
          record: updatedRecord
        };
      }

      return {
        generated: false,
        published: Boolean(existing.onchain && existing.onchain.published),
        record: existing
      };
    }

    let onchainResult;
    try {
      onchainResult = await this.publishReputationAttestation(attestation);
    } catch (error) {
      onchainResult = {
        published: false,
        status: "publish-error",
        reason: error.message
      };
    }

    const record = await this.anp.vault.recordReputationAttestation({
      ...attestation,
      onchain: onchainResult
    });

    return {
      generated: true,
      published: Boolean(onchainResult && onchainResult.published),
      record
    };
  }
}

module.exports = {
  LogicEngine,
  formatMicroUsdc,
  getListingBidCount,
  getListingCid,
  getListingClientId,
  getListingTitle
};
