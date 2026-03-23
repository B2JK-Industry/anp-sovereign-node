const path = require("node:path");

const { ACPManager, ACP_STATUS } = require("../engines/acp_engine");
const { ANPManager } = require("../engines/anp_engine");
const {
  isPlainObject,
  parseBoolean,
  sleep,
  toNumber
} = require("../lib/common");
const { LogicEngine } = require("./logic_engine");

const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const DEFAULT_WALLET_PATH = path.join(PROJECT_ROOT, "sovereign_wallet.json");
const DEFAULT_VAULT_PATH = path.join(PROJECT_ROOT, "negotiation_vault.json");
const DEFAULT_IDLE_SLEEP_MS = 5 * 60 * 1000;
const DEFAULT_BUSY_SLEEP_MS = 60 * 1000;
const DEFAULT_ERROR_SLEEP_MS = 2 * 60 * 1000;
const DEFAULT_MAX_IDLE_SLEEP_MS = 15 * 60 * 1000;
const TERMINAL_ACCEPTANCE_STATUSES = new Set([
  "ignored",
  "completed-published",
  "completed-no-attestation",
  "completed-local-attestation"
]);

function looksLikeAnpDocument(value) {
  return Boolean(
    isPlainObject(value) &&
      typeof value.protocol === "string" &&
      typeof value.type === "string" &&
      typeof value.signer === "string" &&
      typeof value.signature === "string" &&
      isPlainObject(value.data)
  );
}

function unwrapAcceptanceDocument(value) {
  if (looksLikeAnpDocument(value)) {
    return value;
  }

  const candidates = [
    value && value.document,
    value && value.payload,
    value && value.message,
    value && value.item,
    value && value.data && value.data.document
  ];

  for (const candidate of candidates) {
    if (looksLikeAnpDocument(candidate)) {
      return candidate;
    }
  }

  return null;
}

function nowIso() {
  return new Date().toISOString();
}

class Hunter {
  constructor(options = {}) {
    this.anp =
      options.anpManager ||
      new ANPManager({
        walletPath: options.walletPath || DEFAULT_WALLET_PATH,
        vaultPath: options.vaultPath || DEFAULT_VAULT_PATH,
        discovery: {
          adapter: options.discoveryAdapter || process.env.ANP_MARKETPLACE_ADAPTER || null,
          endpoint: options.discoveryEndpoint || process.env.ANP_DISCOVERY_URL || null
        }
      });
    this.acp =
      options.acpManager ||
      new ACPManager({
        anpManager: this.anp,
        walletPath: options.walletPath || DEFAULT_WALLET_PATH,
        vaultPath: options.vaultPath || DEFAULT_VAULT_PATH,
        rpcUrl: options.rpcUrl || process.env.ANP_BASE_RPC_URL || null
      });
    this.logic =
      options.logicEngine ||
      new LogicEngine({
        anpManager: this.anp,
        acpManager: this.acp,
        notifier: options.notifier,
        reputationRegistryAddress: options.reputationRegistryAddress,
        agentId: options.agentId,
        agentRegistry: options.agentRegistry,
        agentEndpoint: options.agentEndpoint,
        feedbackBaseUri: options.feedbackBaseUri,
        reviewerPrivateKey: options.reviewerPrivateKey
      });

    this.options = {
      sendBidOnMatch: parseBoolean(
        options.sendBidOnMatch,
        parseBoolean(process.env.ANP_AUTO_BID, true)
      ),
      requireHumanConsent: parseBoolean(
        options.requireHumanConsent,
        parseBoolean(process.env.ANP_REQUIRE_CONSENT, false)
      ),
      autoCreateJobOnClient: parseBoolean(
        options.autoCreateJobOnClient,
        parseBoolean(process.env.ANP_AUTO_CREATE_JOB, true)
      ),
      autoFundClientJob: parseBoolean(
        options.autoFundClientJob,
        parseBoolean(process.env.ANP_AUTO_FUND_CLIENT, false)
      ),
      autoSetBudgetAsProvider: parseBoolean(
        options.autoSetBudgetAsProvider,
        parseBoolean(process.env.ANP_AUTO_SET_BUDGET_PROVIDER, true)
      ),
      autoSubmitProviderWork: parseBoolean(
        options.autoSubmitProviderWork,
        parseBoolean(process.env.ANP_AUTO_SUBMIT_WORK, false)
      ),
      sendPausedBidNotifications: parseBoolean(
        options.sendPausedBidNotifications,
        true
      ),
      watchOnChainEvents: parseBoolean(
        options.watchOnChainEvents,
        parseBoolean(process.env.ANP_WATCH_ACP_EVENTS, true)
      ),
      priceUsdc: options.priceUsdc || process.env.ANP_BID_PRICE_USDC || undefined,
      deliverySeconds:
        options.deliverySeconds || process.env.ANP_BID_DELIVERY_SECONDS || undefined,
      deliverableResolver:
        options.deliverableResolver ||
        (async () => process.env.ANP_DELIVERABLE_REF || null),
      idleSleepMs: toNumber(options.idleSleepMs, DEFAULT_IDLE_SLEEP_MS),
      busySleepMs: toNumber(options.busySleepMs, DEFAULT_BUSY_SLEEP_MS),
      errorSleepMs: toNumber(options.errorSleepMs, DEFAULT_ERROR_SLEEP_MS),
      maxIdleSleepMs: toNumber(options.maxIdleSleepMs, DEFAULT_MAX_IDLE_SLEEP_MS)
    };

    this.started = false;
    this.running = false;
    this.stopRequested = false;
    this.idleCycles = 0;
  }

  async start() {
    if (this.started) {
      return {
        alreadyStarted: true,
        address: await this.anp.getAddress()
      };
    }

    await this.anp.loadVault();
    const wallet = await this.anp.ensureWallet();
    console.log(`[START] Sovereign wallet ready: ${wallet.address}`);

    let balances = null;
    try {
      balances = await this.acp.getBalances();
      console.log(
        `[START] Base balance: ${balances.nativeFormatted} ETH, ${balances.usdcFormatted} USDC`
      );
    } catch (error) {
      console.log(`[START] Base balance check skipped: ${error.message}`);
    }

    if (this.options.watchOnChainEvents) {
      try {
        const watcher = await this.acp.watchJobLifecycle({
          onEvent: async (event) => {
            console.log(
              `[ACP] Observed ${event.eventName} for job ${event.jobId || "unknown"}`
            );
          }
        });
        console.log(
          `[START] ACP event listener active for ${watcher.address}`
        );
      } catch (error) {
        console.log(`[START] ACP event listener unavailable: ${error.message}`);
      }
    }

    this.started = true;
    return {
      address: wallet.address,
      balances
    };
  }

  stop() {
    this.stopRequested = true;
    this.running = false;
    this.acp.stopWatchingJobLifecycle();
  }

  async runCycle() {
    const summary = {
      startedAt: nowIso(),
      listingsSeen: 0,
      listingMatches: 0,
      bidsPublished: 0,
      humanPauses: 0,
      acceptancesSeen: 0,
      acceptancesProcessed: 0,
      settlementsPrepared: 0,
      jobsCreated: 0,
      budgetsSet: 0,
      jobsFunded: 0,
      workSubmitted: 0,
      attestationsGenerated: 0,
      attestationsPublished: 0,
      ignoredAcceptances: 0,
      errors: []
    };

    if (this.anp.discovery.hasActiveAdapter()) {
      try {
        const scanResult = await this.scanListingsWithLogic();
        summary.listingsSeen = scanResult.listings.length;
        summary.listingMatches = scanResult.matches.length;
        summary.humanPauses = scanResult.humanPauses;
        summary.errors.push(
          ...scanResult.errors.map((entry) => `scan:${entry.listingCid}:${entry.error}`)
        );
        summary.bidsPublished = scanResult.matches.filter(
          (match) => match.status === "published"
        ).length;
      } catch (error) {
        summary.errors.push(`scan:${error.message}`);
        console.error(`[HUNTER] Discovery scan failed: ${error.message}`);
      }
    } else {
      console.log(
        "[HUNTER] Discovery not configured. Set ANP_MARKETPLACE_ADAPTER and ANP_DISCOVERY_URL to scan marketplaces."
      );
    }

    try {
      const acceptanceSummary = await this.processAcceptanceQueue();
      summary.acceptancesSeen = acceptanceSummary.acceptancesSeen;
      summary.acceptancesProcessed = acceptanceSummary.acceptancesProcessed;
      summary.settlementsPrepared = acceptanceSummary.settlementsPrepared;
      summary.jobsCreated = acceptanceSummary.jobsCreated;
      summary.budgetsSet = acceptanceSummary.budgetsSet;
      summary.jobsFunded = acceptanceSummary.jobsFunded;
      summary.workSubmitted = acceptanceSummary.workSubmitted;
      summary.attestationsGenerated = acceptanceSummary.attestationsGenerated;
      summary.attestationsPublished = acceptanceSummary.attestationsPublished;
      summary.ignoredAcceptances = acceptanceSummary.ignoredAcceptances;
    } catch (error) {
      summary.errors.push(`acceptance:${error.message}`);
      console.error(`[HUNTER] Acceptance processing failed: ${error.message}`);
    }

    summary.finishedAt = nowIso();
    return summary;
  }

  async runForever() {
    await this.start();
    this.running = true;
    this.stopRequested = false;

    while (!this.stopRequested) {
      const summary = await this.runCycle();
      const sleepMs = this.getSleepDuration(summary);
      console.log(
        `[HUNTER] Cycle complete. bids=${summary.bidsPublished}, acceptances=${summary.acceptancesProcessed}, sleep=${sleepMs}ms`
      );

      if (this.stopRequested) {
        break;
      }

      await sleep(sleepMs);
    }

    this.running = false;
  }

  getSleepDuration(summary) {
    const hadErrors = summary.errors.length > 0;
    const hadActivity =
      summary.bidsPublished > 0 ||
      summary.acceptancesProcessed > 0 ||
      summary.jobsCreated > 0 ||
      summary.jobsFunded > 0 ||
      summary.workSubmitted > 0 ||
      summary.attestationsGenerated > 0 ||
      summary.attestationsPublished > 0;

    let baseSleepMs;
    if (hadErrors) {
      this.idleCycles = 0;
      baseSleepMs = this.options.errorSleepMs;
    } else if (hadActivity) {
      this.idleCycles = 0;
      baseSleepMs = this.options.busySleepMs;
    } else {
      this.idleCycles += 1;
      baseSleepMs = Math.min(
        this.options.maxIdleSleepMs,
        this.options.idleSleepMs * Math.max(1, this.idleCycles)
      );
    }

    const jitterFactor = 0.9 + Math.random() * 0.2;
    return Math.max(5_000, Math.round(baseSleepMs * jitterFactor));
  }

  async scanListingsWithLogic(options = {}) {
    const sendBidOnMatch = firstDefinedBoolean(
      options.sendBidOnMatch,
      this.options.sendBidOnMatch
    );
    const deliverySeconds = options.deliverySeconds || this.options.deliverySeconds;
    const summary = {
      listingsSeen: 0,
      humanPauses: 0,
      errors: [],
      matches: []
    };
    await this.anp.loadVault();
    const listings = await this.anp.fetchOpenListings();
    summary.listingsSeen = listings.length;

    for (const listing of listings) {
      const listingContext = this.logic.getListingContext(listing);

      if (await this.anp.vault.hasBidForListingCid(listingContext.listingCid)) {
        continue;
      }

      if (!this.anp.isGoodMatch(listing)) {
        continue;
      }

      try {
        const decision = await this.logic.buildBidDecision(listing, {
          deliverySeconds:
            deliverySeconds || this.anp.getSuggestedDeliverySeconds(listing)
        });

        if (decision.requiresHumanPause) {
          summary.humanPauses += 1;
        }

        if (!sendBidOnMatch || !decision.shouldBid) {
          summary.matches.push({
            status: decision.shouldBid ? "match" : "paused",
            listingCid: decision.listingCid,
            title: decision.title,
            priceUsdc: decision.priceUsdc,
            confidence: decision.confidence.score,
            strategy: decision.strategy,
            humanPause: decision.humanPause
          });
          continue;
        }

        const listingHash = this.anp.resolveListingHash(listing);
        if (!listingHash) {
          throw new Error(`Could not resolve listingHash for ${decision.listingCid}`);
        }

        const bidDocument = await this.anp.createBid(
          decision.listingCid,
          listingHash,
          decision.priceUsdc,
          decision.deliverySeconds,
          this.logic.buildBidMessage(listing, {
            listingCid: decision.listingCid,
            title: decision.title,
            priceUsdc: decision.priceUsdc,
            deliverySeconds: decision.deliverySeconds,
            decision
          }),
          {
            metadata: {
              clientId: decision.clientId,
              confidence: decision.confidence,
              strategy: decision.strategy,
              humanPause: decision.humanPause
            }
          }
        );
        const publishResult = await this.anp.publishDocument(bidDocument);

        summary.matches.push({
          status: "published",
          listingCid: decision.listingCid,
          title: decision.title,
          priceUsdc: decision.priceUsdc,
          confidence: decision.confidence.score,
          bidCid: publishResult.cid,
          strategy: decision.strategy,
          humanPause: decision.humanPause
        });
      } catch (error) {
        summary.errors.push({
          listingCid: listingContext.listingCid,
          error: error.message
        });
        console.error(
          `[HUNTER] Listing ${listingContext.listingCid} negotiation failed: ${error.message}`
        );
      }
    }

    console.log(`[HUNTER] Scan complete: ${listings.length} listings seen, ${summary.matches.length} matched`);
    return {
      listings,
      matches: summary.matches,
      humanPauses: summary.humanPauses,
      errors: summary.errors
    };
  }

  async processAcceptanceQueue() {
    const summary = {
      acceptancesSeen: 0,
      acceptancesProcessed: 0,
      settlementsPrepared: 0,
      jobsCreated: 0,
      budgetsSet: 0,
      jobsFunded: 0,
      workSubmitted: 0,
      attestationsGenerated: 0,
      attestationsPublished: 0,
      ignoredAcceptances: 0
    };
    const queue = await this.collectAcceptanceDocuments();
    summary.acceptancesSeen = queue.length;

    for (const document of queue) {
      const result = await this.processAcceptanceDocument(document);

      if (result.ignored) {
        summary.ignoredAcceptances += 1;
      }

      if (result.processed) {
        summary.acceptancesProcessed += 1;
      }

      if (result.settlementPrepared) {
        summary.settlementsPrepared += 1;
      }

      if (result.jobCreated) {
        summary.jobsCreated += 1;
      }

      if (result.budgetSet) {
        summary.budgetsSet += 1;
      }

      if (result.jobFunded) {
        summary.jobsFunded += 1;
      }

      if (result.workSubmitted) {
        summary.workSubmitted += 1;
      }

      if (result.attestationGenerated) {
        summary.attestationsGenerated += 1;
      }

      if (result.attestationPublished) {
        summary.attestationsPublished += 1;
      }
    }

    return summary;
  }

  async collectAcceptanceDocuments() {
    const documents = new Map();
    const localDocuments = await this.getLocalAcceptanceDocuments();

    for (const document of localDocuments) {
      const cid = this.anp.computeCID(document);
      documents.set(cid, document);
    }

    if (this.anp.discovery.hasActiveAdapter()) {
      try {
        const remoteDocuments = await this.fetchRemoteAcceptanceDocuments();
        for (const document of remoteDocuments) {
          const cid = this.anp.computeCID(document);
          documents.set(cid, document);
        }
      } catch (error) {
        console.error(`[HUNTER] Remote acceptance poll failed: ${error.message}`);
      }
    }

    return [...documents.values()];
  }

  async getLocalAcceptanceDocuments() {
    const state = await this.anp.vault.load();
    const documents = [];

    for (const cid of state.indexes.acceptance || []) {
      const entry = state.documents[cid];
      if (entry && looksLikeAnpDocument(entry.document)) {
        documents.push(entry.document);
      }
    }

    return documents;
  }

  async fetchRemoteAcceptanceDocuments() {
    const address = await this.anp.getAddress();
    const adapter = this.anp.getActiveAdapter();
    const result = await adapter.fetchAcceptancesForSigner(address);
    const documents = [];

    for (const item of result.documents || []) {
      const document = unwrapAcceptanceDocument(item);
      if (document) {
        documents.push(document);
      }
    }

    if (documents.length > 0) {
      console.log(
        `[HUNTER] Acceptance poll via ${adapter.name}: ${documents.length} candidate documents`
      );
    }

    return documents;
  }

  async processAcceptanceDocument(document) {
    const acceptCid = this.anp.computeCID(document);
    const stateBefore = await this.anp.vault.getDocument(acceptCid);
    const previousAutomation = stateBefore && stateBefore.metadata
      ? stateBefore.metadata.automation || {}
      : {};
    const isDemoAcceptance = Boolean(
      stateBefore &&
      stateBefore.metadata &&
      stateBefore.metadata.demoSeedId
    );

    if (isDemoAcceptance && previousAutomation.status) {
      return {
        acceptCid,
        processed: false,
        ignored: true
      };
    }

    if (TERMINAL_ACCEPTANCE_STATUSES.has(previousAutomation.status)) {
      return {
        acceptCid,
        processed: false,
        ignored: true
      };
    }

    await this.anp.vault.storeSignedDocument(document, {
      source: "acceptance-observed",
      automation: {
        ...previousAutomation,
        lastSeenAt: nowIso()
      }
    });

    let prepared;
    try {
      prepared = await this.acp.prepareSettlement(acceptCid);
    } catch (error) {
      await this.noteAcceptanceState(document, {
        status: "error",
        lastError: error.message,
        lastAttemptAt: nowIso()
      });
      console.error(
        `[HUNTER] Acceptance ${acceptCid} could not be prepared: ${error.message}`
      );
      return {
        acceptCid,
        processed: false,
        ignored: true
      };
    }

    if (!prepared.integrityVerified || prepared.role === "observer") {
      await this.noteAcceptanceState(document, {
        status: "ignored",
        lastAttemptAt: nowIso(),
        role: prepared.role
      });
      return {
        acceptCid,
        processed: false,
        ignored: true
      };
    }

    await this.noteAcceptanceState(document, {
      status: "prepared",
      lastAttemptAt: nowIso(),
      role: prepared.role,
      settlement: prepared.params
    });

    let result;
    if (prepared.role === "client") {
      result = await this.processClientSettlement(document, prepared);
    } else if (prepared.role === "provider") {
      result = await this.processProviderSettlement(document, prepared);
    } else {
      await this.noteAcceptanceState(document, {
        status: "ignored",
        lastAttemptAt: nowIso(),
        role: prepared.role
      });
      return {
        acceptCid,
        processed: false,
        ignored: true
      };
    }

    const attestation = await this.processCompletedJobAttestation(document, prepared);
    return {
      ...result,
      attestationGenerated: Boolean(attestation.generated),
      attestationPublished: Boolean(attestation.published)
    };
  }

  async processClientSettlement(document, prepared) {
    const acceptCid = prepared.acceptCid;
    let linkedJob = await this.acp.findJobForSettlement(prepared);
    let jobCreated = false;
    let jobFunded = false;

    if (!linkedJob && this.options.autoCreateJobOnClient) {
      const creation = await this.acp.createJobFromAcceptIntent(acceptCid);
      linkedJob = {
        jobId: creation.jobId,
        job: creation.job,
        source: "created"
      };
      jobCreated = true;
      console.log(`[SEAL] Created ACP job ${creation.jobId} for ${acceptCid}`);
    }

    if (!linkedJob) {
      await this.noteAcceptanceState(document, {
        status: "awaiting-job",
        lastAttemptAt: nowIso(),
        role: prepared.role
      });
      return {
        acceptCid,
        processed: true,
        settlementPrepared: true,
        jobCreated: false
      };
    }

    let currentJob = linkedJob.job || (await this.acp.getJob(linkedJob.jobId));
    const budget = BigInt(currentJob.budget || "0");

    if (this.options.autoFundClientJob) {
      if (budget === 0n) {
        await this.noteAcceptanceState(document, {
          status: "awaiting-budget",
          lastAttemptAt: nowIso(),
          role: prepared.role,
          settlementJobId: linkedJob.jobId
        });
        return {
          acceptCid,
          processed: true,
          settlementPrepared: true,
          jobCreated,
          jobFunded: false
        };
      } else if (Number(currentJob.status) < ACP_STATUS.Funded) {
        const funding = await this.acp.fundJob(linkedJob.jobId, prepared.params.budget);
        currentJob = funding.job;
        jobFunded = true;
        console.log(`[EXECUTE] Funded ACP job ${linkedJob.jobId} for ${acceptCid}`);
      }
    }

    await this.noteAcceptanceState(document, {
      status:
        Number(currentJob.status) >= ACP_STATUS.Funded
          ? "job-funded"
          : "job-created",
      lastAttemptAt: nowIso(),
      role: prepared.role,
      settlementJobId: linkedJob.jobId,
      settlementJobStatus: currentJob.statusLabel
    });

    return {
      acceptCid,
      processed: true,
      settlementPrepared: true,
      jobCreated,
      jobFunded
    };
  }

  async processProviderSettlement(document, prepared) {
    const acceptCid = prepared.acceptCid;
    const linkedJob = await this.acp.findJobForSettlement(prepared);

    if (!linkedJob) {
      await this.noteAcceptanceState(document, {
        status: "awaiting-job",
        lastAttemptAt: nowIso(),
        role: prepared.role
      });
      return {
        acceptCid,
        processed: true,
        settlementPrepared: true
      };
    }

    let currentJob = linkedJob.job || (await this.acp.getJob(linkedJob.jobId));
    let budgetSet = false;
    let workSubmitted = false;

    if (
      this.options.autoSetBudgetAsProvider &&
      BigInt(currentJob.budget || "0") !== BigInt(prepared.params.budget)
    ) {
      const budgetResult = await this.acp.setBudgetFromAcceptIntent(
        linkedJob.jobId,
        acceptCid
      );
      currentJob = budgetResult.job;
      budgetSet = true;
      console.log(`[SEAL] Set provider budget on ACP job ${linkedJob.jobId}`);
    }

    const deliverable = await this.options.deliverableResolver(prepared, linkedJob);
    if (Number(currentJob.status) < ACP_STATUS.Funded) {
      await this.noteAcceptanceState(document, {
        status: "awaiting-funding",
        lastAttemptAt: nowIso(),
        role: prepared.role,
        settlementJobId: linkedJob.jobId,
        settlementJobStatus: currentJob.statusLabel
      });
      return {
        acceptCid,
        processed: true,
        settlementPrepared: true,
        budgetSet
      };
    }

    if (
      this.options.autoSubmitProviderWork &&
      deliverable &&
      Number(currentJob.status) < ACP_STATUS.Submitted
    ) {
      const submission = await this.acp.submitWork(linkedJob.jobId, deliverable);
      currentJob = submission.job;
      workSubmitted = true;
      console.log(`[EXECUTE] Submitted work for ACP job ${linkedJob.jobId}`);
    }

    let providerStatus = "awaiting-deliverable";
    if (Number(currentJob.status) >= ACP_STATUS.Completed) {
      providerStatus = "completed";
    } else if (Number(currentJob.status) >= ACP_STATUS.Submitted) {
      providerStatus = "work-submitted";
    } else if (!deliverable) {
      providerStatus = "awaiting-deliverable";
    }

    await this.noteAcceptanceState(document, {
      status: providerStatus,
      lastAttemptAt: nowIso(),
      role: prepared.role,
      settlementJobId: linkedJob.jobId,
      settlementJobStatus: currentJob.statusLabel,
      deliverableRef: deliverable || null
    });

    return {
      acceptCid,
      processed: true,
      settlementPrepared: true,
      budgetSet,
      workSubmitted
    };
  }

  async processCompletedJobAttestation(document, prepared) {
    const linkedJob = await this.acp.findJobForSettlement(prepared);

    if (!linkedJob) {
      return {
        generated: false,
        published: false
      };
    }

    const currentJob = linkedJob.job || (await this.acp.getJob(linkedJob.jobId));
    if (Number(currentJob.status) !== ACP_STATUS.Completed) {
      return {
        generated: false,
        published: false
      };
    }

    const result = await this.logic.attestSuccessfulJob({
      prepared,
      jobId: linkedJob.jobId,
      job: currentJob
    });

    let completionStatus = "completed-pending-feedback";
    if (prepared.role !== "provider") {
      completionStatus = "completed-no-attestation";
    } else if (result.published) {
      completionStatus = "completed-published";
    } else if (
      result.record &&
      result.record.onchain &&
      ["not-configured", "demo-local"].includes(result.record.onchain.status)
    ) {
      completionStatus = "completed-local-attestation";
    }

    await this.noteAcceptanceState(document, {
      status: completionStatus,
      lastAttemptAt: nowIso(),
      role: prepared.role,
      settlementJobId: linkedJob.jobId,
      settlementJobStatus: currentJob.statusLabel,
      reputationAttestationKey:
        result.record && result.record.attestationKey
          ? result.record.attestationKey
          : null,
      reputationPublished: Boolean(result.published),
      reputationPublishStatus:
        result.record && result.record.onchain
          ? result.record.onchain.status
          : null
    });

    return {
      generated: Boolean(result.generated),
      published: Boolean(result.published)
    };
  }

  async noteAcceptanceState(document, patch = {}) {
    const acceptCid =
      typeof document === "string" ? document : this.anp.computeCID(document);
    const entry =
      typeof document === "string"
        ? await this.anp.vault.getDocument(document)
        : await this.anp.vault.getDocument(acceptCid);
    const currentAutomation =
      entry && entry.metadata && isPlainObject(entry.metadata.automation)
        ? entry.metadata.automation
        : {};
    const targetDocument = typeof document === "string" ? entry && entry.document : document;

    if (!targetDocument) {
      return null;
    }

    return this.anp.vault.storeSignedDocument(targetDocument, {
      automation: {
        ...currentAutomation,
        ...patch,
        attempts: Number(currentAutomation.attempts || 0) + 1
      }
    });
  }
}

function firstDefinedBoolean(primary, fallback) {
  return typeof primary === "boolean" ? primary : fallback;
}

module.exports = {
  Hunter
};
