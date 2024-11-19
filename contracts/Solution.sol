// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

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

    Cycle[] public cycles;

    /// Addresses can contribute multiple times to the same choice, so we use an array of Positions.
    /// The index of a Position in this array is used in checkPosition(), collectFees(), split(), and
    /// transferPositions() and is returned by contribute().
    mapping(address => Position[]) public positionsByAddress;

    mapping(address => uint256) public stakes;

    event FeesCollected(address indexed addr, uint256 positionIndex, uint256 amount);
    event FundsWithdrawn(address to, uint256 amount);
    event StakeUpdated(address indexed user, uint256 userStake, uint256 totalStake);
    event StakeTransferred(address indexed from, address indexed to, uint256 amount);
    event Refunded(address indexed addr, uint256 amount, uint256 stakeAwarded);
    event SolutionUpdated(bytes data);
    event GoalExtended(uint256 goal, uint256 deadline);
    event Contributed(
        address indexed addr,
        uint256 positionIndex,
        uint256 amount,
        uint256 totalTokensContributed,
        uint256 totalShares
    );
    event PositionTransferred(
        address indexed sender,
        address indexed recipient,
        uint256 senderPositionIndex,
        uint256 recipientPositionIndex
    );
    event Split(
        address indexed addr,
        uint256 originalPositionIndex,
        uint256 numNewPositions,
        uint256 firstNewPositionIndex,
        uint256 amountPerNewPosition
    );

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

    modifier singlePosition(address addr) {
        uint256 numPositions = positionsByAddress[addr].length;

        if (numPositions == 0) {
            revert PositionDoesNotExist();
        }

        if (numPositions > 1) {
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
    }

    /// Check the number of tokens and shares for an address with only one position.
    function checkPosition(
        address addr
    ) external view singlePosition(addr) returns (uint256 positionTokens, uint256 shares) {
        return checkPosition(addr, 0);
    }

    function positionsLength(address addr) external view returns (uint256) {
        return positionsByAddress[addr].length;
    }

    /// @return positionIndex will be reused as input to collectFees(), checkPosition(), and other functions
    function contribute(uint256 amount) external returns (uint256 positionIndex) {
        if (goalFailed()) revert GoalFailed();
        address addr = msg.sender;

        uint256 _contributorFee = amount * contributorFee / percentScale;

        updateCyclesAddingAmount(amount, _contributorFee);

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
                startCycleIndex: lastStoredCycleIndex,
                lastCollectedCycleIndex: lastStoredCycleIndex,
                refunded: false
            })
        );

        unchecked {
            positionIndex = positionsByAddress[addr].length - 1;
        }

        fundingToken.safeTransferFrom(addr, address(this), originalAmount);
        emit Contributed(addr, positionIndex, originalAmount, tokensContributed, totalShares());
    }

    function addStake(uint256 amount) external{
        if (goalFailed()) revert GoalFailed();

        address addr = msg.sender;
        stake += amount;
        stakes[addr] += amount;

        stakingToken.safeTransferFrom(addr, address(this), amount);
        emit StakeUpdated(addr, stakes[addr], stake);
    }

    function transferStake(address receiver) external{
        address sender = msg.sender;
        uint256 amount = stakes[sender];
        stakes[sender] = 0;
        stakes[receiver] += amount;
        emit StakeTransferred(sender, receiver, amount);
    }

    function removeStake(uint256 amount) external goalReached {
        address addr = msg.sender;
        if (amount > stakes[addr]) revert WithdrawMoreThanAvailable(amount, stakes[addr]);

        stake -= amount;
        stakes[addr] -= amount;

        stakingToken.safeTransfer(addr, amount);
        emit StakeUpdated(addr, stakes[addr], stake);
    }

    function withdrawFunds(address to, uint256 amount) external onlyOwner goalReached {
        uint256 tokensLeft = tokensContributed - tokensWithdrawn;
        if (tokensLeft >= amount) {
            tokensWithdrawn += amount;
            fundingToken.safeTransfer(to, amount);
            emit FundsWithdrawn(to, amount);
        } else {
            revert WithdrawMoreThanAvailable(amount, tokensLeft);
        }
    }

    /// Extend the goal, keeping the deadline the same.
    function extendGoal(uint256 goal) external onlyOwner goalReached {
            if (goal <= fundingGoal) revert GoalMustIncrease(fundingGoal, goal);
            if (deadline <= block.timestamp) revert MustSetDeadlineInFuture(deadline);

            fundingGoal = goal;
            emit GoalExtended(goal, deadline);
    }

    /// Extend the goal and the deadline.
    function extendGoal(uint256 goal, uint256 deadline_) external onlyOwner goalReached {
            if (goal <= fundingGoal) revert GoalMustIncrease(fundingGoal, goal);
            if (deadline_ <= block.timestamp) revert MustSetDeadlineInFuture(deadline);

            fundingGoal = goal;
            deadline = deadline_;
            emit GoalExtended(goal, deadline);
    }

    /// Extend the goal and the deadline. Also update the Solution data.
    function extendGoal(uint256 goal, uint256 deadline_, bytes calldata solutionData) external onlyOwner goalReached {
            if (goal <= fundingGoal) revert GoalMustIncrease(fundingGoal, goal);
            if (deadline_ <= block.timestamp) revert MustSetDeadlineInFuture(deadline);

            fundingGoal = goal;
            deadline = deadline_;
            emit GoalExtended(goal, deadline);
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
        }

        for (uint256 i; i <= lastIndex;) {
            transferPosition(recipient, positionIndexes[i]);
            unchecked {
                ++i;
            }
        }
    }

    /// Split the position equally into numSplits positions.
    function split(uint256 positionIndex, uint256 numSplits) external {
        Position storage position = positionsByAddress[msg.sender][positionIndex];
        split(positionIndex, numSplits - 1, position.contribution / numSplits);
    }

    /// @return The number of shares all contributors hold in this choice.
    /// The total shares can be compared between two choices to see which has more support.
    function totalShares() public view returns (uint256) {
        return cycles[cycles.length - 1].shares + pendingShares(currentCycleNumber(), tokensContributed);
    }

    function currentCycleNumber() public view returns (uint256) {
        return (block.timestamp - startTime) / cycleLength;
    }

    /// Did this Solution fail to reach its goal before the deadline?
    function goalFailed() public view returns (bool) {
        return block.timestamp > deadline && tokensContributed < fundingGoal;
    }

    /// @param positionIndex The positionIndex returned by the contribute() function.
    function checkPosition(
        address addr,
        uint256 positionIndex
    ) public view positionExists(addr, positionIndex) returns (uint256 feesEarned, uint256 shares) {
        (feesEarned, shares) = positionToLastStoredCycle(addr, positionIndex);
        shares += pendingShares(currentCycleNumber(), positionsByAddress[addr][positionIndex].contribution);
    }

    /// @param positionIndex The positionIndex returned by the contribute() function.
    function collectFees(uint256 positionIndex) public positionExists(msg.sender, positionIndex) {
        address addr = msg.sender;

        updateCyclesAddingAmount(0, 0);

        (uint256 feesEarned, uint256 shares) = positionToLastStoredCycle(addr, positionIndex);

        positionsByAddress[addr][positionIndex].lastCollectedCycleIndex = cycles.length - 1;

        fundingToken.safeTransfer(addr, feesEarned);
        emit FeesCollected(addr, positionIndex, feesEarned);
    }

    /// Get a refund and stake award after the goal fails.
    /// @param positionIndex The positionIndex returned by the contribute() function.
    function refund(uint256 positionIndex) public positionExists(msg.sender, positionIndex) {
        address addr = msg.sender;
        Position storage position = positionsByAddress[addr][positionIndex];
        if (position.refunded) revert AlreadyRefunded();
        if (goalFailed()) {
            position.refunded = true;
            uint256 positionShares = accrualRate * position.contribution
                * (currentCycleNumber() - cycles[position.startCycleIndex].number) / percentScale;
            uint256 stakeAward = stake * positionShares / totalShares();

            fundingToken.safeTransfer(addr, position.contribution);
            stakingToken.safeTransfer(addr, stakeAward);
            emit Refunded(addr, position.contribution, stakeAward);
        } else {
            revert GoalNotFailed();
        }
    }

    /// @param positionIndex The positionIndex returned by the contribute() function.
    function transferPosition(
        address recipient,
        uint256 positionIndex
    ) public positionExists(msg.sender, positionIndex) {
        address sender = msg.sender;

        Position[] storage fromPositions = positionsByAddress[sender];
        Position[] storage toPositions = positionsByAddress[recipient];

        toPositions.push(fromPositions[positionIndex]);
        delete fromPositions[positionIndex];

        uint256 recipientPositionIndex;

        unchecked {
            recipientPositionIndex = toPositions.length - 1;
        }

        emit PositionTransferred(sender, recipient, positionIndex, recipientPositionIndex);
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
        if (deductAmount > position.contribution) revert SplitAmountMoreThanPosition(deductAmount, position.contribution);

        unchecked {
            position.contribution -= deductAmount;
        }

        for (uint256 i = 1; i <= numSplits;) {
            positions.push(
                Position({
                    contribution: amount,
                    startCycleIndex: position.startCycleIndex,
                    lastCollectedCycleIndex: position.lastCollectedCycleIndex,
                    refunded: false
                })
            );
            unchecked {
                ++i;
            }
        }

        uint256 firstNewPositionIndex;

        unchecked {
            firstNewPositionIndex = positions.length - numSplits;
        }

        emit Split(addr, positionIndex, numSplits, firstNewPositionIndex, amount);
    }

    /// @param _tokens The token amount used to compute shares--either from the choice, or an individual position.
    /// @param _cycleNumber The cycle number to compute shares for.
    /// @return The number of shares that have not been added to the last stored cycle.
    /// These will be added to the last stored cycle when updateCyclesAddingAmount() is next called.
    function pendingShares(uint256 _cycleNumber, uint256 _tokens) public view returns (uint256) {
        Cycle storage lastStoredCycle;

        unchecked {
            lastStoredCycle = cycles[cycles.length - 1];
        }

        return (accrualRate * (_cycleNumber - lastStoredCycle.number) * _tokens) / percentScale;
    }

    function positionToLastStoredCycle(
        address addr,
        uint256 positionIndex
    ) internal view returns (uint256 feesEarned, uint256 shares) {
        Position storage position = positionsByAddress[addr][positionIndex];
        uint256 contribution = position.contribution;

        uint256 lastStoredCycleIndex;
        uint256 startIndex;

        unchecked {
        // updateCyclesAddingAmount() will always add a cycle if none exists
            lastStoredCycleIndex = cycles.length - 1;
            startIndex = position.lastCollectedCycleIndex + 1; // can't realistically overflow
        }

        shares = accrualRate
            * (cycles[position.lastCollectedCycleIndex].number - cycles[position.startCycleIndex].number)
            * contribution / percentScale;

        for (uint256 i = startIndex; i <= lastStoredCycleIndex;) {
            Cycle storage cycle = cycles[i];
            Cycle storage prevStoredCycle = cycles[i - 1];

            shares += accrualRate * (cycle.number - prevStoredCycle.number) * contribution / percentScale;
            feesEarned += (cycle.fees * shares) / cycle.shares;

            unchecked {
                ++i;
            }
        }
    }

    function updateCyclesAddingAmount(uint256 _amount, uint256 _contributorFee) internal {
        uint256 currentCycleNumber_ = currentCycleNumber();

        uint256 length = cycles.length;

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
                if (lastStoredCycleIndex != 0) {
                    lastStoredCycle.fees += _contributorFee;
                }
            } else {
                // Add a new cycle to the array using values from the previous one.
                Cycle memory newCycle = Cycle({
                    number: currentCycleNumber_,
                    shares: lastStoredCycle.shares +
                (accrualRate * (currentCycleNumber_ - lastStoredCycleNumber) * tokensContributed) / percentScale,
                    fees: _contributorFee,
                    hasContributions: _amount > 0
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
}
