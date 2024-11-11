import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox-viem";
import "@truffle/dashboard-hardhat-plugin";

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
  defaultNetwork: "truffleDashboard",
};

export default config;
