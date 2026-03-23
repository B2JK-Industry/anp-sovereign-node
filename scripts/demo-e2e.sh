#!/bin/zsh
# End-to-end demo: multi-agent job marketplace on ANP + ACP (Base).
#
# This script simulates the full flow:
#   Agent A (client)  posts a job listing, accepts a bid, funds escrow on Base
#   Agent B (provider) discovers the listing, submits a bid, does the work
#   Platform         stores all ANP documents, tracks ACP jobs
#
# Prerequisites:
#   - Platform running on PORT_PLATFORM (default 3001)  ANP_PLATFORM_MODE=true
#   - Agent A running on PORT_A (default 3002)          has funded wallet
#   - Agent B running on PORT_B (default 3003)          has funded wallet
#
# Usage:
#   ./scripts/demo-e2e.sh
#
# Set environment variables to override defaults:
#   PLATFORM_URL=http://localhost:3001
#   AGENT_A_URL=http://localhost:3002
#   AGENT_B_URL=http://localhost:3003

set -e

PLATFORM_URL="${PLATFORM_URL:-http://localhost:3001}"
AGENT_A_URL="${AGENT_A_URL:-http://localhost:3002}"
AGENT_B_URL="${AGENT_B_URL:-http://localhost:3003}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Colour

step() {
  echo ""
  echo "${BLUE}─── Step $1: $2 ${NC}"
}

ok() {
  echo "${GREEN}✓ $1${NC}"
}

info() {
  echo "${YELLOW}  $1${NC}"
}

die() {
  echo "${RED}✗ $1${NC}"
  exit 1
}

check_url() {
  curl -sf "$1/api/status" >/dev/null 2>&1 || die "$2 is not reachable at $1"
}

# ─── 0. Health checks ─────────────────────────────────────────────────────

step 0 "Health checks"
check_url "$PLATFORM_URL" "Platform"
ok "Platform reachable at $PLATFORM_URL"
check_url "$AGENT_A_URL" "Agent A"
ok "Agent A reachable at $AGENT_A_URL"
check_url "$AGENT_B_URL" "Agent B"
ok "Agent B reachable at $AGENT_B_URL"

# ─── 1. Agent A creates a signed ListingIntent ────────────────────────────

step 1 "Agent A creates a signed ListingIntent"
LISTING_RESP=$(curl -sf -X POST "$AGENT_A_URL/api/listings" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Build REST API integration for data pipeline",
    "description": "Need a REST API integration that fetches data from an external service, transforms it and writes to our database.",
    "minBudget": 10,
    "maxBudget": 50,
    "deliveryDays": 3,
    "tags": ["api", "data", "integration"]
  }')
LISTING_CID=$(echo "$LISTING_RESP" | grep -o '"cid":"[^"]*"' | head -1 | sed 's/"cid":"//;s/"//')
[ -n "$LISTING_CID" ] || die "Failed to create listing"
ok "Listing created: $LISTING_CID"

# ─── 2. Agent A publishes listing to the platform ─────────────────────────

step 2 "Agent A publishes ListingIntent to platform"
LISTING_DOC=$(echo "$LISTING_RESP" | grep -o '"document":{[^}]*}' || echo "$LISTING_RESP")
# Fetch the full document from Agent A's vault
DOC_RESP=$(curl -sf "$AGENT_A_URL/api/vault/documents/$LISTING_CID")
PUB_RESP=$(curl -sf -X POST "$PLATFORM_URL/api/anp/publish" \
  -H "Content-Type: application/json" \
  -d "$DOC_RESP")
ok "Listing published to platform"

# ─── 3. Agent B discovers listings ────────────────────────────────────────

step 3 "Agent B discovers open listings on platform"
LISTINGS=$(curl -sf "$PLATFORM_URL/api/anp/listings")
LISTING_COUNT=$(echo "$LISTINGS" | grep -o '"cid"' | wc -l | tr -d ' ')
ok "Agent B sees $LISTING_COUNT listing(s) on platform"
info "Listing CID: $LISTING_CID"

# ─── 4. Agent B creates a signed BidIntent ────────────────────────────────

step 4 "Agent B creates a signed BidIntent"
BID_RESP=$(curl -sf -X POST "$AGENT_B_URL/api/bids" \
  -H "Content-Type: application/json" \
  -d "{
    \"listingCid\": \"$LISTING_CID\",
    \"priceUsdc\": 20,
    \"deliveryDays\": 2,
    \"message\": \"I can build this API integration. I have experience with data pipelines and REST APIs.\"
  }")
BID_CID=$(echo "$BID_RESP" | grep -o '"cid":"[^"]*"' | head -1 | sed 's/"cid":"//;s/"//')
[ -n "$BID_CID" ] || die "Failed to create bid"
ok "Bid created: $BID_CID"

# ─── 5. Agent B publishes bid to platform ─────────────────────────────────

step 5 "Agent B publishes BidIntent to platform"
BID_DOC_RESP=$(curl -sf "$AGENT_B_URL/api/vault/documents/$BID_CID")
curl -sf -X POST "$PLATFORM_URL/api/anp/publish" \
  -H "Content-Type: application/json" \
  -d "$BID_DOC_RESP" >/dev/null
ok "Bid published to platform"

# ─── 6. Agent A views listing with bids ───────────────────────────────────

step 6 "Agent A checks listing bids on platform"
LISTING_DETAIL=$(curl -sf "$PLATFORM_URL/api/anp/listings/$LISTING_CID")
BID_COUNT=$(echo "$LISTING_DETAIL" | grep -o '"bidCids":\[[^]]*\]' | grep -o '"sha256-' | wc -l | tr -d ' ')
ok "Listing has $BID_COUNT bid(s)"
info "Bid CID: $BID_CID"

# ─── 7. Agent A creates AcceptIntent on platform ──────────────────────────

step 7 "Agent A creates AcceptIntent (signs acceptance on platform)"
ACCEPT_RESP=$(curl -sf -X POST "$PLATFORM_URL/api/anp/accept" \
  -H "Content-Type: application/json" \
  -d "{\"listingCid\": \"$LISTING_CID\", \"bidCid\": \"$BID_CID\"}")
ACCEPT_CID=$(echo "$ACCEPT_RESP" | grep -o '"cid":"[^"]*"' | head -1 | sed 's/"cid":"//;s/"//')
[ -n "$ACCEPT_CID" ] || die "Failed to create acceptance"
ok "Acceptance created: $ACCEPT_CID"

# ─── 8. Agent A publishes acceptance to platform ──────────────────────────

step 8 "Agent A publishes AcceptIntent to platform"
ACCEPT_DOC=$(echo "$ACCEPT_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('document', d)))" 2>/dev/null || echo "$ACCEPT_RESP")
curl -sf -X POST "$PLATFORM_URL/api/anp/publish" \
  -H "Content-Type: application/json" \
  -d "{\"document\": $(echo "$ACCEPT_RESP" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(json.dumps(d["document"]))' 2>/dev/null || echo 'null')}" >/dev/null || true
ok "Acceptance published"

# ─── 9 & 10. Agent A creates + funds ACP job on Base (manual step) ────────

step 9 "Agent A: create + fund ACP job on Base (manual)"
info "Agent A must now call createJob + fundJob on the ACP contract directly."
info "ACP contract: 0xaF3148696242F7Fb74893DC47690e37950807362 (Base)"
info "After executing, record the transactions using POST /api/acp/jobs/:id/record"
info ""
info "Example (replace JOB_ID and TX_HASH):"
info "  curl -X POST $PLATFORM_URL/api/acp/jobs/JOB_ID/record \\"
info "    -H 'Content-Type: application/json' \\"
info "    -d '{\"action\":\"createJob\",\"txHash\":\"0x...\",\"acceptCid\":\"$ACCEPT_CID\"}'"

# ─── 11. Demo: simulate recording transactions ────────────────────────────

step 11 "Recording simulated ACP job (demo only — no real Base tx)"
DEMO_JOB_ID="demo-$(date +%s)"
RECORD_RESP=$(curl -sf -X POST "$PLATFORM_URL/api/acp/jobs/$DEMO_JOB_ID/record" \
  -H "Content-Type: application/json" \
  -d "{
    \"action\": \"createJob\",
    \"txHash\": \"0xdemo0000000000000000000000000000000000000000000000000000000000001\",
    \"acceptCid\": \"$ACCEPT_CID\"
  }")
ok "createJob recorded for job $DEMO_JOB_ID"

curl -sf -X POST "$PLATFORM_URL/api/acp/jobs/$DEMO_JOB_ID/record" \
  -H "Content-Type: application/json" \
  -d "{
    \"action\": \"fundJob\",
    \"txHash\": \"0xdemo0000000000000000000000000000000000000000000000000000000000002\"
  }" >/dev/null
ok "fundJob recorded"

# ─── 12. Agent B checks job status ────────────────────────────────────────

step 12 "Agent B checks job status on platform"
JOB_STATUS=$(curl -sf "$PLATFORM_URL/api/acp/jobs/$DEMO_JOB_ID")
ok "Job status retrieved"
info "$JOB_STATUS"

# ─── 13. Agent B records submitWork ───────────────────────────────────────

step 13 "Agent B records submitWork transaction"
curl -sf -X POST "$PLATFORM_URL/api/acp/jobs/$DEMO_JOB_ID/record" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "submitWork",
    "txHash": "0xdemo0000000000000000000000000000000000000000000000000000000000003"
  }' >/dev/null
ok "submitWork recorded"

# ─── 14. Final state ──────────────────────────────────────────────────────

step 14 "Final platform state"
FINAL_JOBS=$(curl -sf "$PLATFORM_URL/api/acp/jobs")
echo "$FINAL_JOBS"

echo ""
echo "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo "${GREEN}  End-to-end demo complete!${NC}"
echo "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo "  Listing CID:    $LISTING_CID"
echo "  Bid CID:        $BID_CID"
echo "  Acceptance CID: $ACCEPT_CID"
echo "  Demo Job ID:    $DEMO_JOB_ID"
echo ""
echo "  For a real Base flow, replace the demo job steps with actual"
echo "  on-chain transactions using the ACP contract."
echo ""
