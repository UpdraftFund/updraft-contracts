// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import {ICrowdFund} from "./interfaces/ICrowdFund.sol";

struct Cycle {
    uint256 number;
    uint256 shares;
    uint256 fees;
    bool hasContributions;
}

struct Position {
    uint256 contribution;
    uint256 contributionTime;
    uint256 startCycleIndex;
    uint256 lastCollectedCycleIndex;
    bool refunded;
}

contract Solution is Ownable {
    using SafeERC20 for IERC20;

    ICrowdFund public immutable crowdFund;
    IERC20 public immutable fundingToken;
    IERC20 public immutable stakingToken;
    uint256 public immutable startTime;
    uint256 public immutable cycleLength;
    uint256 public immutable accrualRate;
    uint256 public immutable percentScale;
    uint256 public immutable contributorFee;

    uint256 public tokensContributed;
    uint256 public tokensWithdrawn;
    uint256 public stake;
    uint256 public fundingGoal;
    uint256 public deadline;
    uint256 public goalExtendedTime;

    Cycle[] public cycles;

    /// Addresses can contribute multiple times to the same choice, so we use an array of Positions.
    /// The index of a Position in this array is used in checkPosition(), collectFees(), split(), and
    /// transferPositions() and is returned by contribute().
    mapping(address => Position[]) public positionsByAddress;

    mapping(address => uint256) public stakes;

    event FeesCollected(address indexed addr, uint256 positionIndex, uint256 amount);
    event FundsWithdrawn(address to, uint256 amount, uint256 tokensLeft);
    event StakeUpdated(address indexed addr, uint256 stake, uint256 totalStake);

    /// @param newStake The new total stake amount for the `to` address
    event StakeTransferred(address indexed from, address indexed to, uint256 sent, uint256 newStake);
    event Refunded(address indexed addr, uint256 positionIndex, uint256 amount, uint256 stakeCollected);
    event SolutionUpdated(bytes data);
    event GoalExtended(uint256 goal, uint256 deadline);
    event Contributed(
        address indexed addr,
        uint256 positionIndex,
        uint256 amount,
        uint256 totalShares,
        uint256 totalContributed,
        uint256 totalTokens,
        address[] dependencyAddresses,
        uint256[] dependencyChainIds,
        uint256[] dependencyAmounts
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
    error PositionDoesNotExist();
    error NotOnlyPosition();
    error SplitAmountMoreThanPosition(uint256 amount, uint256 positionAmount);
    error GoalNotReached(uint256 contributed, uint256 goal);
    error GoalFailed();
    error GoalNotFailed();
    error GoalMustIncrease(uint256 oldGoal, uint256 newGoal);
    error MustSetDeadlineInFuture(uint256 deadline);
    error WithdrawMoreThanAvailable(uint256 amount, uint256 available);
    error AlreadyRefunded();
    error ContributedBeforeGoalExtended(uint256 contributedTime, uint256 goalExtendedTime);
    error InvalidDependencyData();

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

        _;
    }

    modifier goalReached {
        if (tokensContributed < fundingGoal) revert GoalNotReached(tokensContributed, fundingGoal);

        _;
    }

    constructor(
        address owner,
        IERC20 fundingToken_,
        IERC20 stakingToken_,
        uint256 goal,
        uint256 deadline_,
        uint256 contributorFee_
    ) Ownable(owner){
        crowdFund = ICrowdFund(msg.sender);
        startTime = block.timestamp;

        fundingToken = fundingToken_;
        stakingToken = stakingToken_;
        fundingGoal = goal;
        deadline = deadline_;
        contributorFee = contributorFee_;

        cycleLength = crowdFund.cycleLength();
        accrualRate = crowdFund.accrualRate();
        percentScale = crowdFund.percentScale();

        if (contributorFee > percentScale) {
            revert ContributorFeeOverOneHundredPercent();
        }
    }

    /// @notice Allows users to contribute to this Solution
    /// @dev Creates a new position for the contributor
    /// @param amount The amount to contribute
    /// @return positionIndex will be reused as input to collectFees(), checkPosition(), and other functions
    function contribute(uint256 amount) external returns (uint256 positionIndex) {
        if (goalFailed()) revert GoalFailed();

        address addr = msg.sender;
        uint256 _contributorFee = amount * contributorFee / percentScale;

        updateCyclesWithFee(_contributorFee);

        uint256 originalAmount = amount;
        uint256 lastStoredCycleIndex;

        unchecked {
        // updateCyclesAddingAmount() will always add a cycle if none exists
            lastStoredCycleIndex = cycles.length - 1;

            if (lastStoredCycleIndex > 0) {
                // Contributor fees are only charged in cycles after the one in which the first contribution was made.
                amount -= _contributorFee;
            }
        }

        tokensContributed += amount;

        positionsByAddress[addr].push(
            Position({
                contribution: amount,
                contributionTime: block.timestamp,
                startCycleIndex: lastStoredCycleIndex,
                lastCollectedCycleIndex: lastStoredCycleIndex,
                refunded: false
            })
        );

        unchecked {
            positionIndex = positionsByAddress[addr].length - 1;
        }

        fundingToken.safeTransferFrom(addr, address(this), originalAmount);
        emit Contributed(
            addr,
            positionIndex,
            originalAmount,
            totalShares(),
            tokensContributed,
            totalTokens(),
            new address[](0),
            new uint256[](0),
            new uint256[](0)
        );
    }

    /// @notice Allows users to contribute to this Solution and log dependency funding
    /// @dev Designed to be the first call in a Multicall batch. Creates a new position for the contributor
    /// @param amount The amount to contribute to this Solution
    /// @param dependencyAddresses The addresses of the Solutions that were funded by the contributor
    /// @param dependencyChainIds The chain IDs of the Solutions that were funded by the contributor
    /// @param dependencyAmounts The amounts that were contributed to the Solutions by the contributor
    /// @return positionIndex will be reused as input to collectFees(), checkPosition(), and other functions
    function contributeWithDependencies(
        uint256 amount,
        address[] calldata dependencyAddresses,
        uint256[] calldata dependencyChainIds,
        uint256[] calldata dependencyAmounts
    ) external returns (uint256 positionIndex) {
        if (goalFailed()) revert GoalFailed();

        if (dependencyAddresses.length != dependencyChainIds.length || dependencyAddresses.length != dependencyAmounts.length) {
            revert InvalidDependencyData();
        }

        address addr = msg.sender;
        uint256 _contributorFee = amount * contributorFee / percentScale;

        updateCyclesWithFee(_contributorFee);

        uint256 originalAmount = amount;
        uint256 lastStoredCycleIndex;

        unchecked {
        // updateCyclesAddingAmount() will always add a cycle if none exists
            lastStoredCycleIndex = cycles.length - 1;

            if (lastStoredCycleIndex > 0) {
                // Contributor fees are only charged in cycles after the one in which the first contribution was made.
                amount -= _contributorFee;
            }
        }

        tokensContributed += amount;

        positionsByAddress[addr].push(
            Position({
                contribution: amount,
                contributionTime: block.timestamp,
                startCycleIndex: lastStoredCycleIndex,
                lastCollectedCycleIndex: lastStoredCycleIndex,
                refunded: false
            })
        );

        unchecked {
            positionIndex = positionsByAddress[addr].length - 1;
        }

        fundingToken.safeTransferFrom(addr, address(this), originalAmount);

        emit Contributed(
            addr,
            positionIndex,
            originalAmount,
            totalShares(),
            tokensContributed,
            totalTokens(),
            dependencyAddresses,
            dependencyChainIds,
            dependencyAmounts
        );
    }

    function addStake(uint256 amount) external {
        if (goalFailed()) revert GoalFailed();

        address addr = msg.sender;
        unchecked {
            stake += amount;
            stakes[addr] += amount;
        }

        stakingToken.safeTransferFrom(addr, address(this), amount);
        emit StakeUpdated(addr, stakes[addr], stake);
    }

    function transferStake(address receiver) external {
        if (goalFailed()) revert GoalFailed();

        address sender = msg.sender;
        uint256 amount = stakes[sender];
        stakes[sender] = 0;
        unchecked {
            stakes[receiver] += amount;
        }
        emit StakeTransferred(sender, receiver, amount, stakes[receiver]);
    }

    function removeStake(uint256 amount) external goalReached {
        address addr = msg.sender;
        if (amount > stakes[addr]) revert WithdrawMoreThanAvailable(amount, stakes[addr]);

        unchecked {
            stake -= amount;
            stakes[addr] -= amount;
        }

        stakingToken.safeTransfer(addr, amount);
        emit StakeUpdated(addr, stakes[addr], stake);
    }

    /// Extend the goal, keeping the deadline the same.
    function extendGoal(uint256 goal) external onlyOwner goalReached {
        _extendGoal(goal, deadline);
    }

    /// Extend the goal and the deadline.
    function extendGoal(uint256 goal, uint256 deadline_) external onlyOwner goalReached {
        _extendGoal(goal, deadline_);
    }

    /// Extend the goal and the deadline. Also update the Solution data.
    function extendGoal(uint256 goal, uint256 deadline_, bytes calldata solutionData) external onlyOwner goalReached {
        _extendGoal(goal, deadline_);
        emit SolutionUpdated(solutionData);
    }

    /// Collect fees for the only position
    function collectFees() external singlePosition(msg.sender) {
        collectFees(0);
    }

    /// Get a refund and stake award after the goal fails for the only position.
    function refund() external singlePosition(msg.sender) {
        refund(0);
    }

    function updateSolution(bytes calldata data) external onlyOwner {
        emit SolutionUpdated(data);
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
        split(positionIndex, numSplits - 1, position.contribution / numSplits);
    }

    function withdrawFunds(address to, uint256 amount) external onlyOwner goalReached {
        _withdrawFunds(to, amount);
    }

    /// Check the number of tokens and shares for an address with only one position.
    function checkPosition(
        address addr
    ) external view singlePosition(addr) returns (uint256 feesEarned, uint256 shares) {
        return checkPosition(addr, 0);
    }

    /// @notice Allows contributors to collect their earned fees
    /// @dev Updates cycles and transfers earned fees to the contributor
    /// @param positionIndex The positionIndex returned by the contribute() function
    function collectFees(uint256 positionIndex) public positionExists(msg.sender, positionIndex) {
        address addr = msg.sender;

        updateCyclesWithFee(0);

        (uint256 feesEarned, uint256 shares) = positionToLastStoredCycle(addr, positionIndex);

        unchecked {
            positionsByAddress[addr][positionIndex].lastCollectedCycleIndex = cycles.length - 1;
        }

        fundingToken.safeTransfer(addr, feesEarned);
        emit FeesCollected(addr, positionIndex, feesEarned);
    }

    /// Get a refund and stake award after the goal fails.
    /// @param positionIndex The positionIndex returned by the contribute() function.
    function refund(uint256 positionIndex) public positionExists(msg.sender, positionIndex) {
        address addr = msg.sender;
        Position storage position = positionsByAddress[addr][positionIndex];
        if (position.refunded) revert AlreadyRefunded();
        if (goalExtendedTime > 0 && position.contributionTime < goalExtendedTime)
            revert ContributedBeforeGoalExtended(position.contributionTime, goalExtendedTime);
        if (goalFailed()) {
            position.refunded = true;

            uint256 cycleDiff;
            unchecked {
                cycleDiff = currentCycleNumber() - cycles[position.startCycleIndex].number;
            }

            uint256 positionShares = accrualRate * position.contribution * cycleDiff / percentScale;
            uint256 stakeAward = stake * positionShares / totalShares();

            fundingToken.safeTransfer(addr, position.contribution);
            stakingToken.safeTransfer(addr, stakeAward);
            emit Refunded(addr, positionIndex, position.contribution, stakeAward);
        } else {
            revert GoalNotFailed();
        }
    }

    /// @param positionIndex The positionIndex returned by the contribute() function.
    function transferPosition(
        address recipient,
        uint256 positionIndex
    ) public positionExists(msg.sender, positionIndex) {
        if (goalFailed()) revert GoalFailed();

        address sender = msg.sender;
        Position[] storage fromPositions = positionsByAddress[sender];
        Position[] storage toPositions = positionsByAddress[recipient];
        uint256 contribution = fromPositions[positionIndex].contribution;

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
        if (goalFailed()) revert GoalFailed();

        address addr = msg.sender;
        Position[] storage positions = positionsByAddress[addr];
        Position storage position = positions[positionIndex];

        uint256 deductAmount = amount * numSplits;
        if (deductAmount > position.contribution) revert SplitAmountMoreThanPosition(deductAmount, position.contribution);

        unchecked {
            position.contribution -= deductAmount;
        }

        uint256 firstNewPositionIndex;

        unchecked {
            for (uint256 i = 1; i <= numSplits; ++i) {
                positions.push(
                    Position({
                        contribution: amount,
                        contributionTime: position.contributionTime,
                        startCycleIndex: position.startCycleIndex,
                        lastCollectedCycleIndex: position.lastCollectedCycleIndex,
                        refunded: false
                    })
                );
            }

            firstNewPositionIndex = positions.length - numSplits;
        }

        emit Split(addr, positionIndex, numSplits, firstNewPositionIndex, amount, position.contribution);
    }

    /// Withdraw all funds to owner.
    function withdrawFunds() public onlyOwner goalReached {
        uint256 availableTokens = totalTokens();
        if (availableTokens > 0) {
            _withdrawFunds(msg.sender, availableTokens);
        }
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

    /// @return The number of shares all contributors hold in this choice.
    /// The total shares can be compared between two choices to see which has more support.
    function totalShares() public view returns (uint256) {
        if (cycles.length == 0) {
            return 0;
        }
        return cycles[cycles.length - 1].shares + pendingShares(currentCycleNumber(), tokensContributed);
    }

    function totalTokens() public view returns (uint256) {
        unchecked {
            return tokensContributed - tokensWithdrawn;
        }
    }

    function currentCycleNumber() public view returns (uint256) {
        unchecked {
            return cycleNumberAtTime(block.timestamp);
        }
    }

    function cycleNumberAtTime(uint256 timestamp) public view returns (uint256) {
        unchecked {
            return (timestamp - startTime) / cycleLength;
        }
    }

    /// Did this Solution fail to reach its goal before the deadline?
    function goalFailed() public view returns (bool) {
        return block.timestamp > deadline && tokensContributed < fundingGoal;
    }

    function numPositions(address addr) public view returns (uint256) {
        return positionsByAddress[addr].length;
    }

    /// @param positionIndex The positionIndex returned by the contribute() function.
    function checkPosition(
        address addr,
        uint256 positionIndex
    ) public view positionExists(addr, positionIndex) returns (uint256 feesEarned, uint256 shares) {
        (feesEarned, shares) = positionToLastStoredCycle(addr, positionIndex);
        shares += pendingShares(currentCycleNumber(), positionsByAddress[addr][positionIndex].contribution);
    }

    function _extendGoal(uint256 goal, uint256 deadline_) internal {
        if (goal <= fundingGoal) revert GoalMustIncrease(fundingGoal, goal);
        if (deadline_ <= block.timestamp) revert MustSetDeadlineInFuture(deadline_);
        withdrawFunds();
        goalExtendedTime = block.timestamp;
        fundingGoal = goal;
        deadline = deadline_;
        emit GoalExtended(goal, deadline);
    }

    function _withdrawFunds(address to, uint256 amount) internal {
        if (amount <= totalTokens()) {
            // Keep overflow checks for unknown token operations
            tokensWithdrawn += amount;
            fundingToken.safeTransfer(to, amount);
            emit FundsWithdrawn(to, amount, totalTokens());
        } else {
            revert WithdrawMoreThanAvailable(amount, totalTokens());
        }
    }

    /// @notice Updates cycles with new fees
    /// @dev This function is called by contribute() and collectFees() to update the cycle data
    /// @param _contributorFee The contributor fee for this contribution
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
                    // Keep overflow checks for unknown token operations
                    lastStoredCycle.fees += _contributorFee;
                    lastStoredCycle.hasContributions = lastStoredCycle.fees > 0;
                }
            } else {
                // Some cycle numbers might be skipped, so we need to accrue shares in between.
                Cycle memory newCycle = Cycle({
                    number: currentCycleNumber_,
                // Keep overflow checks for unknown token operations
                    shares: lastStoredCycle.shares +
                accrualRate * (currentCycleNumber_ - lastStoredCycleNumber) * tokensContributed / percentScale,
                    fees: _contributorFee,
                    hasContributions: _contributorFee > 0
                });
                // We're only interested in adding cycles that have contributions, since we use the stored
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

    /// @notice Calculates the fees earned and shares for a position up to the last stored cycle
    /// @dev Used by collectFees and checkPosition to determine earned fees
    /// @param addr The address of the position owner
    /// @param positionIndex The index of the position
    /// @return feesEarned The amount of fees earned by the position
    /// @return shares The number of shares held by the position
    function positionToLastStoredCycle(
        address addr,
        uint256 positionIndex
    ) internal view returns (uint256 feesEarned, uint256 shares) {
        Position storage position = positionsByAddress[addr][positionIndex];

        uint256 contribution = position.contribution;

        uint256 loopIndex;
        uint256 firstCycleNumber = cycles[position.startCycleIndex].number;
        uint256 lastStoredCycleIndex;

        unchecked {
        // updateCyclesWithFee() will always add a cycle if none exists
            lastStoredCycleIndex = cycles.length - 1;
            loopIndex = position.lastCollectedCycleIndex + 1; // can't realistically overflow
        }

        for (uint256 i = loopIndex; i <= lastStoredCycleIndex;) {
            Cycle storage cycle = cycles[i];

            // Keep overflow checks for unknown token operations
            shares = accrualRate * (cycle.number - firstCycleNumber) * contribution / percentScale;
            feesEarned += (cycle.fees * shares) / cycle.shares;

            unchecked {
                ++i;
            }
        }
    }
}
