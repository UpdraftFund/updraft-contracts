// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import {ICrowdFund} from "./interfaces/ICrowdFund.sol";
import {Idea} from "./Idea.sol";
import {Solution} from "./Solution.sol";

contract Updraft is Ownable(msg.sender), ICrowdFund {
    using SafeERC20 for IERC20;

    uint256 public constant percentScale = 1000000;

    IERC20 public feeToken;
    uint256 public minFee;
    uint256 public percentFee;
    uint256 public accrualRate;
    uint256 public cycleLength;
    address public humanity;

    event ProfileUpdated(address indexed owner, bytes data);
    event IdeaCreated(
        Idea indexed idea,
        address indexed creator,
        uint256 contributorFee,
        uint256 contribution,
        bytes data
    );
    event SolutionCreated(
        Solution indexed solution,
        address indexed creator,
        address indexed idea,
        IERC20 fundingToken,
        uint256 stake,
        uint256 goal,
        uint256 deadline,
        uint256 contributorFee,
        bytes data
    );

    constructor(
        IERC20 feeToken_,
        uint256 minFee_,
        uint256 percentFee_,
        uint256 cycleLength_,
        uint256 accrualRate_,
        address humanity_
    ){
        feeToken = feeToken_;
        minFee = minFee_;
        percentFee = percentFee_;
        cycleLength = cycleLength_;
        accrualRate = accrualRate_;
        humanity = humanity_;
    }

    function setFeeToken(IERC20 token) external onlyOwner {
        feeToken = token;
    }

    function setMinFee(uint256 fee) external onlyOwner {
        minFee = fee;
    }

    function setPercentFee(uint256 fee) external onlyOwner {
        percentFee = fee;
    }

    function setCycleLength(uint256 length) external onlyOwner {
        cycleLength = length;
    }

    function setAccrualRate(uint256 rate) external onlyOwner {
        accrualRate = rate;
    }

    function setHumanity(address humanity_) external onlyOwner {
        humanity = humanity_;
    }

    /// Create or update a profile. It will be associated with the caller's address.
    function updateProfile(bytes calldata profileData) external {
        feeToken.safeTransferFrom(msg.sender, humanity, minFee);
        emit ProfileUpdated(msg.sender, profileData);
    }

    function createIdea(uint256 contributorFee, uint256 contribution, bytes calldata ideaData) external {
        Idea idea = new Idea(contributorFee, humanity);
        emit IdeaCreated(idea, msg.sender, contributorFee, contribution, ideaData);

        feeToken.safeTransferFrom(msg.sender, address(this), contribution);
        feeToken.approve(address(idea), contribution);
        idea.contribute(contribution);
        idea.transferPosition(msg.sender);
    }

    /// @param idea The address of the Idea contract to which this solution refers. It can be on another chain.
    function createSolution(
        address idea,
        IERC20 fundingToken,
        uint256 stake,
        uint256 goal,
        uint256 deadline,
        uint256 contributorFee,
        bytes calldata solutionData
    ) external {
        feeToken.safeTransferFrom(msg.sender, humanity, minFee);
        Solution solution = new Solution(msg.sender, fundingToken, feeToken, goal, deadline, contributorFee);
        emit SolutionCreated(
            solution,
            msg.sender,
            idea,
            fundingToken,
            stake,
            goal,
            deadline,
            contributorFee,
            solutionData
        );
        if (stake > 0){
            solution.addStake(stake);
        }
    }

    /// Create or update a profile while creating an idea to avoid paying the updraft anti-spam fee twice.
    /// @dev This code isn't DRY, but we want to use calldata to save gas.
    function createIdeaWithProfile(
        uint256 contributorFee,
        uint256 contribution,
        bytes calldata ideaData,
        bytes calldata profileData
    ) external {
        Idea idea = new Idea(contributorFee, humanity);
        idea.contribute(contribution);
        emit IdeaCreated(idea, msg.sender, contributorFee, contribution, ideaData);
        emit ProfileUpdated(msg.sender, profileData);
    }

    /// Create or update a profile while creating a solution to avoid paying `minFee` twice.
    /// @param idea The address of the Idea contract to which this solution refers. It can be on another chain.
    /// @dev This code isn't DRY, but we want to use calldata to save gas.
    function createSolutionWithProfile(
        address idea,
        IERC20 fundingToken,
        uint256 stake,
        uint256 goal,
        uint256 deadline,
        uint256 contributorFee,
        bytes calldata solutionData,
        bytes calldata profileData
    ) external {
        feeToken.safeTransferFrom(msg.sender, humanity, minFee);
        Solution solution = new Solution(msg.sender, fundingToken, feeToken, goal, deadline, contributorFee);
        emit SolutionCreated(
            solution,
            msg.sender,
            idea,
            fundingToken,
            stake,
            goal,
            deadline,
            contributorFee,
            solutionData
        );
        if (stake > 0){
            solution.addStake(stake);
        }
        emit ProfileUpdated(msg.sender, profileData);
    }
}
