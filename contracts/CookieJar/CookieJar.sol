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

    // Dynamic claim amount variables
    uint256 public windowStartTime; // Start time of current tracking window
    uint256 public windowClaims; // Total amount claimed in current window
    int256 public previousWindowNetChange; // Net balance change in previous window
    uint256 public dynamicClaimAmount; // Current dynamic claim amount
    uint256 public lastBalance; // Last recorded balance for comparison

    // Streaming state per user
    mapping(address => uint256) public lastStreamClaim; // last stream claim timestamp per address

    event Claimed(address indexed user, uint256 amount);
    event BrightIDUpdated(address indexed verifier, bytes32 context);
    event DynamicClaimAmountUpdated(uint256 newAmount);

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

        // Initialize dynamic claim amount variables
        windowStartTime = block.timestamp;
        windowClaims = 0;
        previousWindowNetChange = 0;
        dynamicClaimAmount = 2 ether; // Start with minimum amount
        lastBalance = token.balanceOf(address(this));
    }

    function setBrightID(address brightIdVerifier, bytes32 context) external onlyOwner {
        brightId = IBrightID(brightIdVerifier);
        brightIdContext = context;
        emit BrightIDUpdated(brightIdVerifier, context);
    }

    /**
     * @notice Update window statistics and adjust claim amount if needed
     */
    function updateWindowStats() internal {
        // Check if we need to start a new window (e.g., every 24 hours)
        if (block.timestamp >= windowStartTime + 24 hours) {
            // Calculate net change in previous window
            uint256 currentBalance = token.balanceOf(address(this));
            int256 netChange = int256(currentBalance) - int256(lastBalance) - int256(windowClaims);
            previousWindowNetChange = netChange;

            // Update last balance
            lastBalance = currentBalance;

            // Start new window
            windowStartTime = block.timestamp;
            windowClaims = 0;

            // Adjust dynamic claim amount based on net change
            adjustClaimAmount();
        }
    }

    /**
     * @notice Adjust the dynamic claim amount based on previous window performance
     */
    function adjustClaimAmount() internal {
        // Simple algorithm - you could make this more sophisticated
        if (previousWindowNetChange < 0) {
            // Net decrease - reduce claim amount
            dynamicClaimAmount = (dynamicClaimAmount * 90) / 100; // Reduce by 10%
        } else if (previousWindowNetChange > 0) {
            // Net increase - could increase claim amount
            dynamicClaimAmount = (dynamicClaimAmount * 105) / 100; // Increase by 5%
        }

        // Ensure it stays within reasonable bounds
        uint256 balance = token.balanceOf(address(this));
        if (dynamicClaimAmount < 2 ether) {
            dynamicClaimAmount = 2 ether;
        }
        if (dynamicClaimAmount > balance / 10) {
            dynamicClaimAmount = balance / 10;
        }

        emit DynamicClaimAmountUpdated(dynamicClaimAmount);
    }

    /**
     * @notice Get the current dynamic claim amount
     * @return The current dynamic claim amount
     */
    function getDynamicClaimAmount() external view returns (uint256) {
        return dynamicClaimAmount;
    }

    // Calculate the maximum withdrawable amount for a user based on streaming
    function streamBalance(address user) public view returns (uint256) {
        // Use the dynamic claim amount
        uint256 maxStreamAmount = dynamicClaimAmount;

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

        // Update window statistics
        updateWindowStats();

        // Calculate available stream balance
        uint256 available = streamBalance(msg.sender);
        require(available > 0, "no available funds");

        // Ensure available doesn't exceed dynamic claim amount
        if (available > dynamicClaimAmount) {
            available = dynamicClaimAmount;
        }

        // Track this claim
        windowClaims += available;

        // Update stream state
        lastStreamClaim[msg.sender] = block.timestamp;

        require(token.transfer(msg.sender, available), "transfer failed");

        emit Claimed(msg.sender, available);
    }

    function verifyAndClaim(uint _timestamp, uint8 _v, bytes32 _r, bytes32 _s) external nonReentrant whenNotPaused {
        // Eligibility: BrightID verification
        require(brightId.verify(msg.sender, _timestamp, _v, _r, _s), "not BrightID verified");

        // Update window statistics
        updateWindowStats();

        // Calculate available stream balance
        uint256 available = streamBalance(msg.sender);
        require(available > 0, "no available funds");

        // Ensure available doesn't exceed dynamic claim amount
        if (available > dynamicClaimAmount) {
            available = dynamicClaimAmount;
        }

        // Track this claim
        windowClaims += available;

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

    /**
     * @notice Manually update window statistics and adjust claim amount
     * @dev This function can be called by anyone to update the system
     */
    function updateWindowAndAdjustClaim() external {
        updateWindowStats();
    }
}
