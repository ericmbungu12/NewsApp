// project/minorproject/news-blockchain/contracts/NewsProvenance

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract NewsProvenance {
    // Structure to store article verification data
    struct ArticleRecord {
        bytes32 contentHash;      // SHA-256 hash of article content
        address publisher;        // Wallet address of publisher
        uint256 timestamp;        // Time of registration
        bool isVerified;          // AI/Community verification status
        string metadataURI;       // Optional: IPFS link to metadata
    }
    
    // Mapping: contentHash Ã¢â€ â€™ ArticleRecord
    mapping(bytes32 => ArticleRecord) public articles;
    
    // Mapping: publisher address Ã¢â€ â€™ reputation score
    mapping(address => uint256) public publisherReputation;
    
    // Events for off-chain indexing
    event ArticleRegistered(bytes32 indexed contentHash, address publisher, uint256 timestamp);
    event ArticleVerified(bytes32 indexed contentHash, bool status);
    event ReputationUpdated(address indexed publisher, uint256 newScore);

    // Register a new article hash on-chain
    function registerArticle(
        bytes32 _contentHash,
        string calldata _metadataURI
    ) external {
        // Prevent duplicate registration
        require(articles[_contentHash].timestamp == 0, "Article already registered");
        
        // Store article record
        articles[_contentHash] = ArticleRecord({
            contentHash: _contentHash,
            publisher: msg.sender,
            timestamp: block.timestamp,
            isVerified: true,
            metadataURI: _metadataURI
        });
        
        // Increment publisher reputation
        publisherReputation[msg.sender] += 1;
        
        emit ArticleRegistered(_contentHash, msg.sender, block.timestamp);
        emit ReputationUpdated(msg.sender, publisherReputation[msg.sender]);
    }
    
    // Verify an article (only authorized verifiers)
    function verifyArticle(bytes32 _contentHash, bool _status) external {
        require(articles[_contentHash].timestamp != 0, "Article not found");
        articles[_contentHash].isVerified = _status;
        emit ArticleVerified(_contentHash, _status);
    }
    
    // Check if article exists and get basic info
    function checkArticle(bytes32 _contentHash) external view returns (
        bool exists,
        uint256 registeredAt,
        bool verified,
        address publisher
    ) {
        ArticleRecord storage a = articles[_contentHash];
        return (a.timestamp > 0, a.timestamp, a.isVerified, a.publisher);
    }
    
    // Get publisher reputation
    function getPublisherReputation(address _publisher) external view returns (uint256) {
        return publisherReputation[_publisher];
    }
}