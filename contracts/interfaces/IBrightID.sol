// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IBrightID {
    function isVerified(address addr) external view returns (bool);
}
