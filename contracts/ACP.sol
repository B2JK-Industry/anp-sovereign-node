// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title ACP — Agent Completion Protocol
 * @notice Permissionless escrow for agent job marketplace.
 *         USDC is locked on fund(), released on complete(), refunded on claimRefund().
 *
 * Job lifecycle:
 *   Open(0) → Funded(1) → Submitted(2) → Completed(3)
 *                       ↘ Rejected(4)
 *             Expired(5) — claimable any time after expiredAt when not Completed
 */
contract ACP {
    // ─── Types ────────────────────────────────────────────────────────────────

    enum Status { Open, Funded, Submitted, Completed, Rejected, Expired }

    struct Job {
        address client;
        address provider;
        address evaluator;
        string  description;
        uint256 budget;
        uint256 expiredAt;
        Status  status;
        address hook;
        bytes32 deliverable;
    }

    // ─── Storage ──────────────────────────────────────────────────────────────

    IERC20 public immutable token;

    mapping(uint256 => Job) public jobs;
    uint256 private _jobCount;

    mapping(address => uint256[]) private _jobsByClient;
    mapping(address => uint256[]) private _jobsByProvider;

    // ─── Events ───────────────────────────────────────────────────────────────

    event JobCreated(uint256 indexed jobId, address indexed client, address provider, address evaluator, uint256 expiredAt);
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event BudgetSet(uint256 indexed jobId, uint256 amount);
    event ProviderSet(uint256 indexed jobId, address indexed provider);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
    event JobExpired(uint256 indexed jobId);
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address _token) {
        require(_token != address(0), "ACP: zero token address");
        token = IERC20(_token);
    }

    // ─── Write functions ──────────────────────────────────────────────────────

    /**
     * @notice Create a new job. Caller becomes the client.
     * @param provider  Agent who will do the work (address(0) = open to any).
     * @param evaluator Agent who will call complete() to release payment.
     * @param expiredAt Unix timestamp after which the job can be expired.
     * @param description  Human-readable job description.
     * @param hook      Optional contract called on state changes (address(0) = none).
     */
    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external returns (uint256 jobId) {
        require(expiredAt > block.timestamp, "ACP: expiredAt in the past");

        jobId = _jobCount++;
        Job storage j = jobs[jobId];
        j.client      = msg.sender;
        j.provider    = provider;
        j.evaluator   = evaluator;
        j.description = description;
        j.expiredAt   = expiredAt;
        j.hook        = hook;
        j.status      = Status.Open;

        _jobsByClient[msg.sender].push(jobId);
        if (provider != address(0)) {
            _jobsByProvider[provider].push(jobId);
        }

        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt);
    }

    /**
     * @notice Fund a job with USDC. Caller must have approved this contract first.
     * @param jobId          Job to fund.
     * @param expectedBudget Amount of USDC (in token decimals) to lock.
     * @param optParams      Reserved for future extensions (pass empty bytes).
     */
    function fund(
        uint256 jobId,
        uint256 expectedBudget,
        bytes calldata optParams
    ) external {
        Job storage j = jobs[jobId];
        require(j.client != address(0), "ACP: job does not exist");
        require(j.status == Status.Open, "ACP: job not open");
        require(j.client == msg.sender, "ACP: only client can fund");
        require(expectedBudget > 0, "ACP: budget must be > 0");

        bool ok = token.transferFrom(msg.sender, address(this), expectedBudget);
        require(ok, "ACP: token transfer failed");

        j.budget = expectedBudget;
        j.status = Status.Funded;

        emit JobFunded(jobId, msg.sender, expectedBudget);
        _unused(optParams);
    }

    /**
     * @notice Update budget while job is still Open (before funding).
     */
    function setBudget(
        uint256 jobId,
        uint256 amount,
        bytes calldata optParams
    ) external {
        Job storage j = jobs[jobId];
        require(j.client == msg.sender, "ACP: only client");
        require(j.status == Status.Open, "ACP: job not open");
        j.budget = amount;
        emit BudgetSet(jobId, amount);
        _unused(optParams);
    }

    /**
     * @notice Update provider while job is still Open.
     */
    function setProvider(
        uint256 jobId,
        address provider,
        bytes calldata optParams
    ) external {
        Job storage j = jobs[jobId];
        require(j.client == msg.sender, "ACP: only client");
        require(j.status == Status.Open, "ACP: job not open");
        if (j.provider == address(0) && provider != address(0)) {
            _jobsByProvider[provider].push(jobId);
        }
        j.provider = provider;
        emit ProviderSet(jobId, provider);
        _unused(optParams);
    }

    /**
     * @notice Provider submits completed work.
     * @param deliverable  bytes32 hash of the deliverable (e.g. IPFS CID, sha256).
     */
    function submit(
        uint256 jobId,
        bytes32 deliverable,
        bytes calldata optParams
    ) external {
        Job storage j = jobs[jobId];
        require(j.status == Status.Funded, "ACP: job not funded");
        require(j.provider == msg.sender, "ACP: only provider");
        require(block.timestamp <= j.expiredAt, "ACP: job expired");

        j.deliverable = deliverable;
        j.status      = Status.Submitted;

        emit JobSubmitted(jobId, msg.sender, deliverable);
        _unused(optParams);
    }

    /**
     * @notice Evaluator marks job complete and releases USDC to provider.
     * @param reason  bytes32 label for the completion (e.g. "approved").
     */
    function complete(
        uint256 jobId,
        bytes32 reason,
        bytes calldata optParams
    ) external {
        Job storage j = jobs[jobId];
        require(j.status == Status.Submitted, "ACP: job not submitted");
        require(j.evaluator == msg.sender, "ACP: only evaluator");

        uint256 amount = j.budget;
        j.status = Status.Completed;

        if (amount > 0) {
            bool ok = token.transfer(j.provider, amount);
            require(ok, "ACP: payment transfer failed");
            emit PaymentReleased(jobId, j.provider, amount);
        }

        emit JobCompleted(jobId, msg.sender, reason);
        _unused(optParams);
    }

    /**
     * @notice Evaluator or client rejects submitted work. Refunds client.
     */
    function reject(
        uint256 jobId,
        bytes32 reason,
        bytes calldata optParams
    ) external {
        Job storage j = jobs[jobId];
        require(j.status == Status.Submitted, "ACP: job not submitted");
        require(
            msg.sender == j.evaluator || msg.sender == j.client,
            "ACP: only evaluator or client"
        );

        uint256 amount = j.budget;
        j.status = Status.Rejected;

        if (amount > 0) {
            bool ok = token.transfer(j.client, amount);
            require(ok, "ACP: refund transfer failed");
        }

        emit JobRejected(jobId, msg.sender, reason);
        _unused(optParams);
    }

    /**
     * @notice Client reclaims USDC after expiry (job never completed or still funded).
     */
    function claimRefund(uint256 jobId) external {
        Job storage j = jobs[jobId];
        require(j.client == msg.sender, "ACP: only client");
        require(
            j.status == Status.Funded || j.status == Status.Open,
            "ACP: not refundable"
        );
        require(block.timestamp > j.expiredAt, "ACP: not expired yet");

        uint256 amount = j.budget;
        j.budget = 0;
        j.status = Status.Expired;

        if (amount > 0) {
            bool ok = token.transfer(msg.sender, amount);
            require(ok, "ACP: refund transfer failed");
        }

        emit JobExpired(jobId);
    }

    // ─── View functions ───────────────────────────────────────────────────────

    function getJob(uint256 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }

    function getJobCount() external view returns (uint256) {
        return _jobCount;
    }

    function getJobsByClient(address client) external view returns (uint256[] memory) {
        return _jobsByClient[client];
    }

    function getJobsByProvider(address provider) external view returns (uint256[] memory) {
        return _jobsByProvider[provider];
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _unused(bytes calldata) internal pure {}
}
