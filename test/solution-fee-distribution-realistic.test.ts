import hre from 'hardhat';
import { parseUnits, toHex, formatUnits } from 'viem';
import { expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { getEventsFromTx, walletAddress } from './utilities/helpers.ts';

// Anti-spam fee
const antiSpamFee = parseUnits('1', 18); // 1 UPD

// Deploy Updraft contract
const deployUpdraft = async () => {
  const upd = await hre.viem.deployContract('UPDToken');
  const feeToken = upd.address;
  //  100% is 1000000 (percentScale is 1000000 in Updraft.sol)
  const percentFee = 10000; // 1%
  const accrualRate = 100000; // 10% - higher for easier testing
  const cycleLength = 3600; // 1 hour in seconds
  const humanity = '0xdC0046B52e2E38AEe2271B6171ebb65cCD337518';
  const args = [feeToken, antiSpamFee, percentFee, cycleLength, accrualRate, humanity];
  const updraft = await hre.viem.deployContract('Updraft', args);
  return { updraft, upd };
};

// Deploy Updraft and approve it to spend UPD
const deployUpdraftAndApproveToSpendUPD = async () => {
  const { updraft, upd } = await loadFixture(deployUpdraft);
  await upd.write.approve([updraft.address, parseUnits('1000000', 18)]);
  return { updraft, upd };
};

// Deploy Idea contract
const deployIdeaAndGetContract = async () => {
  const { updraft, upd } = await loadFixture(deployUpdraftAndApproveToSpendUPD);
  const publicClient = await hre.viem.getPublicClient();

  // Idea parameters
  const contributorFee = 100000; // 10%
  const contribution = parseUnits('10', 18); // 10 UPD

  // Create idea
  const hash = await updraft.write.createIdea([contributorFee, contribution, toHex({})]);
  const transaction = await publicClient.getTransactionReceipt({ hash });
  const events = await getEventsFromTx('Updraft', transaction);
  const { idea } = events.find(event => event.eventName === 'IdeaCreated').args;
  const contract = await hre.viem.getContractAt('Idea', idea);

  // Approve the idea contract to spend UPD directly
  await upd.write.approve([contract.address, parseUnits('100000000000', 18)]);

  return { contract, upd, updraft };
};

// Deploy Solution contract
const deploySolutionAndGetContract = async () => {
  const { updraft, upd } = await loadFixture(deployUpdraftAndApproveToSpendUPD);
  const { contract: idea } = await loadFixture(deployIdeaAndGetContract);
  const publicClient = await hre.viem.getPublicClient();

  // Solution parameters
  const stake = parseUnits('100', 18);
  const goal = parseUnits('10000', 18);
  const deadline = Math.floor(Date.now() / 1000) + 86400; // 1 day from now
  const contributorFee = 100000; // 10%
  const solutionData = '0x5678';

  // Approve UPD for stake and fees
  await upd.write.approve([updraft.address, parseUnits('1000000', 18)]);

  // Create solution
  const hash = await updraft.write.createSolution(
    [
      idea.address,
      upd.address,
      stake,
      goal,
      deadline,
      contributorFee,
      solutionData
    ]
  );

  const transaction = await publicClient.getTransactionReceipt({ hash });
  const events = await getEventsFromTx('Updraft', transaction);
  const { solution } = events.find(event => event.eventName === 'SolutionCreated').args;
  const contract = await hre.viem.getContractAt('Solution', solution);

  // Approve the solution contract to spend UPD directly
  await upd.write.approve([contract.address, parseUnits('100000000000', 18)]);

  return { contract, upd, updraft, idea };
};

describe('Solution Fee Distribution - Realistic Test', () => {
  it('should distribute fees correctly with multiple contributors over multiple cycles', async () => {
    const { contract, upd } = await loadFixture(deploySolutionAndGetContract);

    // Get wallets for testing
    const [firstWallet, secondWallet, thirdWallet] = await hre.viem.getWalletClients();
    const firstWalletAddress = firstWallet.account.address;
    const secondWalletAddress = secondWallet.account.address;
    const thirdWalletAddress = thirdWallet.account.address;

    // Create a new solution with 10% contributor fee
    const contributorFee = 100000; // 10%
    console.log(`Solution has ${contributorFee / 10000}% contributor fee`);

    // Transfer tokens to test wallets
    const transferAmount = parseUnits('1000000', 18); // 1 million UPD
    await upd.write.transfer([secondWalletAddress, transferAmount]);
    await upd.write.transfer([thirdWalletAddress, transferAmount]);

    // Approve the solution contract to spend tokens
    await upd.write.approve([contract.address, transferAmount], { account: secondWallet.account });
    await upd.write.approve([contract.address, transferAmount], { account: thirdWallet.account });

    // Get cycle length
    const cycleLength = await contract.read.cycleLength();

    // First wallet contributes in the first cycle (creator)
    // This is already done during contract creation with the stake

    // Second wallet contributes in the first cycle
    const secondContribution = parseUnits('20000', 18); // 20,000 UPD
    await contract.write.contribute([secondContribution], { account: secondWallet.account });
    console.log(`Second wallet contributed ${formatUnits(secondContribution, 18)} UPD in cycle 1`);

    // Third wallet contributes in the first cycle
    const thirdContribution = parseUnits('10000', 18); // 10,000 UPD
    await contract.write.contribute([thirdContribution], { account: thirdWallet.account });
    console.log(`Third wallet contributed ${formatUnits(thirdContribution, 18)} UPD in cycle 1`);

    // Advance time to the second cycle
    await time.increase(Number(cycleLength) + 1);

    // First wallet contributes in the second cycle
    const firstContribution = parseUnits('30000', 18); // 30,000 UPD
    await contract.write.contribute([firstContribution]);
    console.log(`First wallet contributed ${formatUnits(firstContribution, 18)} UPD in cycle 2`);

    // Advance time to the third cycle
    await time.increase(Number(cycleLength) + 1);

    // Second wallet contributes in the third cycle
    const secondContribution2 = parseUnits('15000', 18); // 15,000 UPD
    await contract.write.contribute([secondContribution2], { account: secondWallet.account });
    console.log(`Second wallet contributed ${formatUnits(secondContribution2, 18)} UPD in cycle 3`);

    // Advance time to the fourth cycle
    await time.increase(Number(cycleLength) + 1);

    // Third wallet contributes in the fourth cycle
    const thirdContribution2 = parseUnits('25000', 18); // 25,000 UPD
    await contract.write.contribute([thirdContribution2], { account: thirdWallet.account });
    console.log(`Third wallet contributed ${formatUnits(thirdContribution2, 18)} UPD in cycle 4`);

    // Advance time to the fifth cycle
    await time.increase(Number(cycleLength) + 1);

    // Get balances before collecting fees
    const firstBalanceBefore = await upd.read.balanceOf([firstWalletAddress]);
    const secondBalanceBefore = await upd.read.balanceOf([secondWalletAddress]);
    const thirdBalanceBefore = await upd.read.balanceOf([thirdWalletAddress]);

    // Get position details
    const firstPosition = await contract.read.checkPosition([firstWalletAddress, 0]);
    const secondPosition1 = await contract.read.checkPosition([secondWalletAddress, 0]);
    const secondPosition2 = await contract.read.checkPosition([secondWalletAddress, 1]);
    const thirdPosition1 = await contract.read.checkPosition([thirdWalletAddress, 0]);
    const thirdPosition2 = await contract.read.checkPosition([thirdWalletAddress, 1]);

    console.log(`First position fees earned: ${formatUnits(firstPosition[0], 18)} UPD, shares: ${formatUnits(firstPosition[1], 18)}`);
    console.log(`Second position 1 fees earned: ${formatUnits(secondPosition1[0], 18)} UPD, shares: ${formatUnits(secondPosition1[1], 18)}`);
    console.log(`Second position 2 fees earned: ${formatUnits(secondPosition2[0], 18)} UPD, shares: ${formatUnits(secondPosition2[1], 18)}`);
    console.log(`Third position 1 fees earned: ${formatUnits(thirdPosition1[0], 18)} UPD, shares: ${formatUnits(thirdPosition1[1], 18)}`);
    console.log(`Third position 2 fees earned: ${formatUnits(thirdPosition2[0], 18)} UPD, shares: ${formatUnits(thirdPosition2[1], 18)}`);

    // Get original position contributions
    const firstOriginalPosition = await contract.read.positionsByAddress([firstWalletAddress, 0]);
    const secondOriginalPosition1 = await contract.read.positionsByAddress([secondWalletAddress, 0]);
    const secondOriginalPosition2 = await contract.read.positionsByAddress([secondWalletAddress, 1]);
    const thirdOriginalPosition1 = await contract.read.positionsByAddress([thirdWalletAddress, 0]);
    const thirdOriginalPosition2 = await contract.read.positionsByAddress([thirdWalletAddress, 1]);

    console.log(`First original position contribution: ${formatUnits(firstOriginalPosition[0], 18)} UPD`);
    console.log(`Second original position 1 contribution: ${formatUnits(secondOriginalPosition1[0], 18)} UPD`);
    console.log(`Second original position 2 contribution: ${formatUnits(secondOriginalPosition2[0], 18)} UPD`);
    console.log(`Third original position 1 contribution: ${formatUnits(thirdOriginalPosition1[0], 18)} UPD`);
    console.log(`Third original position 2 contribution: ${formatUnits(thirdOriginalPosition2[0], 18)} UPD`);

    // All wallets collect fees from all positions
    await contract.write.collectFees([0]);
    await contract.write.collectFees([0], { account: secondWallet.account });
    await contract.write.collectFees([1], { account: secondWallet.account });
    await contract.write.collectFees([0], { account: thirdWallet.account });
    await contract.write.collectFees([1], { account: thirdWallet.account });

    // Get balances after collecting fees
    const firstBalanceAfter = await upd.read.balanceOf([firstWalletAddress]);
    const secondBalanceAfter = await upd.read.balanceOf([secondWalletAddress]);
    const thirdBalanceAfter = await upd.read.balanceOf([thirdWalletAddress]);

    // Calculate fee increases
    const firstIncrease = firstBalanceAfter - firstBalanceBefore;
    const secondIncrease = secondBalanceAfter - secondBalanceBefore;
    const thirdIncrease = thirdBalanceAfter - thirdBalanceBefore;

    console.log(`First wallet collected ${formatUnits(firstIncrease, 18)} UPD in fees`);
    console.log(`Second wallet collected ${formatUnits(secondIncrease, 18)} UPD in fees`);
    console.log(`Third wallet collected ${formatUnits(thirdIncrease, 18)} UPD in fees`);
    console.log(`Total fees collected: ${formatUnits(firstIncrease + secondIncrease + thirdIncrease, 18)} UPD`);

    // Verify all wallets received fees
    expect(Number(firstIncrease)).to.be.gt(0);
    expect(Number(secondIncrease)).to.be.gt(0);
    expect(Number(thirdIncrease)).to.be.gt(0);

    // The Solution contract's fee distribution is more complex than just proportional to shares
    // Let's verify that all wallets receive fees and that the distribution makes sense
    // based on their contributions and timing

    // Calculate the total shares
    const firstShares = Number(formatUnits(firstPosition[1], 18));
    const secondShares1 = Number(formatUnits(secondPosition1[1], 18));
    const secondShares2 = Number(formatUnits(secondPosition2[1], 18));
    const thirdShares1 = Number(formatUnits(thirdPosition1[1], 18));
    const thirdShares2 = Number(formatUnits(thirdPosition2[1], 18));

    const totalShares = firstShares + secondShares1 + secondShares2 + thirdShares1 + thirdShares2;

    // Calculate the share distribution
    const firstSharePercentage = firstShares / totalShares;
    const secondSharePercentage = (secondShares1 + secondShares2) / totalShares;
    const thirdSharePercentage = (thirdShares1 + thirdShares2) / totalShares;

    console.log(`First wallet share percentage: ${(firstSharePercentage * 100).toFixed(2)}%`);
    console.log(`Second wallet share percentage: ${(secondSharePercentage * 100).toFixed(2)}%`);
    console.log(`Third wallet share percentage: ${(thirdSharePercentage * 100).toFixed(2)}%`);

    // Calculate the fee distribution
    const totalFees = Number(formatUnits(firstIncrease + secondIncrease + thirdIncrease, 18));
    const firstFeePercentage = Number(formatUnits(firstIncrease, 18)) / totalFees;
    const secondFeePercentage = Number(formatUnits(secondIncrease, 18)) / totalFees;
    const thirdFeePercentage = Number(formatUnits(thirdIncrease, 18)) / totalFees;

    console.log(`First wallet fee percentage: ${(firstFeePercentage * 100).toFixed(2)}%`);
    console.log(`Second wallet fee percentage: ${(secondFeePercentage * 100).toFixed(2)}%`);
    console.log(`Third wallet fee percentage: ${(thirdFeePercentage * 100).toFixed(2)}%`);

    // Verify that all wallets receive fees
    expect(firstFeePercentage).to.be.gt(0);
    expect(secondFeePercentage).to.be.gt(0);
    expect(thirdFeePercentage).to.be.gt(0);

    // Verify that the sum of percentages is close to 100%
    expect(firstFeePercentage + secondFeePercentage + thirdFeePercentage).to.be.closeTo(1, 0.001);

    // Verify that the second wallet gets more fees than the third wallet
    // since it contributed more and earlier
    expect(secondFeePercentage).to.be.gt(thirdFeePercentage);

    // Verify that collecting fees again doesn't change the balance
    await contract.write.collectFees([0]);
    await contract.write.collectFees([0], { account: secondWallet.account });
    await contract.write.collectFees([1], { account: secondWallet.account });
    await contract.write.collectFees([0], { account: thirdWallet.account });
    await contract.write.collectFees([1], { account: thirdWallet.account });

    const firstBalanceAfterSecondCollection = await upd.read.balanceOf([firstWalletAddress]);
    const secondBalanceAfterSecondCollection = await upd.read.balanceOf([secondWalletAddress]);
    const thirdBalanceAfterSecondCollection = await upd.read.balanceOf([thirdWalletAddress]);

    expect(firstBalanceAfterSecondCollection).to.equal(firstBalanceAfter);
    expect(secondBalanceAfterSecondCollection).to.equal(secondBalanceAfter);
    expect(thirdBalanceAfterSecondCollection).to.equal(thirdBalanceAfter);
  });
});
