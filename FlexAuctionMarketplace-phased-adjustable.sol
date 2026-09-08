// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC721 {
    function ownerOf(uint256 tokenId) external view returns (address);
    function getApproved(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
}

interface IERC1155 {
    function balanceOf(address account, uint256 id) external view returns (uint256);
}

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data) external returns (bytes4);
}

contract KaysworksMarketplace is IERC721Receiver {
    string public constant name = "kaysworksmarketplace";
    uint256 public constant BPS_DENOMINATOR = 10_000;

    enum AuctionMode {
        Timed,
        Reserve
    }

    enum CustodyMode {
        SellerWallet,
        Escrow
    }

    struct CreateAuctionParams {
        address nftContract;
        uint256 tokenId;
        address gateContract;
        uint256 gateDuration;
        uint256 reservePrice;
        uint256 publicReservePrice;
        uint256 minBidIncrementBps;
        uint256 duration;
        uint256 extensionWindow;
        AuctionMode auctionMode;
        uint256 scheduledStart;
        uint256 maxWaitForReserve;
        uint256 buyNowPrice;
        CustodyMode custodyMode;
    }

    struct Auction {
        address payable seller;
        address nftContract;
        uint256 tokenId;
        address gateContract;
        uint256 gateDuration;
        uint256 reservePrice;
        uint256 publicReservePrice;
        uint256 minBidIncrementBps;
        uint256 duration;
        uint256 extensionWindow;
        AuctionMode auctionMode;
        uint256 scheduledStart;
        uint256 maxWaitForReserve;
        uint256 buyNowPrice;
        CustodyMode custodyMode;
        address operator;
        bool operatorLocked;
        bool deposited;
        bool live;
        bool settled;
        bool cancelled;
        uint256 createdAt;
        uint256 startTime;
        uint256 endTime;
        address payable highestBidder;
        uint256 highestBid;
    }

    uint256 public nextAuctionId = 1;
    address public owner;
    bool public publicAuctionCreation;
    mapping(uint256 => Auction) public auctions;
    mapping(uint256 => uint256[]) private auctionGateTokenIds;
    mapping(address => bool) public approvedSellers;
    uint256 private locked = 1;

    error AlreadyDeposited();
    error AlreadySettled();
    error AuctionAlreadyLive();
    error AuctionEnded();
    error BidTooLow();
    error BuyNowDisabled();
    error BuyNowPriceNotMet();
    error BuyNowUnavailable();
    error InvalidAuction();
    error InvalidConfig();
    error NoBids();
    error NotAuthorized();
    error NotDeposited();
    error NotEligible();
    error NotLive();
    error NotOwner();
    error NotSeller();
    error OperatorAlreadySet();
    error RefundFailed();
    error StillLive();
    error TooEarly();
    error TransferFailed();

    event AuctionCreated(
        uint256 indexed auctionId,
        address indexed seller,
        address indexed nftContract,
        uint256 tokenId,
        CustodyMode custodyMode
    );
    event AuctionStarted(uint256 indexed auctionId, uint256 endTime);
    event NFTDeposited(uint256 indexed auctionId, uint256 scheduledStart);
    event BidPlaced(uint256 indexed auctionId, address indexed bidder, uint256 amount);
    event ReserveActivated(uint256 indexed auctionId, address indexed firstBidder, uint256 amount, uint256 endTime);
    event AuctionExtended(uint256 indexed auctionId, uint256 newEndTime);
    event BuyNowExecuted(uint256 indexed auctionId, address indexed buyer, uint256 price);
    event AuctionSettled(uint256 indexed auctionId, address indexed winner, uint256 amount);
    event AuctionCancelled(uint256 indexed auctionId);
    event OperatorSet(uint256 indexed auctionId, address indexed operator);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event SellerApprovalUpdated(address indexed seller, bool approved);
    event PublicAuctionCreationUpdated(bool enabled);
    event AuctionPricesUpdated(
        uint256 indexed auctionId,
        uint256 reservePrice,
        uint256 publicReservePrice,
        uint256 buyNowPrice
    );

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    modifier nonReentrant() {
        require(locked == 1, "ReentrancyGuard: reentrant call");
        locked = 2;
        _;
        locked = 1;
    }

    modifier auctionExists(uint256 auctionId) {
        if (auctions[auctionId].seller == address(0)) revert InvalidAuction();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function createAuction(
        CreateAuctionParams calldata params,
        uint256[] calldata gateTokenIds
    ) external nonReentrant returns (uint256 auctionId) {
        if (!canCreateAuction(msg.sender)) revert NotAuthorized();
        _validateConfig(params, gateTokenIds);

        auctionId = nextAuctionId++;
        Auction storage a = auctions[auctionId];
        a.seller = payable(msg.sender);
        a.nftContract = params.nftContract;
        a.tokenId = params.tokenId;
        a.gateContract = params.gateContract;
        a.gateDuration = params.gateDuration;
        a.reservePrice = params.reservePrice;
        a.publicReservePrice = params.publicReservePrice == 0 ? params.reservePrice : params.publicReservePrice;
        a.minBidIncrementBps = params.minBidIncrementBps;
        a.duration = params.duration;
        a.extensionWindow = params.extensionWindow;
        a.auctionMode = params.auctionMode;
        a.scheduledStart = params.scheduledStart;
        a.maxWaitForReserve = params.maxWaitForReserve;
        a.buyNowPrice = params.buyNowPrice;
        a.custodyMode = params.custodyMode;
        a.createdAt = block.timestamp;

        for (uint256 i = 0; i < gateTokenIds.length; i++) {
            auctionGateTokenIds[auctionId].push(gateTokenIds[i]);
        }

        if (params.custodyMode == CustodyMode.Escrow) {
            IERC721(params.nftContract).safeTransferFrom(msg.sender, address(this), params.tokenId);
            a.deposited = true;
            emit NFTDeposited(auctionId, params.scheduledStart);
        } else {
            _requireSellerStillControlsNFT(a);
            a.deposited = true;
        }

        if (params.auctionMode == AuctionMode.Timed && _canStart(a)) {
            _startTimedAuction(auctionId, a);
        }

        emit AuctionCreated(auctionId, msg.sender, params.nftContract, params.tokenId, params.custodyMode);
    }

    function canCreateAuction(address seller) public view returns (bool) {
        return publicAuctionCreation || seller == owner || approvedSellers[seller];
    }

    function setApprovedSeller(address seller, bool approved) external onlyOwner {
        if (seller == address(0)) revert InvalidConfig();
        approvedSellers[seller] = approved;
        emit SellerApprovalUpdated(seller, approved);
    }

    function setPublicAuctionCreation(bool enabled) external onlyOwner {
        publicAuctionCreation = enabled;
        emit PublicAuctionCreationUpdated(enabled);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidConfig();
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function depositAuction(uint256 auctionId) external nonReentrant auctionExists(auctionId) {
        Auction storage a = auctions[auctionId];
        if (msg.sender != a.seller) revert NotSeller();
        if (a.custodyMode != CustodyMode.Escrow) revert InvalidConfig();
        if (a.deposited) revert AlreadyDeposited();
        if (a.settled || a.cancelled) revert AlreadySettled();

        IERC721(a.nftContract).safeTransferFrom(msg.sender, address(this), a.tokenId);
        a.deposited = true;
        emit NFTDeposited(auctionId, a.scheduledStart);

        if (a.auctionMode == AuctionMode.Timed && _canStart(a)) {
            _startTimedAuction(auctionId, a);
        }
    }

    function startAuction(uint256 auctionId) external auctionExists(auctionId) {
        Auction storage a = auctions[auctionId];
        if (msg.sender != a.seller) revert NotSeller();
        if (!a.deposited) revert NotDeposited();
        if (a.live) revert AuctionAlreadyLive();
        if (a.settled || a.cancelled) revert AlreadySettled();
        if (a.auctionMode != AuctionMode.Timed) revert InvalidConfig();
        if (!_canStart(a)) revert TooEarly();

        if (a.custodyMode == CustodyMode.SellerWallet) {
            _requireSellerStillControlsNFT(a);
        }

        _startTimedAuction(auctionId, a);
    }

    function bid(uint256 auctionId) external payable nonReentrant auctionExists(auctionId) {
        Auction storage a = auctions[auctionId];
        if (a.settled || a.cancelled) revert AlreadySettled();
        if (!a.deposited) revert NotDeposited();
        if (!isEligible(auctionId, msg.sender)) revert NotEligible();

        if (a.auctionMode == AuctionMode.Timed) {
            if (!a.live) revert NotLive();
            if (block.timestamp >= a.endTime) revert AuctionEnded();
        } else if (!a.live) {
            if (!_canStart(a)) revert TooEarly();
            if (msg.value < minNextBid(auctionId)) revert BidTooLow();
            a.live = true;
            a.startTime = block.timestamp;
            a.endTime = block.timestamp + a.duration;
            emit ReserveActivated(auctionId, msg.sender, msg.value, a.endTime);
        } else if (block.timestamp >= a.endTime) {
            revert AuctionEnded();
        }

        if (msg.value < minNextBid(auctionId)) revert BidTooLow();

        address payable previousBidder = a.highestBidder;
        uint256 previousBid = a.highestBid;
        a.highestBidder = payable(msg.sender);
        a.highestBid = msg.value;

        if (a.endTime > block.timestamp && a.endTime - block.timestamp < a.extensionWindow) {
            a.endTime = block.timestamp + a.extensionWindow;
            emit AuctionExtended(auctionId, a.endTime);
        }

        if (previousBidder != address(0)) {
            _sendValue(previousBidder, previousBid);
        }

        emit BidPlaced(auctionId, msg.sender, msg.value);
    }

    function buyNow(uint256 auctionId) external payable nonReentrant auctionExists(auctionId) {
        Auction storage a = auctions[auctionId];
        if (!buyNowAvailable(auctionId)) revert BuyNowUnavailable();
        if (!_canStart(a)) revert TooEarly();
        if (!isEligible(auctionId, msg.sender)) revert NotEligible();
        if (msg.value < a.buyNowPrice) revert BuyNowPriceNotMet();

        a.settled = true;
        a.live = false;

        address payable previousBidder = a.highestBidder;
        uint256 previousBid = a.highestBid;
        a.highestBidder = payable(msg.sender);
        a.highestBid = a.buyNowPrice;

        _transferNFTToWinner(a, msg.sender);
        _sendValue(a.seller, a.buyNowPrice);

        if (previousBidder != address(0)) {
            _sendValue(previousBidder, previousBid);
        }

        if (msg.value > a.buyNowPrice) {
            _sendValue(payable(msg.sender), msg.value - a.buyNowPrice);
        }

        emit BuyNowExecuted(auctionId, msg.sender, a.buyNowPrice);
        emit AuctionSettled(auctionId, msg.sender, a.buyNowPrice);
    }

    function settle(uint256 auctionId) external nonReentrant auctionExists(auctionId) {
        Auction storage a = auctions[auctionId];
        if (a.settled || a.cancelled) revert AlreadySettled();
        if (!a.live) revert NotLive();
        if (block.timestamp < a.endTime) revert StillLive();
        if (a.highestBidder == address(0)) revert NoBids();

        a.settled = true;
        a.live = false;
        _transferNFTToWinner(a, a.highestBidder);
        _sendValue(a.seller, a.highestBid);

        emit AuctionSettled(auctionId, a.highestBidder, a.highestBid);
    }

    function cancel(uint256 auctionId) external nonReentrant auctionExists(auctionId) {
        Auction storage a = auctions[auctionId];
        if (!_isAuthorized(a)) revert NotAuthorized();
        if (a.settled || a.cancelled) revert AlreadySettled();

        a.cancelled = true;
        a.live = false;
        a.settled = true;

        if (a.highestBidder != address(0)) {
            _sendValue(a.highestBidder, a.highestBid);
        }

        if (a.custodyMode == CustodyMode.Escrow && a.deposited) {
            IERC721(a.nftContract).safeTransferFrom(address(this), a.seller, a.tokenId);
        }

        emit AuctionCancelled(auctionId);
    }

    function setOperator(uint256 auctionId, address operator) external auctionExists(auctionId) {
        Auction storage a = auctions[auctionId];
        if (msg.sender != a.seller) revert NotSeller();
        if (a.operatorLocked) revert OperatorAlreadySet();
        if (a.live || a.settled || a.cancelled) revert InvalidConfig();
        if (operator == address(0)) revert InvalidConfig();

        a.operator = operator;
        a.operatorLocked = true;
        emit OperatorSet(auctionId, operator);
    }

    function updateAuctionPrices(
        uint256 auctionId,
        uint256 reservePrice,
        uint256 publicReservePrice,
        uint256 buyNowPrice
    ) external auctionExists(auctionId) {
        Auction storage a = auctions[auctionId];
        if (msg.sender != a.seller) revert NotSeller();
        if (a.settled || a.cancelled) revert AlreadySettled();
        if (a.highestBidder != address(0) || a.highestBid != 0) revert AuctionAlreadyLive();
        if (reservePrice == 0) revert InvalidConfig();

        uint256 effectivePublicReserve = publicReservePrice == 0 ? reservePrice : publicReservePrice;
        if (effectivePublicReserve < reservePrice) revert InvalidConfig();
        if (buyNowPrice != 0 && buyNowPrice <= effectivePublicReserve) revert InvalidConfig();

        a.reservePrice = reservePrice;
        a.publicReservePrice = effectivePublicReserve;
        a.buyNowPrice = buyNowPrice;

        emit AuctionPricesUpdated(auctionId, reservePrice, effectivePublicReserve, buyNowPrice);
    }

    function auctionState(uint256 auctionId)
        external
        view
        auctionExists(auctionId)
        returns (
            bool deposited,
            bool live,
            bool settled,
            bool cancelled,
            uint256 endTime,
            uint256 timeRemaining,
            address highestBidder,
            uint256 highestBid,
            uint256 nextBid,
            AuctionMode mode,
            bool isOpen,
            uint256 gateEndsAt_,
            bool holderOnly,
            uint256 buyNowPrice,
            bool canBuyNow,
            CustodyMode custodyMode
        )
    {
        Auction storage a = auctions[auctionId];
        uint256 remaining = a.live && block.timestamp < a.endTime ? a.endTime - block.timestamp : 0;
        return (
            a.deposited,
            a.live,
            a.settled,
            a.cancelled,
            a.endTime,
            remaining,
            a.highestBidder,
            a.highestBid,
            minNextBid(auctionId),
            a.auctionMode,
            isPublicPhase(auctionId),
            gateEndsAt(auctionId),
            isHolderOnlyPhase(auctionId),
            a.buyNowPrice,
            buyNowAvailable(auctionId),
            a.custodyMode
        );
    }

    function getGateTokenIds(uint256 auctionId) external view auctionExists(auctionId) returns (uint256[] memory) {
        return auctionGateTokenIds[auctionId];
    }

    function minNextBid(uint256 auctionId) public view auctionExists(auctionId) returns (uint256) {
        Auction storage a = auctions[auctionId];
        if (a.highestBid == 0) return currentReservePrice(auctionId);
        return a.highestBid + ((a.highestBid * a.minBidIncrementBps) / BPS_DENOMINATOR);
    }

    function currentReservePrice(uint256 auctionId) public view auctionExists(auctionId) returns (uint256) {
        Auction storage a = auctions[auctionId];
        return isHolderOnlyPhase(auctionId) ? a.reservePrice : a.publicReservePrice;
    }

    function buyNowAvailable(uint256 auctionId) public view auctionExists(auctionId) returns (bool) {
        Auction storage a = auctions[auctionId];
        if (a.buyNowPrice == 0 || a.settled || a.cancelled || !a.deposited) return false;
        if (!_canStart(a)) return false;
        if (a.highestBid > 0) return false;
        return true;
    }

    function isEligible(uint256 auctionId, address wallet) public view auctionExists(auctionId) returns (bool) {
        Auction storage a = auctions[auctionId];
        if (isPublicPhase(auctionId)) return true;

        uint256[] storage ids = auctionGateTokenIds[auctionId];
        for (uint256 i = 0; i < ids.length; i++) {
            if (IERC1155(a.gateContract).balanceOf(wallet, ids[i]) > 0) return true;
        }
        return false;
    }

    function isPublicPhase(uint256 auctionId) public view auctionExists(auctionId) returns (bool) {
        return !isHolderOnlyPhase(auctionId);
    }

    function isHolderOnlyPhase(uint256 auctionId) public view auctionExists(auctionId) returns (bool) {
        Auction storage a = auctions[auctionId];
        if (a.gateContract == address(0) || a.gateDuration == 0) return false;
        return block.timestamp < gateEndsAt(auctionId);
    }

    function gateEndsAt(uint256 auctionId) public view auctionExists(auctionId) returns (uint256) {
        Auction storage a = auctions[auctionId];
        if (a.gateContract == address(0) || a.gateDuration == 0) return 0;
        uint256 phaseStart = a.startTime;
        if (phaseStart == 0) {
            phaseStart = a.scheduledStart == 0 ? a.createdAt : a.scheduledStart;
        }
        return phaseStart + a.gateDuration;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    function _validateConfig(CreateAuctionParams calldata params, uint256[] calldata gateTokenIds) private pure {
        if (params.nftContract == address(0)) revert InvalidConfig();
        if (params.reservePrice == 0) revert InvalidConfig();
        if (params.duration == 0) revert InvalidConfig();
        if (params.extensionWindow > params.duration) revert InvalidConfig();
        if (uint8(params.auctionMode) > uint8(AuctionMode.Reserve)) revert InvalidConfig();
        if (uint8(params.custodyMode) > uint8(CustodyMode.Escrow)) revert InvalidConfig();
        if (params.publicReservePrice != 0 && params.publicReservePrice < params.reservePrice) revert InvalidConfig();
        uint256 effectivePublicReserve = params.publicReservePrice == 0 ? params.reservePrice : params.publicReservePrice;
        if (params.buyNowPrice != 0 && params.buyNowPrice <= effectivePublicReserve) revert InvalidConfig();
        if (params.gateContract == address(0) && gateTokenIds.length != 0) revert InvalidConfig();
        if (params.gateContract == address(0) && params.gateDuration != 0) revert InvalidConfig();
        if (params.gateContract != address(0) && gateTokenIds.length == 0) revert InvalidConfig();
    }

    function _canStart(Auction storage a) private view returns (bool) {
        return a.scheduledStart == 0 || block.timestamp >= a.scheduledStart;
    }

    function _startTimedAuction(uint256 auctionId, Auction storage a) private {
        a.live = true;
        a.startTime = block.timestamp;
        a.endTime = block.timestamp + a.duration;
        emit AuctionStarted(auctionId, a.endTime);
    }

    function _isAuthorized(Auction storage a) private view returns (bool) {
        return msg.sender == a.seller || (a.operator != address(0) && msg.sender == a.operator);
    }

    function _requireSellerStillControlsNFT(Auction storage a) private view {
        IERC721 nft = IERC721(a.nftContract);
        if (nft.ownerOf(a.tokenId) != a.seller) revert NotSeller();
        if (nft.getApproved(a.tokenId) != address(this) && !nft.isApprovedForAll(a.seller, address(this))) {
            revert NotAuthorized();
        }
    }

    function _transferNFTToWinner(Auction storage a, address winner) private {
        if (a.custodyMode == CustodyMode.SellerWallet) {
            _requireSellerStillControlsNFT(a);
            IERC721(a.nftContract).safeTransferFrom(a.seller, winner, a.tokenId);
        } else {
            IERC721(a.nftContract).safeTransferFrom(address(this), winner, a.tokenId);
        }
    }

    function _sendValue(address payable to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
