import hre from "hardhat";

import { networks } from './addresses.json';

async function deploy(network) {
  const upd = await hre.viem.deployContract("UPDToken");

  console.log(
    `UPDToken deployed to ${upd.address}`
  );

  setTimeout(async () => {
    await hre.run("verify:verify", {
      address: upd.address,
      network
    });
  }, networks[network].blockTime * 5); // wait for 5 confirmations

  return upd.address;
}

if (require.main === module) {
  deploy(process.env.network).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}