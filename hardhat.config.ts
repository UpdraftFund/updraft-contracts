import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox-viem";
import "@truffle/dashboard-hardhat-plugin";

import { etherscan as etherscanKey } from "./apiKeys.json";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.27",
    settings: {
      optimizer: {
        enabled: true,
        runs: 10
      }
    }
  },
  etherscan: {
    apiKey: etherscanKey
  },
  sourcify: {
    enabled: true
  },
  defaultNetwork: "truffleDashboard",
};

export default config;
