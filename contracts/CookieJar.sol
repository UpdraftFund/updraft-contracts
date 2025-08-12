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
    uint256 public constant COOLDOWN = 7 days;

    mapping(address => uint256) public lastClaimAt; // last claim timestamp per address

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

    function claim() external nonReentrant whenNotPaused {
        // Eligibility: BrightID verification
        require(brightId.isVerified(brightIdContext, msg.sender), "not BrightID verified");

        // 1% of current balance (rounds down)
        uint256 bal = token.balanceOf(address(this));
        require(bal >= 2 ether, "empty");
        uint256 amount = bal / 100; // 1%
        // Use the greater of 1% or 2 UPD tokens (2 * 10^18 wei)
        if (amount < 2 ether) {
            amount = 2 ether;
        }
        // But don't exceed the available balance
        if (amount > bal) {
            amount = bal;
        }

        // Cooldown: per-address rolling 7 days
        uint256 last = lastClaimAt[msg.sender];
        require(block.timestamp >= last + COOLDOWN, "cooldown");

        lastClaimAt[msg.sender] = block.timestamp;
        require(token.transfer(msg.sender, amount), "transfer failed");

        emit Claimed(msg.sender, amount);
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
