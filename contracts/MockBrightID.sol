// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

contract MockBrightID {
    mapping(address => bool) public verifiedUsers;
    mapping(bytes32 => mapping(address => bool)) public verifiedUsersByContext;

    event UserVerified(address addr);
    event UserVerifiedForContext(bytes32 context, address addr);
    event IsVerifiedCalled(bytes32 context, address addr, bool isVerifiedByContext, bool isVerifiedGlobally);

    function isVerified(bytes32 context, address addr) external view returns (bool) {
        bool isVerifiedByContext = verifiedUsersByContext[context][addr];
        bool isVerifiedGlobally = verifiedUsers[addr];
        return isVerifiedGlobally || isVerifiedByContext;
    }

    function verifyUser(address addr) external {
        verifiedUsers[addr] = true;
        emit UserVerified(addr);
    }

    function verifyUserForContext(bytes32 context, address addr) external {
        verifiedUsersByContext[context][addr] = true;
        emit UserVerifiedForContext(context, addr);
    }

    function unverifyUser(address addr) external {
        verifiedUsers[addr] = false;
    }

    function unverifyUserForContext(bytes32 context, address addr) external {
        verifiedUsersByContext[context][addr] = false;
    }

    // Fallback function to handle unrecognized function calls
    fallback() external payable {
        revert("Function not implemented");
    }

    // Receive function to handle direct ETH transfers
    receive() external payable {}
}
