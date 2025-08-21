// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

//-------------------Contracts-------------------------------
contract BrightID is Ownable {
    //-------------------Custom Errors-----------------------
    error NewerVerificationExists(address addr, uint256 existingTimestamp, uint256 newTimestamp);
    error VerificationTooOld(uint256 timestamp, uint256 currentTime, uint32 registrationPeriod);
    error NotAuthorized(address signer, uint256 balance);

    //-------------------Storage-----------------------------
    IERC20 public verifierToken; // address of verification Token
    bytes32 public app; //Registered BrightID app name
    bytes32 public verificationHash; // sha256 of the verification expression

    uint32 public immutable REGISTRATION_PERIOD; // time period in which a verification signature is valid for registration
    uint32 public immutable VERIFICATION_PERIOD; // time period in which a verification is valid after registration

    //-------------------Events-----------------------------
    event AppSet(bytes32 _app);
    event VerifierTokenSet(IERC20 verifierToken);
    event VerificationHashSet(bytes32 verificationHash);
    event Verified(address indexed addr, uint256 timestamp);

    //-------------------Mappings---------------------------
    mapping(address => uint256) public verifications; // verification timestamps

    //-------------------Constructor-------------------------
    /**
     * @param _verifierToken verifier token
     * @param _app BrightID app used for verifying users
     * @param _verificationHash sha256 of the verification expression
     * @param _registrationPeriod time period in which a verification signature is valid for registration
     * @param _verificationPeriod time period in which a verification is valid after registration
     */
    constructor(
        IERC20 _verifierToken,
        bytes32 _app,
        bytes32 _verificationHash,
        uint32 _registrationPeriod,
        uint32 _verificationPeriod
    ) Ownable(msg.sender) {
        setApp(_app);
        setVerifierToken(_verifierToken);
        setVerificationHash(_verificationHash);
        REGISTRATION_PERIOD = _registrationPeriod;
        VERIFICATION_PERIOD = _verificationPeriod;
    }

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
     * @notice Set verification hash
     * @param _verificationHash sha256 of the verification expression
     */
    function setVerificationHash(bytes32 _verificationHash) public onlyOwner {
        verificationHash = _verificationHash;
        emit VerificationHashSet(_verificationHash);
    }

    /**
     * @notice Register a user by BrightID verification
     * @param addr The address used by this user in the app
     * @param timestamp The BrightID node's verification timestamp
     * @param v Component of signature
     * @param r Component of signature
     * @param s Component of signature
     */
    function verify(address addr, uint timestamp, uint8 v, bytes32 r, bytes32 s) public {
        if (verifications[addr] >= timestamp) {
            revert NewerVerificationExists(addr, verifications[addr], timestamp);
        }
        if (timestamp <= block.timestamp - REGISTRATION_PERIOD) {
            revert VerificationTooOld(timestamp, block.timestamp, REGISTRATION_PERIOD);
        }

        bytes32 message = keccak256(abi.encodePacked(app, addr, verificationHash, timestamp));
        address signer = ecrecover(message, v, r, s);
        uint256 signerBalance = verifierToken.balanceOf(signer);
        if (signerBalance == 0) {
            revert NotAuthorized(signer, signerBalance);
        }

        verifications[addr] = timestamp;

        emit Verified(addr, timestamp);
    }

    /**
     * @notice Check that an address has been verified and is not expired
     * @param addr The address to check the timestamp of
     */
    function isVerified(address addr) external view returns (bool) {
        return verifications[addr] != 0 && verifications[addr] + VERIFICATION_PERIOD >= block.timestamp;
    }
}
