import hre from 'hardhat';
import { parseUnits, toHex, formatUnits } from 'viem';
import { expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { getEventsFromTx, walletAddress } from './utilities/helpers.ts';
import { time } from "@nomicfoundation/hardhat-network-helpers";

// Constants for testing
const antiSpamFee = parseUnits('1', 18);

const deployUpdraft = async () => {
  const upd = await hre.viem.deployContract('UPDToken');
  const feeToken = upd.address;
  const percentFee = 10000; // 1%
  const accrualRate = 50000; // 5% - matching real world
  const cycleLength = 12 * 3600; // 12 hours - matching real world
  const faucet = '0xdC0046B52e2E38AEe2271B6171ebb65cCD337518';
  const args = [feeToken, antiSpamFee, percentFee, cycleLength, accrualRate, faucet];
  const updraft = await hre.viem.deployContract('Updraft', args);
  return { updraft, upd, faucet };
};

const deployUpdraftAndApproveToSpendUPD = async () => {
  const { updraft, upd, faucet } = await loadFixture(deployUpdraft);
  // Approve a very large amount to avoid allowance issues
  await upd.write.approve([updraft.address, parseUnits('10000000', 18)]);
  return { updraft, upd, faucet };
};

describe('Withdrawal Cycle Airdrop Bug', () => {
  it('should reproduce the bug where airdrop in withdrawal cycle gets skipped', async () => {
    const { updraft, upd, faucet } = await loadFixture(deployUpdraftAndApproveToSpendUPD);
    const publicClient = await hre.viem.getPublicClient();

    // Create idea with 5% contributor fee
    const contributorFee = 50000; // 5%
    const initialContribution = parseUnits('500', 18);
    const hash = await updraft.write.createIdea([contributorFee, initialContribution, toHex({})]);
    const transaction = await publicClient.getTransactionReceipt({hash});
    const events = await getEventsFromTx('Updraft', transaction);
    const { idea } = events.find(event => event.eventName === 'IdeaCreated').args;
    const contract = await hre.viem.getContractAt('Idea', idea);

    // Get wallet clients
    const [creatorWallet, contributorWallet, airdropperWallet] = await hre.viem.getWalletClients();
    
    // Transfer tokens to test wallets
    const transferAmount = parseUnits('1000000', 18);
    await upd.write.transfer([contributorWallet.account.address, transferAmount]);
    await upd.write.transfer([airdropperWallet.account.address, transferAmount]);
    await upd.write.approve([contract.address, transferAmount], { account: contributorWallet.account });
    await upd.write.approve([contract.address, transferAmount], { account: airdropperWallet.account });
    await upd.write.approve([contract.address, parseUnits('100000', 18)]);

    console.log('\n=== Setting up the bug scenario ===');
    
    // Contributor makes a contribution in first cycle
    const contribution = parseUnits('10000', 18);
    await contract.write.contribute([contribution], { account: contributorWallet.account });
    console.log(`Contributor contributed: ${formatUnits(contribution, 18)} UPD in first cycle`);

    // Get cycle length
    const cycleLength = await contract.read.cycleLength();
    
    // Advance to second cycle and make a contribution to create fees
    await time.increase(Number(cycleLength) + 1);
    const secondContribution = parseUnits('1000', 18);
    await contract.write.contribute([secondContribution]);
    console.log(`Creator contributed: ${formatUnits(secondContribution, 18)} UPD in second cycle`);

    // Advance to third cycle
    await time.increase(Number(cycleLength) + 1);
    
    // Check cycles before the critical sequence
    console.log('\n=== Cycles before critical sequence ===');
    for (let i = 0; i < 3; i++) {
      try {
        const cycle = await contract.read.cycles([BigInt(i)]);
        console.log(`Cycle ${i}: number=${cycle[0]}, shares=${formatUnits(cycle[1], 18)}, fees=${formatUnits(cycle[2], 18)}, hasContributions=${cycle[3]}`);
      } catch (e) {
        console.log(`Cycle ${i}: does not exist`);
        break;
      }
    }

    // Here's the critical sequence that causes the bug:
    console.log('\n=== Critical Bug Sequence ===');
    
    // Step 1: Someone withdraws, creating a cycle with hasContributions: false
    console.log('Step 1: Creator withdraws, creating a cycle with hasContributions: false');
    const creatorBalanceBefore = await upd.read.balanceOf([creatorWallet.account.address]);
    await contract.write.withdraw([0]); // Creator withdraws their initial position
    const creatorBalanceAfter = await upd.read.balanceOf([creatorWallet.account.address]);
    const creatorWithdrawn = creatorBalanceAfter - creatorBalanceBefore;
    console.log(`Creator withdrew: ${formatUnits(creatorWithdrawn, 18)} UPD`);

    // Check cycles after withdrawal
    console.log('\n=== Cycles after withdrawal ===');
    for (let i = 0; i < 5; i++) {
      try {
        const cycle = await contract.read.cycles([BigInt(i)]);
        console.log(`Cycle ${i}: number=${cycle[0]}, shares=${formatUnits(cycle[1], 18)}, fees=${formatUnits(cycle[2], 18)}, hasContributions=${cycle[3]}`);
      } catch (e) {
        console.log(`Cycle ${i}: does not exist`);
        break;
      }
    }

    // Step 2: Airdrop happens in the SAME cycle (this is the bug!)
    console.log('\nStep 2: Airdrop happens in the same cycle');
    const airdropAmount = parseUnits('100000', 18);
    await contract.write.airdrop([airdropAmount], { account: airdropperWallet.account });
    console.log(`Airdropped: ${formatUnits(airdropAmount, 18)} UPD in the same cycle as withdrawal`);

    // Check cycles after airdrop - the withdrawal cycle should be overwritten!
    console.log('\n=== Cycles after airdrop (BUG: withdrawal cycle overwritten!) ===');
    for (let i = 0; i < 5; i++) {
      try {
        const cycle = await contract.read.cycles([BigInt(i)]);
        console.log(`Cycle ${i}: number=${cycle[0]}, shares=${formatUnits(cycle[1], 18)}, fees=${formatUnits(cycle[2], 18)}, hasContributions=${cycle[3]}`);
      } catch (e) {
        console.log(`Cycle ${i}: does not exist`);
        break;
      }
    }

    // Advance time to distribute fees
    await time.increase(Number(cycleLength) + 1);
    await contract.write.contribute([antiSpamFee * 2n]);

    // Check positions before remaining withdrawals
    console.log('\n=== Positions Before Remaining Withdrawals ===');
    const contributorPosition1 = await contract.read.checkPosition([contributorWallet.account.address, 0]);
    const creatorPosition2 = await contract.read.checkPosition([creatorWallet.account.address, 1]);
    
    console.log(`Contributor position: ${formatUnits(contributorPosition1[0], 18)} UPD, shares: ${formatUnits(contributorPosition1[1], 18)}`);
    console.log(`Creator position 2: ${formatUnits(creatorPosition2[0], 18)} UPD, shares: ${formatUnits(creatorPosition2[1], 18)}`);

    // Get contract state before remaining withdrawals
    const totalTokensBefore = await contract.read.tokens();
    const contributorFeesBefore = await contract.read.contributorFees();
    console.log(`\nTotal tokens before remaining withdrawals: ${formatUnits(totalTokensBefore, 18)} UPD`);
    console.log(`Contributor fees before remaining withdrawals: ${formatUnits(contributorFeesBefore, 18)} UPD`);

    // Remaining withdrawals
    const contributorBalanceBefore = await upd.read.balanceOf([contributorWallet.account.address]);
    await contract.write.withdraw([0], { account: contributorWallet.account });
    const contributorBalanceAfter = await upd.read.balanceOf([contributorWallet.account.address]);
    const contributorWithdrawn = contributorBalanceAfter - contributorBalanceBefore;
    
    console.log(`\nContributor withdrew: ${formatUnits(contributorWithdrawn, 18)} UPD`);
    console.log(`Contributor deposited: ${formatUnits(contribution, 18)} UPD`);
    console.log(`Contributor gain: ${formatUnits(contributorWithdrawn - contribution, 18)} UPD`);

    // Final withdrawal
    await contract.write.withdraw([1]);

    // Check final contract state
    const finalTokens = await contract.read.tokens();
    const finalContributorFees = await contract.read.contributorFees();
    console.log(`\n=== Final Contract State ===`);
    console.log(`Tokens remaining: ${formatUnits(finalTokens, 18)} UPD`);
    console.log(`Contributor fees remaining: ${formatUnits(finalContributorFees, 18)} UPD`);

    // The bug: airdrop fees are lost because the cycle was overwritten
    if (finalTokens > parseUnits('50000', 18)) { // Significant amount stuck
      console.log(`🐛 BUG CONFIRMED: ${formatUnits(finalTokens, 18)} UPD stuck because airdrop cycle was overwritten!`);
      console.log(`The airdrop happened in a cycle created by withdrawal (hasContributions: false)`);
      console.log(`When the airdrop occurred, it overwrote that cycle instead of creating a new one`);
      console.log(`Future withdrawals skip the overwritten cycle, so airdrop fees are never distributed`);
    }

    // The contributor should have gotten a significant portion of the 100k airdrop
    const expectedMinimumGain = parseUnits('50000', 18); // Should get majority of 100k airdrop
    const actualGain = contributorWithdrawn - contribution;
    
    if (actualGain < expectedMinimumGain) {
      console.log(`🐛 AIRDROP DISTRIBUTION BUG: Contributor only gained ${formatUnits(actualGain, 18)} UPD from 100k airdrop`);
      console.log(`This is because the airdrop cycle was overwritten and skipped during fee distribution`);
    }
  });
});
