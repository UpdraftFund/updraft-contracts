// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

//-------------------Contracts-------------------------------
contract BrightID is Ownable {
    //-------------------Storage-----------------------------
    IERC20 public verifierToken; // address of verification Token
    bytes32 public app; //Registered BrightID app name
    uint32 public constant REGISTRATION_PERIOD = 86400; // 24 hours in seconds
    uint32 public constant VERIFICATION_PERIOD = 604800; // 7 days in seconds

    //-------------------Events-----------------------------
    event AppSet(bytes32 _app);
    event VerifierTokenSet(IERC20 verifierToken);
    event Verified(address indexed addr, uint256 timestamp);
    // event Sponsor(address indexed addr);

    //-------------------Mappings---------------------------
    mapping(address => uint256) public verifications; // verification timestamp
    mapping(address => address) public history; // address history

    //-------------------Constructor-------------------------
    /**
     * @param _verifierToken verifier token
     * @param _app BrightID app used for verifying users
     */
    constructor(IERC20 _verifierToken, bytes32 _app) Ownable(msg.sender) {
        setApp(_app);
        setVerifierToken(_verifierToken);
    }

    // emits a sponsor event for brightID nodes
    // function sponsor(address addr) public {
    //     emit Sponsor(addr);
    // }

    /**
     * @notice Set the app
     * @param _app BrightID app used for verifying users
     */
    function setApp(bytes32 _app) public onlyOwner {
        app = _app;
        emit AppSet(_app);
    }

    /**
     * @notice Set verifier token
     * @param _verifierToken verifier token held by trusted BrightID nodes
     */
    function setVerifierToken(IERC20 _verifierToken) public onlyOwner {
        verifierToken = _verifierToken;
        emit VerifierTokenSet(_verifierToken);
    }

    /**
     * @notice Register a user by BrightID verification
     * @param addrs The history of addresses used by this user in the app
     * @param timestamp The BrightID node's verification timestamp
     * @param v Component of signature
     * @param r Component of signature
     * @param s Component of signature
     */
    function verify(address[] memory addrs, uint timestamp, uint8 v, bytes32 r, bytes32 s) public {
        require(verifications[addrs[0]] < timestamp, "Newer verification registered before.");
        require(timestamp > block.timestamp - REGISTRATION_PERIOD, "Verification too old. Try linking again.");

        bytes32 message = keccak256(abi.encodePacked(app, addrs, timestamp));
        address signer = ecrecover(message, v, r, s);
        require(verifierToken.balanceOf(signer) > 0, "not authorized");

        verifications[addrs[0]] = timestamp;
        for (uint i = 1; i < addrs.length; i++) {
            require(
                verifications[addrs[i]] < block.timestamp - REGISTRATION_PERIOD * 2,
                "Address changed too recently. Wait for next registration period."
            );
            history[addrs[i - 1]] = addrs[i];
        }
        emit Verified(addrs[0], timestamp);
    }

    /**
     * @notice Check that an address has been verified and is not expired
     * @param addr The address to check the timestamp of
     */
    function isVerified(address addr) external view returns (bool) {
        return verifications[addr] != 0 && verifications[addr] + VERIFICATION_PERIOD >= block.timestamp;
    }
}
