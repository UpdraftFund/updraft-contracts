import hre from 'hardhat';
import { parseUnits } from 'viem';
import { assert, expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';

const deployUpdraft = async () => {
  const upd = await hre.viem.deployContract('UPDToken');
  const feeToken = upd.address;
  const minFee = parseUnits('1', 18); // 1 UPDT
  //  100% is 1000000 (percentScale is 1000000 in Updraft.sol)
  const percentFee = 10000; // 1%
  const accrualRate = 1000; // 0.1%
  const cycleLength = 3600; // 1 hour in seconds
  const args = [feeToken, minFee, percentFee, cycleLength, accrualRate];
  return await hre.viem.deployContract('Updraft', args);
};

describe('Updraft', function () {
  it('should deploy', async function () {
    const updraft = await loadFixture(deployUpdraft);
  });
});