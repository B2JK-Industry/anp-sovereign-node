const {
  Contract,
  JsonRpcProvider,
  ZeroAddress,
  dataLength,
  formatEther,
  formatUnits,
  getAddress: normalizeAddress,
  hexlify,
  isHexString,
  keccak256,
  toUtf8Bytes
} = require("ethers");

const {
  ANPManager
} = require("./anp_engine");

const ACP_CONTRACT_ADDRESS = (process.env.ANP_ACP_CONTRACT_ADDRESS || "0x6951272DC7465046C560b7b702f61C5a3E7C898B").trim();
const BASE_CHAIN_ID = 8453;
const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const ACP_STATUS = Object.freeze({
  Open: 0,
  Funded: 1,
  Submitted: 2,
  Completed: 3,
  Rejected: 4,
  Expired: 5
});

const ACP_STATUS_LABELS = Object.freeze(
  Object.entries(ACP_STATUS).reduce((acc, [label, code]) => {
    acc[code] = label;
    return acc;
  }, {})
);
const FINAL_ACP_STATUSES = new Set([
  ACP_STATUS.Completed,
  ACP_STATUS.Rejected,
  ACP_STATUS.Expired
]);

// Verified ABI extracted from BaseScan for
// 0xaF3148696242F7Fb74893DC47690e37950807362 on Base Mainnet.
const ACP_ABI = Object.freeze([
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "jobId", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" }
    ],
    name: "BudgetSet",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "jobId", type: "uint256" },
      {
        indexed: true,
        internalType: "address",
        name: "evaluator",
        type: "address"
      },
      { indexed: false, internalType: "bytes32", name: "reason", type: "bytes32" }
    ],
    name: "JobCompleted",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "jobId", type: "uint256" },
      { indexed: true, internalType: "address", name: "client", type: "address" },
      { indexed: false, internalType: "address", name: "provider", type: "address" },
      { indexed: false, internalType: "address", name: "evaluator", type: "address" },
      { indexed: false, internalType: "uint256", name: "expiredAt", type: "uint256" }
    ],
    name: "JobCreated",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [{ indexed: true, internalType: "uint256", name: "jobId", type: "uint256" }],
    name: "JobExpired",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "jobId", type: "uint256" },
      { indexed: true, internalType: "address", name: "client", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" }
    ],
    name: "JobFunded",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "jobId", type: "uint256" },
      { indexed: true, internalType: "address", name: "rejector", type: "address" },
      { indexed: false, internalType: "bytes32", name: "reason", type: "bytes32" }
    ],
    name: "JobRejected",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "jobId", type: "uint256" },
      { indexed: true, internalType: "address", name: "provider", type: "address" },
      {
        indexed: false,
        internalType: "bytes32",
        name: "deliverable",
        type: "bytes32"
      }
    ],
    name: "JobSubmitted",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "jobId", type: "uint256" },
      { indexed: true, internalType: "address", name: "provider", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" }
    ],
    name: "PaymentReleased",
    type: "event"
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "jobId", type: "uint256" },
      { indexed: true, internalType: "address", name: "provider", type: "address" }
    ],
    name: "ProviderSet",
    type: "event"
  },
  {
    inputs: [{ internalType: "uint256", name: "jobId", type: "uint256" }],
    name: "claimRefund",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "uint256", name: "jobId", type: "uint256" },
      { internalType: "bytes32", name: "reason", type: "bytes32" },
      { internalType: "bytes", name: "optParams", type: "bytes" }
    ],
    name: "complete",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "provider", type: "address" },
      { internalType: "address", name: "evaluator", type: "address" },
      { internalType: "uint256", name: "expiredAt", type: "uint256" },
      { internalType: "string", name: "description", type: "string" },
      { internalType: "address", name: "hook", type: "address" }
    ],
    name: "createJob",
    outputs: [{ internalType: "uint256", name: "jobId", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "uint256", name: "jobId", type: "uint256" }],
    name: "getJob",
    outputs: [
      {
        components: [
          { internalType: "address", name: "client", type: "address" },
          { internalType: "address", name: "provider", type: "address" },
          { internalType: "address", name: "evaluator", type: "address" },
          { internalType: "string", name: "description", type: "string" },
          { internalType: "uint256", name: "budget", type: "uint256" },
          { internalType: "uint256", name: "expiredAt", type: "uint256" },
          { internalType: "uint8", name: "status", type: "uint8" },
          { internalType: "address", name: "hook", type: "address" },
          { internalType: "bytes32", name: "deliverable", type: "bytes32" }
        ],
        internalType: "struct ACP.Job",
        name: "",
        type: "tuple"
      }
    ],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "getJobCount",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "client", type: "address" }
    ],
    name: "getJobsByClient",
    outputs: [{ internalType: "uint256[]", name: "", type: "uint256[]" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "provider", type: "address" }
    ],
    name: "getJobsByProvider",
    outputs: [{ internalType: "uint256[]", name: "", type: "uint256[]" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "uint256", name: "jobId", type: "uint256" },
      { internalType: "uint256", name: "expectedBudget", type: "uint256" },
      { internalType: "bytes", name: "optParams", type: "bytes" }
    ],
    name: "fund",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    name: "jobs",
    outputs: [
      { internalType: "address", name: "client", type: "address" },
      { internalType: "address", name: "provider", type: "address" },
      { internalType: "address", name: "evaluator", type: "address" },
      { internalType: "string", name: "description", type: "string" },
      { internalType: "uint256", name: "budget", type: "uint256" },
      { internalType: "uint256", name: "expiredAt", type: "uint256" },
      { internalType: "uint8", name: "status", type: "uint8" },
      { internalType: "address", name: "hook", type: "address" },
      { internalType: "bytes32", name: "deliverable", type: "bytes32" }
    ],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "uint256", name: "jobId", type: "uint256" },
      { internalType: "uint256", name: "amount", type: "uint256" },
      { internalType: "bytes", name: "optParams", type: "bytes" }
    ],
    name: "setBudget",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "uint256", name: "jobId", type: "uint256" },
      { internalType: "address", name: "provider", type: "address" },
      { internalType: "bytes", name: "optParams", type: "bytes" }
    ],
    name: "setProvider",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "uint256", name: "jobId", type: "uint256" },
      { internalType: "bytes32", name: "deliverable", type: "bytes32" },
      { internalType: "bytes", name: "optParams", type: "bytes" }
    ],
    name: "submit",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "uint256", name: "jobId", type: "uint256" },
      { internalType: "bytes32", name: "reason", type: "bytes32" },
      { internalType: "bytes", name: "optParams", type: "bytes" }
    ],
    name: "reject",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [],
    name: "token",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  }
]);

const ERC20_ABI = Object.freeze([
  {
    inputs: [
      { internalType: "address", name: "owner", type: "address" },
      { internalType: "address", name: "spender", type: "address" }
    ],
    name: "allowance",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "spender", type: "address" },
      { internalType: "uint256", name: "value", type: "uint256" }
    ],
    name: "approve",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  }
]);

function nowInSeconds() {
  return Math.floor(Date.now() / 1000);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeAmountToMicroUsdc(amount) {
  if (typeof amount === "bigint") {
    return amount;
  }

  const text = String(amount).trim();
  const match = text.match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!match) {
    throw new TypeError(`Invalid USDC amount: ${amount}`);
  }

  const whole = match[1];
  const fraction = (match[2] || "").padEnd(6, "0");
  return BigInt(`${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0");
}

function encodeOptParams(value) {
  if (
    typeof value === "undefined" ||
    value === null ||
    value === "" ||
    value === "0x"
  ) {
    return "0x";
  }

  if (typeof value === "string" && isHexString(value)) {
    return value;
  }

  if (typeof value === "string") {
    return hexlify(toUtf8Bytes(value));
  }

  return hexlify(toUtf8Bytes(JSON.stringify(serializeValue(value))));
}

function normalizeBytes32(value, label = "value") {
  if (typeof value === "string" && isHexString(value) && dataLength(value) === 32) {
    return value;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string or bytes32 hex value.`);
  }

  return keccak256(toUtf8Bytes(value));
}

function decodeEventLog(contract, log) {
  try {
    return contract.interface.parseLog(log);
  } catch (error) {
    return null;
  }
}

function bigintToString(value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function serializeValue(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serializeValue(item)])
    );
  }

  return value;
}

function normalizeJobStruct(job) {
  if (!job) {
    return null;
  }

  const statusCode = Number(job.status);
  return {
    client: job.client,
    provider: job.provider,
    evaluator: job.evaluator,
    description: job.description,
    budget: bigintToString(job.budget),
    expiredAt: bigintToString(job.expiredAt),
    status: statusCode,
    statusLabel: ACP_STATUS_LABELS[statusCode] || "Unknown",
    hook: job.hook,
    deliverable: job.deliverable
  };
}

function sameAddress(left, right) {
  if (!isNonEmptyString(left) || !isNonEmptyString(right)) {
    return false;
  }

  try {
    return normalizeAddress(left) === normalizeAddress(right);
  } catch (error) {
    return false;
  }
}

function jobIncludesAddress(job, address) {
  return [job && job.client, job && job.provider, job && job.evaluator].some(
    (participant) => sameAddress(participant, address)
  );
}

function isAcceptIntentDocument(document) {
  const type = String(document && document.type ? document.type : "")
    .trim()
    .toLowerCase();
  return type === "accept" || type === "acceptance";
}

function normalizeReferenceString(value, label) {
  if (!isNonEmptyString(value)) {
    throw new Error(`${label} is missing from AcceptIntent document.`);
  }

  return value.trim();
}

function compareCandidatesByNewestJobId(left, right) {
  try {
    const leftJobId = BigInt(left.jobId);
    const rightJobId = BigInt(right.jobId);

    if (leftJobId === rightJobId) {
      return 0;
    }

    return leftJobId > rightJobId ? -1 : 1;
  } catch (error) {
    return String(right.jobId).localeCompare(String(left.jobId));
  }
}

function matchesJobParticipants(job, params) {
  return (
    sameAddress(job.client, params.client) &&
    sameAddress(job.provider, params.provider) &&
    sameAddress(job.evaluator, params.evaluator) &&
    BigInt(job.budget || "0") === BigInt(params.budget)
  );
}

function buildJobParamsFromAcceptedNegotiation(bundle, options = {}) {
  const acceptDocument = bundle.accept.document;
  const bidDocument = bundle.bid.document;
  const listingDocument = bundle.listing.document;

  let client, provider, evaluator;
  try {
    client = normalizeAddress(options.client || acceptDocument.signer);
  } catch (err) {
    throw new Error(`Invalid client address in accept document: ${err.message}`);
  }
  try {
    provider = normalizeAddress(options.provider || bidDocument.signer);
  } catch (err) {
    throw new Error(`Invalid provider address in bid document: ${err.message}`);
  }
  try {
    evaluator = normalizeAddress(
      options.evaluator ||
        listingDocument.data.preferredEvaluator ||
        client
    );
  } catch (err) {
    throw new Error(`Invalid evaluator address: ${err.message}`);
  }

  const deliverySeconds = BigInt(
    options.deliverySeconds || bidDocument.data.deliveryTime || "0"
  );
  const fallbackDuration = deliverySeconds > 0n ? deliverySeconds : 86_400n;
  const expiredAt = options.expiredAt
    ? BigInt(options.expiredAt)
    : BigInt(nowInSeconds()) + fallbackDuration;
  const budget = BigInt(bidDocument.data.price);
  const acceptReference = bundle.accept.typedHash || bundle.accept.cid;

  return {
    client,
    provider,
    evaluator,
    expiredAt: expiredAt.toString(),
    description: options.description || `ANP accepted job ${acceptReference}`,
    hook: normalizeAddress(options.hook || ZeroAddress),
    budget: budget.toString(),
    deliverySeconds: deliverySeconds.toString(),
    acceptCid: bundle.accept.cid,
    acceptTypedHash: bundle.accept.typedHash || null,
    bidCid: bundle.bid.cid,
    listingCid: bundle.listing.cid,
    listingHash: acceptDocument.data.listingHash,
    bidHash: acceptDocument.data.bidHash
  };
}

class ACPManager {
  constructor(options = {}) {
    this.anp =
      options.anpManager ||
      new ANPManager({
        walletPath: options.walletPath,
        vaultPath: options.vaultPath
      });
    this.rpcUrl = options.rpcUrl || process.env.ANP_BASE_RPC_URL || null;
    this.chainId = options.chainId || BASE_CHAIN_ID;
    this.contractAddress = options.contractAddress || ACP_CONTRACT_ADDRESS;
    this.contractAbi = options.contractAbi || ACP_ABI;
    this.usdcAddress = options.usdcAddress || BASE_USDC_ADDRESS;
    this.eventListeners = [];
  }

  getProvider() {
    if (!this.rpcUrl) {
      throw new Error(
        "No Base RPC URL configured. Set ANP_BASE_RPC_URL to use ACPManager."
      );
    }

    return new JsonRpcProvider(this.rpcUrl, this.chainId);
  }

  async getSigner() {
    const wallet = await this.anp.ensureWallet();
    return wallet.connect(this.getProvider());
  }

  async getAddress() {
    return this.anp.getAddress();
  }

  getVault() {
    return this.anp.vault;
  }

  async resolveVaultDocumentEntry(documentOrCid) {
    const vault = this.getVault();

    if (typeof documentOrCid === "string") {
      return vault.getDocument(documentOrCid);
    }

    const cid = this.anp.computeCID(documentOrCid);
    return (await vault.getDocument(cid)) || {
      cid,
      document: documentOrCid
    };
  }

  getContract(runner = null) {
    return new Contract(
      this.contractAddress,
      this.contractAbi,
      runner || this.getProvider()
    );
  }

  getUsdcContract(runner = null) {
    return new Contract(
      this.usdcAddress,
      ERC20_ABI,
      runner || this.getProvider()
    );
  }

  async getJob(jobId) {
    const contract = this.getContract();
    const job = await contract.getJob(jobId);
    return normalizeJobStruct(job);
  }

  async recordJobMutation(jobId, receipt, action, data = {}) {
    const job = await this.getJob(jobId);

    await this.getVault().recordACPJob(jobId, {
      txHash: receipt.hash,
      action,
      ...data,
      job
    });

    return job;
  }

  async shouldTrackLifecycleEvent(jobId, address, participantHints = [], options = {}) {
    if (options.onlyOwnJobs === false) {
      return true;
    }

    if (participantHints.some((participant) => sameAddress(participant, address))) {
      return true;
    }

    if (!jobId || !this.rpcUrl) {
      return false;
    }

    const job = await this.getJob(jobId);
    return jobIncludesAddress(job, address);
  }

  async ensureUsdcAllowance(amount, options = {}) {
    const signer = await this.getSigner();
    const owner = await signer.getAddress();
    const usdc = this.getUsdcContract(signer);
    const requiredAmount = normalizeAmountToMicroUsdc(amount);
    const allowance = await usdc.allowance(owner, this.contractAddress);

    if (allowance >= requiredAmount) {
      return {
        approved: false,
        owner,
        spender: this.contractAddress,
        allowance: allowance.toString(),
        requiredAmount: requiredAmount.toString()
      };
    }

    const approveAmount = options.approveAmount
      ? normalizeAmountToMicroUsdc(options.approveAmount)
      : requiredAmount;
    const tx = await usdc.approve(this.contractAddress, approveAmount);
    const receipt = await tx.wait();

    return {
      approved: true,
      owner,
      spender: this.contractAddress,
      allowance: approveAmount.toString(),
      requiredAmount: requiredAmount.toString(),
      txHash: receipt.hash
    };
  }

  async createJob({
    provider,
    evaluator,
    expiredAt,
    description,
    hook = ZeroAddress
  }) {
    const signer = await this.getSigner();
    const contract = this.getContract(signer);
    const tx = await contract.createJob(
      normalizeAddress(provider),
      normalizeAddress(evaluator),
      BigInt(expiredAt),
      description,
      normalizeAddress(hook)
    );
    const receipt = await tx.wait();

    let jobId = null;
    for (const log of receipt.logs) {
      const parsed = decodeEventLog(contract, log);
      if (parsed && parsed.name === "JobCreated") {
        jobId = parsed.args.jobId.toString();
        break;
      }
    }

    if (!jobId) {
      throw new Error("ACP createJob succeeded but JobCreated event was not found.");
    }

    const job = await this.recordJobMutation(jobId, receipt, "createJob", {
      contractAddress: this.contractAddress
    });

    return {
      jobId,
      txHash: receipt.hash,
      job
    };
  }

  async setJobBudget(jobId, amount, options = {}) {
    const signer = await this.getSigner();
    const contract = this.getContract(signer);
    const microUsdc = normalizeAmountToMicroUsdc(amount);
    const tx = await contract.setBudget(
      BigInt(jobId),
      microUsdc,
      encodeOptParams(options.optParams)
    );
    const receipt = await tx.wait();
    const job = await this.recordJobMutation(jobId, receipt, "setBudget", {
      budget: microUsdc.toString()
    });

    return {
      jobId: String(jobId),
      amount: microUsdc.toString(),
      txHash: receipt.hash,
      job
    };
  }

  async fundJob(jobId, amount, options = {}) {
    const signer = await this.getSigner();
    const contract = this.getContract(signer);
    const microUsdc = normalizeAmountToMicroUsdc(amount);

    if (options.ensureAllowance !== false) {
      await this.ensureUsdcAllowance(microUsdc, options.approval || {});
    }

    const tx = await contract.fund(
      BigInt(jobId),
      microUsdc,
      encodeOptParams(options.optParams)
    );
    const receipt = await tx.wait();
    const job = await this.recordJobMutation(jobId, receipt, "fundJob", {
      fundedAmount: microUsdc.toString()
    });

    return {
      jobId: String(jobId),
      amount: microUsdc.toString(),
      txHash: receipt.hash,
      job
    };
  }

  async submitWork(jobId, deliverable, options = {}) {
    const signer = await this.getSigner();
    const contract = this.getContract(signer);
    const deliverableHash = normalizeBytes32(deliverable, "deliverable");
    const tx = await contract.submit(
      BigInt(jobId),
      deliverableHash,
      encodeOptParams(options.optParams)
    );
    const receipt = await tx.wait();
    const job = await this.recordJobMutation(jobId, receipt, "submitWork", {
      deliverableRef: deliverable,
      deliverableHash
    });

    return {
      jobId: String(jobId),
      deliverable,
      deliverableHash,
      txHash: receipt.hash,
      job
    };
  }

  async completeJob(jobId, reason = "completed", options = {}) {
    const signer = await this.getSigner();
    const contract = this.getContract(signer);
    const reasonHash = normalizeBytes32(reason, "reason");
    const tx = await contract.complete(
      BigInt(jobId),
      reasonHash,
      encodeOptParams(options.optParams)
    );
    const receipt = await tx.wait();
    const job = await this.recordJobMutation(jobId, receipt, "completeJob", {
      reason,
      reasonHash
    });

    return {
      jobId: String(jobId),
      reason,
      reasonHash,
      txHash: receipt.hash,
      job
    };
  }

  async rejectJob(jobId, reason = "rejected", options = {}) {
    const signer = await this.getSigner();
    const contract = this.getContract(signer);
    const reasonHash = normalizeBytes32(reason, "reason");
    const tx = await contract.reject(
      BigInt(jobId),
      reasonHash,
      encodeOptParams(options.optParams)
    );
    const receipt = await tx.wait();
    const job = await this.recordJobMutation(jobId, receipt, "rejectJob", {
      reason,
      reasonHash
    });

    return {
      jobId: String(jobId),
      reason,
      reasonHash,
      txHash: receipt.hash,
      job
    };
  }

  async watchJobLifecycle(options = {}) {
    const address = normalizeAddress(options.address || (await this.getAddress()));
    const contract = this.getContract();
    this.stopWatchingJobLifecycle();

    const fundedFilter = contract.filters.JobFunded();
    const submittedFilter = contract.filters.JobSubmitted();

    const reportListenerError = async (eventName, error) => {
      if (typeof options.onError === "function") {
        try {
          await options.onError(error, {
            eventName,
            address
          });
          return;
        } catch (reportError) {
          console.error(
            `[ACP] Error reporter failed while handling ${eventName}: ${reportError.message}`
          );
        }
      }

      console.error(
        `[ACP] Failed to process ${eventName} for ${address}: ${error.message}`
      );
    };

    const handleEvent = async (
      eventName,
      decodedArgs,
      event,
      participantHints = []
    ) => {
      try {
        const jobId = decodedArgs.jobId ? decodedArgs.jobId.toString() : null;
        const shouldTrack = await this.shouldTrackLifecycleEvent(
          jobId,
          address,
          participantHints,
          options
        );
        if (!shouldTrack) {
          return;
        }

        const sourceEvent = event && event.log ? event.log : event;
        const payload = {
          eventName,
          jobId,
          address,
          txHash: sourceEvent ? sourceEvent.transactionHash : null,
          blockNumber: sourceEvent ? sourceEvent.blockNumber : null,
          args: serializeValue(
            Object.fromEntries(
              Object.entries(decodedArgs).filter(([key]) => Number.isNaN(Number(key)))
            )
          )
        };

        await this.getVault().recordACPEvent(payload);
        if (payload.jobId) {
          await this.getVault().recordACPJob(payload.jobId, {
            lastObservedEvent: payload
          });
        }

        if (typeof options.onEvent === "function") {
          await options.onEvent(payload);
        }
      } catch (error) {
        await reportListenerError(eventName, error);
      }
    };

    const onFunded = async (...args) => {
      const event = args[args.length - 1];
      await handleEvent(
        "JobFunded",
        {
          jobId: args[0],
          client: args[1],
          amount: args[2]
        },
        event,
        [args[1]]
      );
    };

    const onSubmitted = async (...args) => {
      const event = args[args.length - 1];
      await handleEvent(
        "JobSubmitted",
        {
          jobId: args[0],
          provider: args[1],
          deliverable: args[2]
        },
        event,
        [args[1]]
      );
    };

    contract.on(fundedFilter, onFunded);
    contract.on(submittedFilter, onSubmitted);

    this.eventListeners.push({ contract, filter: fundedFilter, listener: onFunded });
    this.eventListeners.push({
      contract,
      filter: submittedFilter,
      listener: onSubmitted
    });

    return {
      address,
      watchedEvents: ["JobFunded", "JobSubmitted"]
    };
  }

  stopWatchingJobLifecycle() {
    for (const { contract, filter, listener } of this.eventListeners) {
      contract.off(filter, listener);
    }

    this.eventListeners = [];
  }

  async getBalances() {
    const address = await this.getAddress();
    const provider = this.getProvider();
    const usdc = this.getUsdcContract();
    const [balance, nativeBalance] = await Promise.all([
      usdc.balanceOf(address),
      provider.getBalance(address)
    ]);

    return {
      address,
      chainId: this.chainId,
      native: nativeBalance.toString(),
      nativeFormatted: formatEther(nativeBalance),
      usdc: balance.toString(),
      usdcFormatted: formatUnits(balance, 6)
    };
  }

  async getJobsByClient(clientAddress) {
    const contract = this.getContract();
    const jobIds = await contract.getJobsByClient(normalizeAddress(clientAddress));
    return jobIds.map((jobId) => jobId.toString());
  }

  async getJobsByProvider(providerAddress) {
    const contract = this.getContract();
    const jobIds = await contract.getJobsByProvider(normalizeAddress(providerAddress));
    return jobIds.map((jobId) => jobId.toString());
  }

  async resolveAcceptedNegotiation(acceptDocumentOrCid) {
    const vault = this.getVault();
    await vault.load();

    const acceptEntry = await this.resolveVaultDocumentEntry(acceptDocumentOrCid);

    if (!acceptEntry || !acceptEntry.document) {
      throw new Error("AcceptIntent document not found in negotiation vault.");
    }

    if (!isAcceptIntentDocument(acceptEntry.document)) {
      throw new Error(
        `Expected an AcceptIntent document, received ${acceptEntry.document.type || "unknown"}.`
      );
    }

    const acceptVerification = this.anp.verifyDocument(acceptEntry.document);
    if (!acceptVerification.valid) {
      throw new Error(
        `Invalid AcceptIntent signature: ${acceptVerification.error || "unknown error"}`
      );
    }

    const bidHash = normalizeReferenceString(
      acceptEntry.document.data && acceptEntry.document.data.bidHash,
      "bidHash"
    );
    const listingHash = normalizeReferenceString(
      acceptEntry.document.data && acceptEntry.document.data.listingHash,
      "listingHash"
    );

    const bidEntry = await vault.getDocumentByTypedHash(bidHash);
    const listingEntry = await vault.getDocumentByTypedHash(listingHash);

    if (!bidEntry || !listingEntry) {
      throw new Error(
        "AcceptIntent linkage failed: corresponding bid or listing document is missing from the negotiation vault."
      );
    }

    const bidVerification = this.anp.verifyDocument(bidEntry.document);
    const listingVerification = this.anp.verifyDocument(listingEntry.document);
    if (!bidVerification.valid || !listingVerification.valid) {
      throw new Error("Linked ANP bid/listing documents did not verify locally.");
    }

    return {
      accept: acceptEntry,
      bid: bidEntry,
      listing: listingEntry
    };
  }

  async prepareJobParamsFromAcceptIntent(acceptDocumentOrCid, options = {}) {
    const bundle = await this.resolveAcceptedNegotiation(acceptDocumentOrCid);
    return buildJobParamsFromAcceptedNegotiation(bundle, options);
  }

  async prepareSettlement(acceptDocumentOrCid, options = {}) {
    const bundle = await this.resolveAcceptedNegotiation(acceptDocumentOrCid);
    const params = buildJobParamsFromAcceptedNegotiation(bundle, options);
    const ownAddress = normalizeAddress(await this.getAddress());
    const acceptTypedHash =
      params.acceptTypedHash ||
      this.anp.hashTypedData("AcceptIntent", bundle.accept.document.data);

    let role = "observer";
    if (ownAddress === normalizeAddress(params.client)) {
      role = "client";
    } else if (ownAddress === normalizeAddress(params.provider)) {
      role = "provider";
    } else if (ownAddress === normalizeAddress(params.evaluator)) {
      role = "evaluator";
    }

    return {
      role,
      ownAddress,
      acceptCid: params.acceptCid,
      acceptTypedHash,
      integrityVerified: true,
      documents: {
        accept: bundle.accept.document,
        bid: bundle.bid.document,
        listing: bundle.listing.document
      },
      params
    };
  }

  async findJobByAcceptCid(acceptCid) {
    const vault = this.getVault();
    const state = await vault.load();

    const candidates = Object.values(state.acp.jobs)
      .filter((job) => job.acceptCid === acceptCid)
      .sort((left, right) => {
        const leftTime = Date.parse(left.updatedAt || 0);
        const rightTime = Date.parse(right.updatedAt || 0);
        return rightTime - leftTime;
      });

    return candidates[0] || null;
  }

  async findJobForSettlement(prepared, options = {}) {
    if (options.jobId) {
      const job = await this.getJob(options.jobId);
      return {
        jobId: String(options.jobId),
        job,
        source: "explicit"
      };
    }

    const localJob = await this.findJobByAcceptCid(prepared.acceptCid);
    if (localJob && localJob.jobId) {
      return {
        jobId: localJob.jobId,
        job: localJob.job || (this.rpcUrl ? await this.getJob(localJob.jobId) : null),
        source: "vault"
      };
    }

    if (!this.rpcUrl) {
      return null;
    }

    const jobIds =
      prepared.role === "provider"
        ? await this.getJobsByProvider(prepared.params.provider)
        : await this.getJobsByClient(prepared.params.client);
    const referenceCandidates = [
      prepared.acceptCid,
      prepared.acceptTypedHash,
      prepared.params.bidHash,
      prepared.params.listingHash
    ].filter(isNonEmptyString);
    const candidates = [];

    for (const jobId of jobIds) {
      const job = await this.getJob(jobId);
      const description = String(job.description || "");
      const referencesMatch = referenceCandidates.some((value) =>
        description.includes(String(value))
      );
      const partyMatch = matchesJobParticipants(job, prepared.params);

      if (!referencesMatch && !partyMatch) {
        continue;
      }

      candidates.push({
        jobId: String(jobId),
        job,
        referencesMatch,
        partyMatch
      });
    }

    const referencedCandidates = candidates
      .filter((candidate) => candidate.referencesMatch)
      .sort(compareCandidatesByNewestJobId);
    if (referencedCandidates.length > 0) {
      return {
        jobId: referencedCandidates[0].jobId,
        job: referencedCandidates[0].job,
        source: "onchain-reference"
      };
    }

    const partyCandidates = candidates
      .filter((candidate) => candidate.partyMatch)
      .sort(compareCandidatesByNewestJobId);
    if (partyCandidates.length === 1) {
      return {
        jobId: partyCandidates[0].jobId,
        job: partyCandidates[0].job,
        source: "onchain-party"
      };
    }

    const activePartyCandidates = partyCandidates.filter(
      (candidate) => !FINAL_ACP_STATUSES.has(Number(candidate.job.status))
    );
    if (activePartyCandidates.length === 1) {
      return {
        jobId: activePartyCandidates[0].jobId,
        job: activePartyCandidates[0].job,
        source: "onchain-party-active"
      };
    }

    return null;
  }

  async createJobFromAcceptIntent(acceptDocumentOrCid, options = {}) {
    const params = await this.prepareJobParamsFromAcceptIntent(
      acceptDocumentOrCid,
      options
    );
    const signerAddress = normalizeAddress(await this.getAddress());

    if (signerAddress !== normalizeAddress(params.client)) {
      throw new Error(
        "ACP createJob must be submitted by the accepted client. The current wallet is not the AcceptIntent signer/client."
      );
    }

    const creation = await this.createJob(params);
    await this.getVault().recordACPJob(creation.jobId, {
      source: "accept-intent",
      acceptCid: params.acceptCid,
      bidCid: params.bidCid,
      listingCid: params.listingCid,
      negotiatedBudget: params.budget,
      deliverySeconds: params.deliverySeconds
    });

    return {
      ...creation,
      linkedNegotiation: params
    };
  }

  async setBudgetFromAcceptIntent(jobId, acceptDocumentOrCid, options = {}) {
    const params = await this.prepareJobParamsFromAcceptIntent(
      acceptDocumentOrCid,
      options
    );
    const signerAddress = normalizeAddress(await this.getAddress());

    if (signerAddress !== normalizeAddress(params.provider)) {
      throw new Error(
        "ACP setBudget must be submitted by the negotiated provider. The current wallet is not the bid signer/provider."
      );
    }

    return this.setJobBudget(jobId, params.budget, options);
  }
}

module.exports = {
  ACP_ABI,
  ACP_CONTRACT_ADDRESS,
  ACP_STATUS,
  ACPManager,
  BASE_USDC_ADDRESS
};
