import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox-viem";
import "@truffle/dashboard-hardhat-plugin";

const config: HardhatUserConfig = {
  solidity: "0.8.27",
  defaultNetwork: "truffleDashboard",
};

export default config;
