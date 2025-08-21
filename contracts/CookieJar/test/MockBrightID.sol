// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

contract MockBrightID {
    uint32 public constant VERIFICATION_PERIOD = 7 days;
    mapping(address => uint256) public verifications;

    event Verified(address addr);

    function verify(address addr) external {
        verifications[addr] = block.timestamp;
        emit Verified(addr);
    }

    function isVerified(address addr) external view returns (bool) {
        return verifications[addr] != 0 && verifications[addr] + VERIFICATION_PERIOD >= block.timestamp;
    }

    // Fallback function to handle unrecognized function calls
    fallback() external payable {
        revert("Function not implemented");
    }

    // Receive function to handle direct ETH transfers
    receive() external payable {}
}
