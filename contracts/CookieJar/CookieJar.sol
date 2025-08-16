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
    uint256 public constant STREAM_PERIOD = 7 days; // Stream period for withdrawals and balance tracking
    uint256 public constant SCALING_FACTOR = 1500; // Scaling factor for adjustments (15% = 1500 in basis points)

    // Dynamic claim amount variables
    uint256 public windowStartTime; // Start time of current tracking window
    uint256 public windowClaims; // Total amount claimed in current window
    uint256 public dynamicClaimAmount; // Current dynamic claim amount
    uint256 public lastWindowEndBalance; // Balance at the end of the previous window
    uint256 public currentWindowStartBalance; // Balance at the start of the current window

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
        dynamicClaimAmount = 2 ether; // Start with minimum amount (2 UPD)
        lastWindowEndBalance = 0; // Will be updated when window stats are calculated
        currentWindowStartBalance = 0; // Will be updated when window stats are calculated
    }

    /**
     * @notice Initialize the dynamic claim amount based on current balance
     * @dev This should be called after the contract has been funded
     */
    function initializeDynamicClaimAmount() external onlyOwner {
        uint256 currentBalance = token.balanceOf(address(this));
        uint256 maxAmount = currentBalance / 100; // 1% of balance
        uint256 minAmount = 2 ether; // 2 UPD minimum

        // Set initial dynamic claim amount to 1% of current balance, but not less than 2 UPD
        if (maxAmount > minAmount) {
            dynamicClaimAmount = maxAmount;
        } else {
            dynamicClaimAmount = minAmount;
        }

        lastWindowEndBalance = currentBalance;
        currentWindowStartBalance = currentBalance;
        emit DynamicClaimAmountUpdated(dynamicClaimAmount);
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
        // Check if we need to start a new window (weekly, matching claim period)
        if (block.timestamp >= windowStartTime + STREAM_PERIOD) {
            // Store the end balance of the previous window
            uint256 currentBalance = token.balanceOf(address(this));
            lastWindowEndBalance = currentBalance;

            // Adjust dynamic claim amount based on balance change
            adjustClaimAmount();

            // Start new window
            windowStartTime = block.timestamp;
            windowClaims = 0;
            currentWindowStartBalance = token.balanceOf(address(this));
        }
    }

    /**
     * @notice Adjust the dynamic claim amount based on balance change
     * @dev Uses the formula: (b2-b1) / b1) * scalingFactor where b2 is new balance and b1 is old balance
     *      Scaling factor is between 5% and 25% (currently 15%)
     */
    function adjustClaimAmount() internal {
        // Only adjust if we have a valid previous balance
        if (lastWindowEndBalance > 0) {
            uint256 currentBalance = currentWindowStartBalance;

            // Calculate percentage change in balance: (b2-b1) / b1
            // Handle both positive and negative changes
            if (currentBalance > lastWindowEndBalance) {
                // Balance increased
                uint256 increase = currentBalance - lastWindowEndBalance;
                uint256 percentageIncrease = (increase * 10000) / lastWindowEndBalance; // Multiply by 10000 for precision

                // Cap percentage increase at 90%
                if (percentageIncrease > 9000) {
                    percentageIncrease = 9000;
                }

                // Apply scaling factor (15% = 1500 in our scaled representation)
                uint256 scaledIncrease = (percentageIncrease * SCALING_FACTOR) / 10000;

                // Increase claim amount by the scaled percentage
                dynamicClaimAmount = (dynamicClaimAmount * (10000 + scaledIncrease)) / 10000;
            } else if (currentBalance < lastWindowEndBalance) {
                // Balance decreased
                uint256 decrease = lastWindowEndBalance - currentBalance;
                uint256 percentageDecrease = (decrease * 10000) / lastWindowEndBalance; // Multiply by 10000 for precision

                // Cap percentage decrease at 90%
                if (percentageDecrease > 9000) {
                    percentageDecrease = 9000;
                }

                // Apply scaling factor (15% = 1500 in our scaled representation)
                uint256 scaledDecrease = (percentageDecrease * SCALING_FACTOR) / 10000;

                // Decrease claim amount by the scaled percentage
                dynamicClaimAmount = (dynamicClaimAmount * (10000 - scaledDecrease)) / 10000;
            }
            // If balances are equal, no adjustment needed
        }

        // Ensure it stays within reasonable bounds
        uint256 balance = token.balanceOf(address(this));
        uint256 maxAmount = balance / 100; // 1% of balance
        uint256 minAmount = 2 ether; // 2 UPD minimum

        if (dynamicClaimAmount < minAmount) {
            dynamicClaimAmount = minAmount;
        }
        if (dynamicClaimAmount > maxAmount) {
            dynamicClaimAmount = maxAmount;
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

        // Check if contract has enough tokens
        uint256 contractBalance = token.balanceOf(address(this));
        if (contractBalance < 2 ether) {
            revert("empty");
        }
        if (available > contractBalance) {
            available = contractBalance;
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

        // Check if contract has enough tokens
        uint256 contractBalance = token.balanceOf(address(this));
        if (contractBalance < 2 ether) {
            revert("empty");
        }
        if (available > contractBalance) {
            available = contractBalance;
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
