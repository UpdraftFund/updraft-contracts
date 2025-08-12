import hre from "hardhat";
import { stringToHex } from "viem";

import { networks } from "./addresses.json";

interface NetworkConfig {
  UPDToken?: string;
  blockTime: number;
}

async function deploy(network: string) {
  // Get the UPD token address for this network
  const networkConfig = networks[network as keyof typeof networks] as NetworkConfig | undefined;
  if (!networkConfig) {
    throw new Error(`Network ${network} not found in addresses.json`);
  }

  const updToken = networkConfig.UPDToken;
  if (!updToken) {
    throw new Error(`UPDToken address not found for network ${network}`);
  }

  // BrightID verifier address (this would need to be replaced with the actual deployed address)
  // For now, we'll use a placeholder address
  const brightIdVerifier = "0x0000000000000000000000000000000000000000";

  // BrightID context (this would need to be replaced with the actual context)
  // For Updraft, we might use something like "updraft" as the context
  const context = stringToHex("updraft", { size: 32 });

  // Get the deployer account
  const [deployer] = await hre.viem.getWalletClients();

  const args = [deployer.account.address, updToken, brightIdVerifier, context];

  // @ts-expect-error: Hardhat viem plugin typing issue
  const cookieJar = await hre.viem.deployContract("UpdCookieJar", args);

  console.log(`CookieJar deployed to ${(cookieJar as { address: string }).address}`);

  console.log("Constructor arguments:");
  console.log(`  Initial Owner: ${deployer.account.address}`);
  console.log(`  UPD Token: ${updToken}`);
  console.log(`  BrightID Verifier: ${brightIdVerifier}`);
  console.log(`  Context: ${context}`);

  setTimeout(async () => {
    await hre.run("verify:verify", {
      address: (cookieJar as { address: string }).address,
      constructorArguments: args,
    });
  }, networkConfig.blockTime * 5); // wait for 5 confirmations

  return (cookieJar as { address: string }).address;
}

if (require.main === module) {
  const network = process.env.network;
  if (!network) {
    console.error("NETWORK environment variable is required");
    process.exitCode = 1;
    process.exit(1);
  }

  deploy(network).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
