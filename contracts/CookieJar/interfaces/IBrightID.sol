// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IBrightID {
    function verify(address addr, uint timestamp, uint8 v, bytes32 r, bytes32 s) external returns (bool);

    function isVerified(address addr) external view returns (bool);
}
