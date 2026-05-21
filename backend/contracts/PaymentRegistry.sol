// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title  PaymentRegistry — onchain memo emitter for the MPT rail
/// @notice Companion to an ERC-20 transfer. Emits a `Payment` event that
///         carries the offchain join-key (`sessionId`), kind tag, and a
///         metadata URI (typically a URL with Open Graph tags or `ipfs://…`).
///         Designed to be called in the same multisend batch as the
///         underlying `token.transfer(recipient, amount)` so the event and
///         the value transfer share one transaction hash.
/// @dev    Permissionless by design — `Payment` is informational, anyone can
///         emit it. Consumers (feed indexer) MUST validate `sessionId`
///         against their own offchain records before rendering, otherwise
///         the feed is spammable for a fraction of a cent per event.
contract PaymentRegistry {
    /// @param sessionId    Frontend-generated ID (12-char base32 in
    ///                     pay.domovina.ai today), right-padded into
    ///                     bytes32. Decode by trimming trailing zeros.
    /// @param kind         Short ASCII tag right-padded into bytes32 —
    ///                     e.g. "donation", "invoice", "payment", "split".
    /// @param recipient    Final token recipient (post-forward target).
    /// @param sender       `msg.sender` at record time — for the MPT rail,
    ///                     this is the Safe `0x449aBCEf…`.
    /// @param token        ERC-20 contract of the value transfer (EURe today).
    /// @param amount       Token amount in base units (wei for 18-dec EURe).
    /// @param metadataURI  Pointer to renderable metadata; URL or ipfs://.
    ///                     Empty string allowed when no post is attached.
    event Payment(
        bytes32 indexed sessionId,
        bytes32 indexed kind,
        address indexed recipient,
        address sender,
        address token,
        uint256 amount,
        string  metadataURI
    );

    function record(
        bytes32 sessionId,
        bytes32 kind,
        address recipient,
        address token,
        uint256 amount,
        string calldata metadataURI
    ) external {
        emit Payment(sessionId, kind, recipient, msg.sender, token, amount, metadataURI);
    }
}
