// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IBrightID} from "./interfaces/IBrightID.sol";

contract UpdCookieJar is ReentrancyGuard, Pausable, Ownable2Step {
    IERC20 public immutable token; // UPD token
    IBrightID public brightId; // BrightID verifier contract
    bytes32 public brightIdContext; // BrightID context id (bytes32)
    uint256 public constant STREAM_PERIOD = 7 days; // Stream period for withdrawals

    // Streaming state per user
    mapping(address => uint256) public lastStreamClaim; // last stream claim timestamp per address

    event Claimed(address indexed user, uint256 amount);
    event BrightIDUpdated(address indexed verifier, bytes32 context);

    constructor(
        address initialOwner,
        address updToken,
        address brightIdVerifier,
        bytes32 context
    ) Ownable(initialOwner) {
        require(updToken != address(0), "bad token");
        token = IERC20(updToken);
        brightId = IBrightID(brightIdVerifier);
        brightIdContext = context;
    }

    function setBrightID(address brightIdVerifier, bytes32 context) external onlyOwner {
        brightId = IBrightID(brightIdVerifier);
        brightIdContext = context;
        emit BrightIDUpdated(brightIdVerifier, context);
    }

    // Calculate the maximum withdrawable amount for a user based on streaming
    function streamBalance(address user) public view returns (uint256) {
        // Calculate the maximum amount that can be streamed over 7 days
        uint256 bal = token.balanceOf(address(this));
        require(bal >= 2 ether, "empty");
        uint256 maxStreamAmount = bal / 100; // 1%
        // Use the greater of 1% or 2 UPD tokens (2 * 10^18 wei)
        if (maxStreamAmount < 2 ether) {
            maxStreamAmount = 2 ether;
        }
        // But don't exceed the available balance
        if (maxStreamAmount > bal) {
            maxStreamAmount = bal;
        }

        // Get the last claim time
        uint256 lastClaim = lastStreamClaim[user];

        // If last claim was more than STREAM_PERIOD ago, the user can withdraw the full amount again
        if (block.timestamp >= lastClaim + STREAM_PERIOD) {
            return maxStreamAmount;
        }

        // Calculate how much should be available based on time passed
        uint256 timePassed = block.timestamp - lastClaim;
        uint256 streamableAmount = (maxStreamAmount * timePassed) / STREAM_PERIOD;

        return streamableAmount;
    }

    function claim() external nonReentrant whenNotPaused {
        // Eligibility: BrightID verification
        require(brightId.isVerified(msg.sender), "not BrightID verified");

        // Calculate available stream balance
        uint256 available = streamBalance(msg.sender);
        require(available > 0, "no available funds");

        // Update stream state
        lastStreamClaim[msg.sender] = block.timestamp;

        require(token.transfer(msg.sender, available), "transfer failed");

        emit Claimed(msg.sender, available);
    }

    function verifyAndClaim(uint _timestamp, uint8 _v, bytes32 _r, bytes32 _s) external nonReentrant whenNotPaused {
        // Eligibility: BrightID verification
        require(brightId.verify(msg.sender, _timestamp, _v, _r, _s), "not BrightID verified");

        // Calculate available stream balance
        uint256 available = streamBalance(msg.sender);
        require(available > 0, "no available funds");

        // Update stream state
        lastStreamClaim[msg.sender] = block.timestamp;

        require(token.transfer(msg.sender, available), "transfer failed");

        emit Claimed(msg.sender, available);
    }

    // Admin controls
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // Optional: rescue tokens accidentally sent to the jar (excluding UPD if you want strictness)
    function sweep(address erc20, address to) external onlyOwner {
        require(erc20 != address(token), "no sweep UPD");
        IERC20 t = IERC20(erc20);
        t.transfer(to, t.balanceOf(address(this)));
    }
}
