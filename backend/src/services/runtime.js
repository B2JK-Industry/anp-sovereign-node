const path = require("node:path");
const os = require("node:os");

const { ANPManager } = require("../engines/anp_engine");
const { ACPManager, ACP_ABI } = require("../engines/acp_engine");
const { LogicEngine } = require("./logic_engine");
const { Hunter } = require("./hunter");

const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const FRONTEND_ROOT = path.join(PROJECT_ROOT, "frontend");

function resolveStoragePaths() {
  const storageRoot = process.env.ANP_STORAGE_DIR ||
    (process.env.VERCEL
      ? path.join(os.tmpdir(), "anp-node")
      : PROJECT_ROOT);

  return {
    walletPath:
      process.env.ANP_WALLET_PATH ||
      path.join(
        storageRoot,
        process.env.VERCEL ? "sovereign_wallet.vercel.json" : "sovereign_wallet.json"
      ),
    vaultPath:
      process.env.TURSO_DATABASE_URL ||
      process.env.ANP_VAULT_PATH ||
      path.join(
        storageRoot,
        process.env.VERCEL ? "negotiation_vault.vercel.db" : "negotiation_vault.db"
      )
  };
}

const STORAGE_PATHS = Object.freeze(resolveStoragePaths());

function resolveDiscoveryConfig() {
  const adapter = process.env.ANP_MARKETPLACE_ADAPTER || null;
  const endpoint = process.env.ANP_DISCOVERY_URL || null;

  return {
    adapter,
    endpoint,
    autoConfigured: false
  };
}

const DISCOVERY_CONFIG = Object.freeze(resolveDiscoveryConfig());

const anpManager = new ANPManager({
  ...STORAGE_PATHS,
  discovery: {
    adapter: DISCOVERY_CONFIG.adapter,
    endpoint: DISCOVERY_CONFIG.endpoint
  },
  settlement: {
    rpcUrl: process.env.ANP_BASE_RPC_URL || null,
    contractAddress: process.env.ANP_ACP_CONTRACT_ADDRESS ? process.env.ANP_ACP_CONTRACT_ADDRESS.trim() : null,
    contractAbi: ACP_ABI
  }
});

const acpManager = new ACPManager({
  ...STORAGE_PATHS,
  anpManager,
  rpcUrl: process.env.ANP_BASE_RPC_URL || null
});
const logicEngine = new LogicEngine({
  anpManager,
  acpManager
});
const IS_PLATFORM_MODE = process.env.ANP_PLATFORM_MODE === "true" ||
  process.env.ANP_PLATFORM_MODE === "1";

const hunter = IS_PLATFORM_MODE ? null : new Hunter({
  anpManager,
  acpManager,
  logicEngine
});

// ─── Peer sync ──────────────────────────────────────────────────────────────

/**
 * Pull listings from a single peer node and store them in the local vault.
 * Returns { url, count, error }.
 */
async function syncFromPeer(peerUrl) {
  try {
    const url = `${peerUrl.replace(/\/$/, "")}/api/anp/listings?limit=100`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const body = await resp.json();
    const listings = Array.isArray(body.listings) ? body.listings : [];
    for (const listing of listings) {
      try {
        await anpManager.vault.recordListingObservation(listing, { adapter: "peer", peer: peerUrl });
      } catch {
        // ignore individual failures
      }
    }
    await anpManager.vault.updatePeerStatus(peerUrl, "ok");
    return { url: peerUrl, count: listings.length, error: null };
  } catch (err) {
    await anpManager.vault.updatePeerStatus(peerUrl, "error").catch(() => {});
    return { url: peerUrl, count: 0, error: err.message };
  }
}

/**
 * Sync from all known peers + any explicitly configured discovery adapter.
 */
async function syncDiscoveryIntoVault() {
  const results = { configured: false, count: 0, error: null, peers: [] };

  // Sync from explicitly configured adapter (if any)
  if (anpManager.discovery.hasActiveAdapter()) {
    results.configured = true;
    try {
      const listings = await anpManager.fetchOpenListings();
      results.count += listings.length;
    } catch (err) {
      results.error = err.message;
    }
  }

  // Sync from known peers
  const peers = await anpManager.vault.listPeers().catch(() => []);
  if (peers.length > 0) {
    results.configured = true;
    const peerResults = await Promise.all(peers.map((p) => syncFromPeer(p.url)));
    results.peers = peerResults;
    results.count += peerResults.reduce((sum, r) => sum + r.count, 0);
  }

  return results;
}

function sortByMostRecent(left, right) {
  const leftTime = Date.parse(left.updatedAt || left.storedAt || left.createdAt || 0);
  const rightTime = Date.parse(right.updatedAt || right.storedAt || right.createdAt || 0);
  return rightTime - leftTime;
}

function summarizeDocument(entry) {
  return {
    cid: entry.cid,
    type: entry.type,
    signer: entry.document ? entry.document.signer : null,
    updatedAt: entry.updatedAt || entry.storedAt || null,
    verificationValid: Boolean(entry.verification && entry.verification.valid),
    publications: Array.isArray(entry.publications) ? entry.publications.length : 0,
    settlements: Array.isArray(entry.settlements) ? entry.settlements.length : 0
  };
}

function summarizeActivity(activityEntry) {
  return {
    event: activityEntry.event,
    recordedAt: activityEntry.recordedAt,
    details: activityEntry.details || {}
  };
}

async function getDashboardState() {
  const discoverySync = await syncDiscoveryIntoVault();
  const wallet = await anpManager.getWalletMetadata();
  const vaultState = await anpManager.vault.load();
  const documents = Object.values(vaultState.documents).sort(sortByMostRecent);
  const recentDocuments = documents.slice(0, 8).map(summarizeDocument);
  const recentActivity = [...vaultState.activity]
    .slice(-12)
    .reverse()
    .map(summarizeActivity);
  let baseWallet = {
    configured: Boolean(acpManager.rpcUrl),
    balances: null,
    error: null
  };

  if (acpManager.rpcUrl) {
    try {
      baseWallet = {
        configured: true,
        balances: await acpManager.getBalances(),
        error: null
      };
    } catch (error) {
      baseWallet = {
        configured: true,
        balances: null,
        error: error.message
      };
    }
  }

  const peers = await anpManager.vault.listPeers().catch(() => []);

  return {
    service: "anp-backend",
    timestamp: new Date().toISOString(),
    runtime: {
      nodeVersion: process.version,
      projectRoot: PROJECT_ROOT
    },
    wallet: {
      ...wallet,
      base: baseWallet
    },
    storage: {
      walletPath: STORAGE_PATHS.walletPath,
      vaultPath: STORAGE_PATHS.vaultPath
    },
    discovery: {
      configured: discoverySync.configured,
      adapter: anpManager.discovery.config.adapter,
      endpoint: anpManager.discovery.config.endpoint,
      autoConfigured: false,
      peers: peers.length,
      syncedListings: discoverySync.count,
      syncError: discoverySync.error
    },
    settlement: anpManager.getSettlementSourceOfTruth(),
    vault: {
      counts: {
        documents: documents.length,
        listings: vaultState.indexes.listing.length,
        bids: vaultState.indexes.bid.length,
        acceptances: vaultState.indexes.acceptance.length,
        acpJobs: Object.keys(vaultState.acp.jobs).length,
        acpEvents: vaultState.acp.events.length,
        reputationAttestations: vaultState.reputation.attestations.length,
        humanPauses: vaultState.reputation.humanPauses.length
      },
      recentDocuments,
      recentActivity
    }
  };
}

async function getVaultSnapshot() {
  await syncDiscoveryIntoVault();
  return anpManager.vault.load();
}

module.exports = {
  FRONTEND_ROOT,
  PROJECT_ROOT,
  STORAGE_PATHS,
  getAcpManager: () => acpManager,
  getAnpManager: () => anpManager,
  getHunter: () => {
    if (!hunter) {
      const err = new Error("Hunter is disabled in platform mode (ANP_PLATFORM_MODE=true).");
      err.status = 503;
      throw err;
    }
    return hunter;
  },
  getLogicEngine: () => logicEngine,
  getDashboardState,
  getVaultSnapshot,
  syncFromPeer,
  summarizeDocument
};
