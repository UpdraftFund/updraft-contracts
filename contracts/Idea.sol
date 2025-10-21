// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ICrowdFund} from "./interfaces/ICrowdFund.sol";

    struct Cycle {
        uint256 number;
        uint256 shares;
        uint256 fees;
        bool hasContributions;
    }

    struct Position {
        uint256 startCycleIndex;
        uint256 tokens;
    }

contract Idea {
    using SafeERC20 for IERC20;

    ICrowdFund public immutable crowdFund;
    IERC20 public immutable token;
    uint256 public immutable startTime;
    uint256 public immutable cycleLength;
    uint256 public immutable contributorFee;
    uint256 public immutable accrualRate;
    uint256 public immutable percentScale;
    uint256 public immutable minFee;
    uint256 public immutable percentFee;
    address public immutable faucet;

    /// @notice The total number of tokens in this Choice.
    /// @dev This should equal balanceOf(address(this)),
    /// but we don't want to have to repeatedly call the token contract, so we keep track internally.
    uint256 public tokens;
    uint256 public contributorFees;

    Cycle[] public cycles;

    /// Addresses can contribute multiple times to the same choice, so we use an array of Positions.
    /// The index of a Position in this array is used in checkPosition(), withdraw(), split(), and
    /// transferPositions() and is returned by contribute().
    mapping(address => Position[]) public positionsByAddress;

    event Withdrew(
        address indexed addr,
        uint256 positionIndex,
        uint256 amount,
        uint256 shares,
        uint256 totalShares,
        uint256 totalTokens
    );
    event Contributed(
        address indexed addr,
        uint256 positionIndex,
        uint256 amount,
        uint256 totalShares,
        uint256 totalTokens,
        bool indexed isAirdrop
    );
    event PositionTransferred(
        address indexed sender,
        address indexed recipient,
        uint256 senderPositionIndex,
        uint256 recipientPositionIndex,
        uint256 contribution
    );
    event Split(
        address indexed addr,
        uint256 originalPositionIndex,
        uint256 numNewPositions,
        uint256 firstNewPositionIndex,
        uint256 contributionPerNewPosition,
        uint256 contributionLeftInOriginal
    );

    error ContributorFeeOverOneHundredPercent();
    error ContributionLessThanMinFee(uint256 contribution, uint256 minFee);
    error PositionDoesNotExist();
    error NotOnlyPosition();
    error SplitAmountMoreThanPosition(uint256 amount, uint256 positionAmount);
    error CannotAirdropInFirstCycle();

    modifier singlePosition(address addr) {
        uint256 positions = numPositions(addr);

        if (positions == 0) {
            revert PositionDoesNotExist();
        }

        if (positions > 1) {
            revert NotOnlyPosition();
        }

        _;
    }

    modifier positionExists(address addr, uint256 positionIndex) {
        Position[] storage positions = positionsByAddress[addr];

        unchecked {
            if (positionIndex + 1 > positions.length) revert PositionDoesNotExist();
        }

        Position storage position = positions[positionIndex];

        if (position.tokens == 0) revert PositionDoesNotExist();

        _;
    }

    constructor(uint256 contributorFee_, address faucet_) {
        crowdFund = ICrowdFund(msg.sender);
        startTime = block.timestamp;

        contributorFee = contributorFee_;
        faucet = faucet_;

        cycleLength = crowdFund.cycleLength();
        accrualRate = crowdFund.accrualRate();
        token = crowdFund.feeToken();
        percentScale = crowdFund.percentScale();
        minFee = crowdFund.minFee();
        percentFee = crowdFund.percentFee();
        contributorFees = 0;

        if (contributorFee > percentScale) {
            revert ContributorFeeOverOneHundredPercent();
        }
    }

    /// Check the number of tokens and shares for an address with only one position.
    function checkPosition(
        address addr
    ) external view singlePosition(addr) returns (uint256 positionTokens, uint256 shares) {
        return checkPosition(addr, 0);
    }

    /// @return positionIndex will be reused as input to withdraw(), checkPosition(), and other functions
    function contribute(uint256 amount) external returns (uint256 positionIndex) {
        if (amount < minFee) revert ContributionLessThanMinFee(amount, minFee);

        address addr = msg.sender;
        uint256 originalAmount = amount;

        // Anti-spam fee
        uint256 fee;
        uint256 _contributorFee;
        uint256 lastStoredCycleIndex;

        unchecked {
            fee = max(minFee, amount * percentFee / percentScale);
            amount -= fee;

            _contributorFee = amount * contributorFee / percentScale;

            updateCyclesWithFee(_contributorFee);

            tokens += amount;

        // updateCyclesWithFee() will always add a cycle if none exists
            lastStoredCycleIndex = cycles.length - 1;

            if (lastStoredCycleIndex > 0) {
                // Contributor fees are only charged in cycles after the one in which the first contribution was made.
                amount -= _contributorFee;

                // Track the contributor fees
                contributorFees += _contributorFee;
            }
        }

        positionsByAddress[addr].push(Position({startCycleIndex: lastStoredCycleIndex, tokens: amount}));

        unchecked {
            positionIndex = positionsByAddress[addr].length - 1;
        }

        token.safeTransferFrom(addr, address(this), originalAmount);
        token.safeTransfer(faucet, fee);

        emit Contributed(addr, positionIndex, originalAmount, totalShares(), tokens, false);
    }

    /// @notice Donates to past contributors with no expectation of return
    /// @dev The entire contribution (minus anti-spam fee) is counted as a contributor fee
    /// @param amount The amount to airdrop
    function airdrop(uint256 amount) external {
        if (amount < minFee) revert ContributionLessThanMinFee(amount, minFee);

        if (cycles.length <= 1) {
            revert CannotAirdropInFirstCycle();
        }

        address addr = msg.sender;
        uint256 originalAmount = amount;

        // Anti-spam fee
        uint256 fee;
        uint256 lastStoredCycleIndex;

        unchecked {
            fee = max(minFee, amount * percentFee / percentScale);
            amount -= fee;

        // The entire amount (minus anti-spam fee) is counted as contributor fee
            uint256 _contributorFee = amount;

        // Update cycles with the amount as a contribution and the entire amount as contributor fee
            updateCyclesWithFee(_contributorFee);

            tokens += amount;
            contributorFees += _contributorFee;

        // updateCyclesAddingAmount() will always add a cycle if none exists
            lastStoredCycleIndex = cycles.length - 1;
        }

        // Create a position with 0 tokens (donation with no expectation of return)
        positionsByAddress[addr].push(Position({startCycleIndex: lastStoredCycleIndex, tokens: 0}));

        uint256 positionIndex;
        unchecked {
            positionIndex = positionsByAddress[addr].length - 1;
        }

        token.safeTransferFrom(addr, address(this), originalAmount);
        token.safeTransfer(faucet, fee);

        emit Contributed(addr, positionIndex, originalAmount, totalShares(), tokens, true);
    }

    /// Withdraw the only position
    function withdraw() external singlePosition(msg.sender) {
        withdraw(0);
    }

    /// Transfer the only position
    function transferPosition(address recipient) external singlePosition(msg.sender) {
        transferPosition(recipient, 0);
    }

    /// @param recipient the recipient of all the positions to be transferred.
    /// @param positionIndexes an array of the position indexes that should be transferred.
    /// A position index is the number returned by contribute() when creating the position.
    function transferPositions(address recipient, uint256[] calldata positionIndexes) external {
        uint256 lastIndex;

        unchecked {
            lastIndex = positionIndexes.length - 1;

            for (uint256 i; i <= lastIndex; ++i) {
                transferPosition(recipient, positionIndexes[i]);
            }
        }
    }

    /// Split the position equally into numSplits positions.
    function split(uint256 positionIndex, uint256 numSplits) external {
        Position storage position = positionsByAddress[msg.sender][positionIndex];
        split(positionIndex, numSplits - 1, position.tokens / numSplits);
    }

    /// @return The number of shares all contributors hold in this choice.
    /// The total shares can be compared between two choices to see which has more support.
    function totalShares() public view returns (uint256) {
        return cycles[cycles.length - 1].shares + pendingShares(currentCycleNumber(), tokens - contributorFees);
    }

    function currentCycleNumber() public view returns (uint256) {
        unchecked {
            return (block.timestamp - startTime) / cycleLength;
        }
    }

    function numPositions(address addr) public view returns (uint256) {
        return positionsByAddress[addr].length;
    }

    /// @param positionIndex The positionIndex returned by the contribute() function.
    function checkPosition(
        address addr,
        uint256 positionIndex
    ) public view positionExists(addr, positionIndex) returns (uint256 positionTokens, uint256 shares) {
        (positionTokens, shares) = positionToLastStoredCycle(addr, positionIndex);
        shares += pendingShares(currentCycleNumber(), positionsByAddress[addr][positionIndex].tokens);
    }

    /// @param positionIndex The positionIndex returned by the contribute() function.
    function withdraw(uint256 positionIndex) public positionExists(msg.sender, positionIndex) {
        address addr = msg.sender;
        uint256 originalPosition = positionsByAddress[addr][positionIndex].tokens;

        // Insert a new cycle to checkpoint all contributions until now.
        updateCyclesWithFee(0);

        (uint256 positionTokens, uint256 shares) = positionToLastStoredCycle(addr, positionIndex);
        uint256 feesEarned = positionTokens - originalPosition;

        // Cap fees earned to prevent underflow
        if (feesEarned > contributorFees) {
            feesEarned = contributorFees;
            positionTokens = originalPosition + feesEarned;
        }

        delete positionsByAddress[addr][positionIndex];

        uint256 lastStoredCycleIndex;

        unchecked {
            lastStoredCycleIndex = cycles.length - 1;
            cycles[lastStoredCycleIndex].shares -= shares;
            tokens -= positionTokens;
            contributorFees -= feesEarned;
        }

        token.safeTransfer(addr, positionTokens);

        emit Withdrew(addr, positionIndex, positionTokens, shares, totalShares(), tokens);
    }

    /// @param positionIndex The positionIndex returned by the contribute() function.
    function transferPosition(
        address recipient,
        uint256 positionIndex
    ) public positionExists(msg.sender, positionIndex) {
        address sender = msg.sender;

        Position[] storage fromPositions = positionsByAddress[sender];
        Position[] storage toPositions = positionsByAddress[recipient];
        uint256 contribution = fromPositions[positionIndex].tokens;

        toPositions.push(fromPositions[positionIndex]);
        delete fromPositions[positionIndex];

        uint256 recipientPositionIndex;

        unchecked {
            recipientPositionIndex = toPositions.length - 1;
        }

        emit PositionTransferred(sender, recipient, positionIndex, recipientPositionIndex, contribution);
    }

    /// Create numSplits new positions each containing amount tokens. Tokens to create the splits will be taken
    /// from the position at positionIndex.
    function split(
        uint256 positionIndex,
        uint256 numSplits,
        uint256 amount
    ) public positionExists(msg.sender, positionIndex) {
        address addr = msg.sender;
        Position[] storage positions = positionsByAddress[addr];
        Position storage position = positions[positionIndex];

        uint256 deductAmount = amount * numSplits;
        if (deductAmount > position.tokens) revert SplitAmountMoreThanPosition(deductAmount, position.tokens);

        unchecked {
            position.tokens -= deductAmount;
        }

        uint256 firstNewPositionIndex;

        unchecked {
            for (uint256 i = 1; i <= numSplits; ++i) {
                positions.push(Position({startCycleIndex: position.startCycleIndex, tokens: amount}));
            }

            firstNewPositionIndex = positions.length - numSplits;
        }

        emit Split(addr, positionIndex, numSplits, firstNewPositionIndex, amount, position.tokens);
    }

    /// @param _tokens The token amount used to compute shares--either from the choice, or an individual position.
    /// @param _cycleNumber The cycle number to compute shares for.
    /// @return The number of shares that have not been added to the last stored cycle.
    /// These will be added to the last stored cycle when updateCyclesAddingAmount() is next called.
    function pendingShares(uint256 _cycleNumber, uint256 _tokens) public view returns (uint256) {
        Cycle storage lastStoredCycle;

        unchecked {
            lastStoredCycle = cycles[cycles.length - 1];
            return (accrualRate * (_cycleNumber - lastStoredCycle.number) * _tokens) / percentScale;
        }
    }

    function positionToLastStoredCycle(
        address addr,
        uint256 positionIndex
    ) internal view returns (uint256 positionTokens, uint256 shares) {
        Position storage position = positionsByAddress[addr][positionIndex];

        positionTokens = position.tokens;
        uint256 originalTokens = positionTokens;

        uint256 loopIndex;
        uint256 firstCycleNumber = cycles[position.startCycleIndex].number;
        uint256 lastStoredCycleIndex;

        unchecked {
        // updateCyclesWithFee() will always add a cycle if none exists
            lastStoredCycleIndex = cycles.length - 1;
            loopIndex = position.startCycleIndex + 1; // can't realistically overflow
        }

        for (uint256 i = loopIndex; i <= lastStoredCycleIndex;) {
            Cycle storage cycle = cycles[i];

            unchecked {
            // Calculate shares for this cycle based on the original tokens
                shares = accrualRate * (cycle.number - firstCycleNumber) * originalTokens / percentScale;

                positionTokens += (cycle.fees * shares) / cycle.shares;

                ++i;
            }
        }
    }

    function updateCyclesWithFee(uint256 _contributorFee) internal {
        uint256 currentCycleNumber_;
        uint256 length;

        unchecked {
            currentCycleNumber_ = currentCycleNumber();
            length = cycles.length;
        }

        if (length == 0) {
            // Create the first cycle in the array using the first contribution.
            cycles.push(Cycle({number: currentCycleNumber_, shares: 0, fees: 0, hasContributions: true}));
        } else {
            // Not the first contribution.
            uint256 lastStoredCycleIndex;

            unchecked {
                lastStoredCycleIndex = length - 1;
            }

            Cycle storage lastStoredCycle = cycles[lastStoredCycleIndex];
            uint256 lastStoredCycleNumber = lastStoredCycle.number;

            if (lastStoredCycleNumber == currentCycleNumber_) {
                // The first cycle doesn't charge contributor fees.
                if (lastStoredCycleIndex != 0) {
                    unchecked {
                        lastStoredCycle.fees += _contributorFee;
                        lastStoredCycle.hasContributions = lastStoredCycle.fees > 0;
                    }
                }
            } else {
                // Some cycle numbers might be skipped, so we need to accrue shares in between.
                uint256 newShares;
                unchecked {
                    newShares = lastStoredCycle.shares + accrualRate * (currentCycleNumber_ - lastStoredCycleNumber)
                        * (tokens - contributorFees)
                        / percentScale;
                }

                Cycle memory newCycle = Cycle({
                    number: currentCycleNumber_,
                    shares: newShares,
                    fees: _contributorFee,
                    hasContributions: _contributorFee > 0
                });
                // We're only interested in adding cycles that have contributions, since we store
                // cycles to compute fees at withdrawal time.
                if (lastStoredCycle.hasContributions) {
                    // Keep cycles with contributions.
                    cycles.push(newCycle); // Push our new cycle in front.
                } else {
                    // If the previous cycle only has withdrawals (no contributions), overwrite it with the current one.
                    cycles[lastStoredCycleIndex] = newCycle;
                }
            } // end else (Add a new cycle...)
        } // end else (Not the first contribution.)
    }

    function max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }
}
