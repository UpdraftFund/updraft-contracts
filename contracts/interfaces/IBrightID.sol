// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IBrightID {
    function isVerified(bytes32 context, address addr) external view returns (bool);
}
