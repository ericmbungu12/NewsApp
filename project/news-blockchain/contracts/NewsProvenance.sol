// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// project/minorproject/news-blockchain/contracts/NewsProvenance.sol

contract NewsProvenance {

    // ── Storage ───────────────────────────────────────────────────────────

    struct ArticleRecord {
        bytes32 contentHash;   // SHA-256 hash of article content
        address publisher;     // wallet that registered this article
        uint256 timestamp;     // block time of registration
        bool    isVerified;    // set to true only by an authorised verifier
        string  metadataURI;   // optional IPFS link
    }

    // contentHash → record
    mapping(bytes32 => ArticleRecord) public articles;

    // publisher address → reputation score (increments on each registration)
    mapping(address => uint256) public publisherReputation;

    // wallet address → is this wallet allowed to verify articles?
    mapping(address => bool) public verifiers;

    // contract deployer — only they can add/remove verifier wallets
    address public owner;

    // ── Events ────────────────────────────────────────────────────────────

    event ArticleRegistered(
        bytes32 indexed contentHash,
        address indexed publisher,
        uint256 timestamp
    );
    event ArticleVerified(
        bytes32 indexed contentHash,
        address indexed verifier,
        bool status
    );
    event VerifierUpdated(
        address indexed wallet,
        bool status
    );
    event ReputationUpdated(
        address indexed publisher,
        uint256 newScore
    );

    // ── Modifiers ─────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "NewsProvenance: caller is not owner");
        _;
    }

    modifier onlyVerifier() {
        require(verifiers[msg.sender], "NewsProvenance: caller is not a verifier");
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────

    constructor() {
        owner = msg.sender;
        // Owner wallet is also a verifier by default
        verifiers[msg.sender] = true;
        emit VerifierUpdated(msg.sender, true);
    }

    // ── Owner functions ───────────────────────────────────────────────────

    // Add or remove a verifier wallet.
    // Call this once with your second wallet address after deploying.
    // This is a write — costs gas — but only called once per wallet.
    function setVerifier(address _wallet, bool _status) external onlyOwner {
        require(_wallet != address(0), "NewsProvenance: zero address");
        verifiers[_wallet] = _status;
        emit VerifierUpdated(_wallet, _status);
    }

    // Transfer ownership to a new address if needed.
    function transferOwnership(address _newOwner) external onlyOwner {
        require(_newOwner != address(0), "NewsProvenance: zero address");
        owner = _newOwner;
    }

    // ── Registration — called by your registrar wallet ────────────────────

    // Register a single article.
    // isVerified starts as FALSE — a verifier must separately confirm it.
    function registerArticle(
        bytes32 _contentHash,
        string calldata _metadataURI
    ) external {
        require(
            articles[_contentHash].timestamp == 0,
            "NewsProvenance: article already registered"
        );

        articles[_contentHash] = ArticleRecord({
            contentHash: _contentHash,
            publisher:   msg.sender,
            timestamp:   block.timestamp,
            isVerified:  false,          // ← fixed: starts false, not true
            metadataURI: _metadataURI
        });

        publisherReputation[msg.sender] += 1;

        emit ArticleRegistered(_contentHash, msg.sender, block.timestamp);
        emit ReputationUpdated(msg.sender, publisherReputation[msg.sender]);
    }

    // Register multiple articles in one transaction.
    // Skips duplicates silently so a partial batch never reverts entirely.
    function registerBatch(
        bytes32[] calldata _hashes,
        string[]  calldata _metadataURIs
    ) external {
        require(
            _hashes.length == _metadataURIs.length,
            "NewsProvenance: length mismatch"
        );
        require(_hashes.length <= 50, "NewsProvenance: batch too large");

        for (uint256 i = 0; i < _hashes.length; i++) {
            // Skip already-registered — don't revert the whole batch
            if (articles[_hashes[i]].timestamp != 0) continue;

            articles[_hashes[i]] = ArticleRecord({
                contentHash: _hashes[i],
                publisher:   msg.sender,
                timestamp:   block.timestamp,
                isVerified:  false,      // ← starts false
                metadataURI: _metadataURIs[i]
            });

            emit ArticleRegistered(_hashes[i], msg.sender, block.timestamp);
        }

        publisherReputation[msg.sender] += _hashes.length;
        emit ReputationUpdated(msg.sender, publisherReputation[msg.sender]);
    }

    // ── Verification — called by your verifier wallet ─────────────────────

    // Verify a single article.
    // Only wallets added via setVerifier() can call this.
    function verifyArticle(
        bytes32 _contentHash,
        bool    _status
    ) external onlyVerifier {
        require(
            articles[_contentHash].timestamp != 0,
            "NewsProvenance: article not found"
        );
        articles[_contentHash].isVerified = _status;
        emit ArticleVerified(_contentHash, msg.sender, _status);
    }

    // Verify multiple articles in one transaction.
    // This is what your VERIFIER_PRIVATE_KEY wallet calls after registration.
    // Skips hashes that don't exist — never reverts the whole batch.
    function verifyBatch(
        bytes32[] calldata _hashes
    ) external onlyVerifier {
        require(_hashes.length <= 50, "NewsProvenance: batch too large");

        for (uint256 i = 0; i < _hashes.length; i++) {
            if (articles[_hashes[i]].timestamp == 0) continue; // skip unknown
            articles[_hashes[i]].isVerified = true;
            emit ArticleVerified(_hashes[i], msg.sender, true);
        }
    }

    // ── Read functions — all free (view) ──────────────────────────────────

    // Check a single article.
    function checkArticle(bytes32 _contentHash) external view returns (
        bool    exists,
        uint256 registeredAt,
        bool    verified,
        address publisher
    ) {
        ArticleRecord storage a = articles[_contentHash];
        return (a.timestamp > 0, a.timestamp, a.isVerified, a.publisher);
    }

    // Check multiple articles in one call.
    // Returns parallel arrays — index 0 of each array = same article.
    function checkBatch(
        bytes32[] calldata _hashes
    ) external view returns (
        bool[]    memory exists,
        bool[]    memory verified,
        address[] memory publishers
    ) {
        exists     = new bool[]   (_hashes.length);
        verified   = new bool[]   (_hashes.length);
        publishers = new address[](_hashes.length);

        for (uint256 i = 0; i < _hashes.length; i++) {
            ArticleRecord storage a = articles[_hashes[i]];
            exists[i]     = a.timestamp > 0;
            verified[i]   = a.isVerified;
            publishers[i] = a.publisher;
        }
    }

    // Get publisher reputation score.
    function getPublisherReputation(
        address _publisher
    ) external view returns (uint256) {
        return publisherReputation[_publisher];
    }

    // Check if a wallet is an authorised verifier.
    function isVerifier(address _wallet) external view returns (bool) {
        return verifiers[_wallet];
    }
}