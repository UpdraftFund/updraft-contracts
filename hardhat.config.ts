import type { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox-viem';
import '@truffle/dashboard-hardhat-plugin';

import { etherscan } from "./apiKeys.json";

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
    apiKey: etherscan
  },
  sourcify: {
    enabled: false
  }
};

export default config;
