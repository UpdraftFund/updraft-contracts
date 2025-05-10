import hre from 'hardhat';
import { parseUnits } from 'viem';

import { networks } from './addresses.json';

async function deploy(network) {
  const feeToken = networks[network].UPDToken;
  const minFee = parseUnits('1', 18); // 1 UPD
  // 100% is 1000000 (percentScale is 1000000 in Updraft.sol)
  const percentFee = 10000; // 1%
  // The accrual rate (as long as it's > 0) doesn't change how Updraft functions. It only matters for the legibility of computed "shares."
  // By keeping it a power of 10, we can make it easier to equate "shares" to the number of tokens contributed times hours passed.
  const accrualRate = 100000; // 10%
  const cycleLength = 12 * 60 * 60; // 12 hours in seconds
  const humanity = '0xdC0046B52e2E38AEe2271B6171ebb65cCD337518';
  const args = [feeToken, minFee, percentFee, cycleLength, accrualRate, humanity];

  const updraft = await hre.viem.deployContract('Updraft', args);

  console.log(
    `Updraft contract deployed to ${updraft.address}`
  );

  setTimeout(async () => {
    await hre.run('verify:verify', {
      address: updraft.address,
      constructorArguments: args,
      network
    });
  }, networks[network].blockTime * 5); // wait for 5 confirmations

  return updraft.address;
}

if (require.main === module) {
  deploy(process.env.network).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
