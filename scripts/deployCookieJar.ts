import hre from "hardhat";

import { networks } from "./addresses.json";

async function deploy(network) {
  // Get the UPD token address for this network
  const updToken = networks[network].UPDToken;
  if (!updToken) {
    throw new Error(`UPDToken address not found for network ${network}`);
  }

  // BrightID verifier address (this would need to be replaced with the actual deployed address)
  // For now, we'll use a placeholder address
  const brightIdVerifier = "0x0000000000000000000000000000000000000000";

  // BrightID context (this would need to be replaced with the actual context)
  // For Updraft, we might use something like "updraft" as the context
  const context = hre.ethers.utils.formatBytes32String("updraft");

  const args = [updToken, brightIdVerifier, context];

  const cookieJar = await hre.viem.deployContract("UpdCookieJar", args);

  console.log(`CookieJar deployed to ${cookieJar.address}`);

  console.log("Constructor arguments:");
  console.log(`  UPD Token: ${updToken}`);
  console.log(`  BrightID Verifier: ${brightIdVerifier}`);
  console.log(`  Context: ${context}`);

  setTimeout(async () => {
    await hre.run("verify:verify", {
      address: cookieJar.address,
      constructorArguments: args,
      network,
    });
  }, networks[network].blockTime * 5); // wait for 5 confirmations

  return cookieJar.address;
}

if (require.main === module) {
  deploy(process.env.network).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
