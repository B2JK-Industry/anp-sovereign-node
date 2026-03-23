#!/usr/bin/env node
/**
 * Deploy ACP.sol to Base mainnet.
 * Usage: node scripts/deploy-contract.js
 *
 * Requires .deploy-wallet.env with DEPLOY_WALLET_PRIVATE_KEY
 * or env var DEPLOY_WALLET_PRIVATE_KEY set directly.
 */

const fs   = require("node:fs");
const path = require("node:path");
const { ethers } = require("./backend/node_modules/ethers");

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_RPC   = "https://mainnet.base.org";
const USDC_BASE  = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CHAIN_ID   = 8453;

// Load private key
let privateKey = process.env.DEPLOY_WALLET_PRIVATE_KEY;
if (!privateKey) {
  const envFile = path.resolve(__dirname, "../.deploy-wallet.env");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
      const [k, v] = line.split("=");
      if (k && k.trim() === "DEPLOY_WALLET_PRIVATE_KEY") {
        privateKey = v && v.trim();
      }
    }
  }
}
if (!privateKey) {
  console.error("ERROR: DEPLOY_WALLET_PRIVATE_KEY not found.");
  process.exit(1);
}

// ─── Compile ABI + bytecode inline (via solc if available, else embedded) ────

// Embedded ABI (matches ACP.sol)
const ABI = [
  "constructor(address _token)",
  "function createJob(address provider, address evaluator, uint256 expiredAt, string description, address hook) returns (uint256 jobId)",
  "function fund(uint256 jobId, uint256 expectedBudget, bytes optParams)",
  "function setBudget(uint256 jobId, uint256 amount, bytes optParams)",
  "function setProvider(uint256 jobId, address provider, bytes optParams)",
  "function submit(uint256 jobId, bytes32 deliverable, bytes optParams)",
  "function complete(uint256 jobId, bytes32 reason, bytes optParams)",
  "function reject(uint256 jobId, bytes32 reason, bytes optParams)",
  "function claimRefund(uint256 jobId)",
  "function getJob(uint256 jobId) view returns (tuple(address client, address provider, address evaluator, string description, uint256 budget, uint256 expiredAt, uint8 status, address hook, bytes32 deliverable))",
  "function getJobCount() view returns (uint256)",
  "function getJobsByClient(address client) view returns (uint256[])",
  "function getJobsByProvider(address provider) view returns (uint256[])",
  "function token() view returns (address)",
  "function jobs(uint256) view returns (address client, address provider, address evaluator, string description, uint256 budget, uint256 expiredAt, uint8 status, address hook, bytes32 deliverable)",
  "event JobCreated(uint256 indexed jobId, address indexed client, address provider, address evaluator, uint256 expiredAt)",
  "event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount)",
  "event BudgetSet(uint256 indexed jobId, uint256 amount)",
  "event ProviderSet(uint256 indexed jobId, address indexed provider)",
  "event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable)",
  "event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason)",
  "event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason)",
  "event JobExpired(uint256 indexed jobId)",
  "event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount)"
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Check for solc
  let bytecode;
  const solcPath = path.resolve(__dirname, "../.tools/node-v24.14.0-darwin-arm64/bin/npx");
  const solcExists = false; // will try to compile

  try {
    // Try to compile via solc
    const { execSync } = require("node:child_process");
    const solFile = path.resolve(__dirname, "../contracts/ACP.sol");
    const result = execSync(
      `npx solc --bin --abi --optimize --optimize-runs 200 --overwrite -o /tmp/acp-build ${solFile} 2>&1`,
      { encoding: "utf8", env: { ...process.env, PATH: process.env.PATH + ":node_modules/.bin" } }
    );
    console.log("Compiled:", result.trim());
    bytecode = "0x" + fs.readFileSync("/tmp/acp-build/ACP.bin", "utf8").trim();
  } catch (err) {
    console.log("solc not available locally, using pre-compiled bytecode...");
    // Fallback: use the bytecode from the known-good original contract as reference
    // We must compile — exit if solc not available
    console.error("Please install solc: npm install -g solc");
    console.error("Or run: npx solc@0.8.20 --bin --abi --optimize --optimize-runs 200 --overwrite -o /tmp/acp-build contracts/ACP.sol");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet   = new ethers.Wallet(privateKey, provider);

  const network = await provider.getNetwork();
  if (Number(network.chainId) !== CHAIN_ID) {
    console.error(`Wrong network: expected Base (${CHAIN_ID}), got ${network.chainId}`);
    process.exit(1);
  }

  const balance = await provider.getBalance(wallet.address);
  console.log(`\nDeployer:  ${wallet.address}`);
  console.log(`Balance:   ${ethers.formatEther(balance)} ETH`);
  console.log(`Network:   Base mainnet (chainId ${CHAIN_ID})`);
  console.log(`Token:     USDC ${USDC_BASE}`);
  console.log(`Bytecode:  ${bytecode.length / 2 - 1} bytes\n`);

  if (balance === 0n) {
    console.error("ERROR: wallet has no ETH for gas.");
    process.exit(1);
  }

  console.log("Deploying ACP contract...");
  const factory  = new ethers.ContractFactory(ABI, bytecode, wallet);
  const contract = await factory.deploy(USDC_BASE);
  const receipt  = await contract.deploymentTransaction().wait();

  const address = await contract.getAddress();
  console.log(`\n✓ ACP contract deployed!`);
  console.log(`  Address:  ${address}`);
  console.log(`  Tx hash:  ${receipt.hash}`);
  console.log(`  Gas used: ${receipt.gasUsed.toString()}`);
  console.log(`  Block:    ${receipt.blockNumber}`);
  console.log(`\n  BaseScan: https://basescan.org/address/${address}`);

  // Verify it works — call token()
  const deployed = new ethers.Contract(address, ABI, provider);
  const tokenAddr = await deployed.token();
  console.log(`\n  token():  ${tokenAddr}`);
  console.log(`  ✓ Contract is live and responding\n`);

  // Save address to file
  const outputPath = path.resolve(__dirname, "../.deployed-contract.env");
  fs.writeFileSync(outputPath, `ACP_CONTRACT_ADDRESS=${address}\nDEPLOY_TX=${receipt.hash}\nDEPLOYED_AT=${new Date().toISOString()}\n`);
  console.log(`  Saved to: .deployed-contract.env`);
  console.log(`\n  Add to Vercel env vars:`);
  console.log(`  ANP_ACP_CONTRACT_ADDRESS=${address}`);
}

main().catch((err) => {
  console.error("\nDeploy failed:", err.message);
  process.exit(1);
});
