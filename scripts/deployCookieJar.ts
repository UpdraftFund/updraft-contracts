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

  // Deploy BrightID verifier contract
  const verifierToken = "0x0000000000000000000000000000000000000000"; // TODO: Replace with actual verifier token address

  const brightIdContract = await hre.viem.deployContract("BrightID", [
    verifierToken, // verifier token to be distributed to trusted nodes
    stringToHex("updraft", { size: 32 }), // app name
    stringToHex("updraft-verification", { size: 32 }), // TODO: update with actual verification hash
    24 * 60 * 60, // 24 hours registration period
    7 * 24 * 60 * 60, // 7 days verification period
  ]);

  const brightIdVerifier = brightIdContract.address;

  // BrightID context (this would need to be replaced with the actual context)
  // For Updraft, we might use something like "updraft" as the context
  const context = stringToHex("updraft", { size: 32 });

  // Get the deployer account
  const [deployer] = await hre.viem.getWalletClients();

  const args = [deployer.account.address, updToken, brightIdVerifier, 7 * 24 * 60 * 60, 1500]; // 7 days, 15% scaling factor

  // @ts-expect-error: Hardhat viem plugin typing issue
  const cookieJar = await hre.viem.deployContract("UpdCookieJar", args);

  console.log(`BrightID Verifier deployed to ${brightIdVerifier}`);
  console.log(`CookieJar deployed to ${(cookieJar as { address: string }).address}`);

  console.log("Constructor arguments:");
  console.log(`  Initial Owner: ${deployer.account.address}`);
  console.log(`  UPD Token: ${updToken}`);
  console.log(`  BrightID Verifier: ${brightIdVerifier}`);
  console.log(`  Stream Period: 7 days`);
  console.log(`  Scaling Factor: 1500 (15%)`);

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
