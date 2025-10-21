import hre from 'hardhat';
import { parseUnits, toHex } from 'viem';
import { expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { getEventsFromTx, walletAddress } from './utilities/helpers.ts';
import { time } from "@nomicfoundation/hardhat-network-helpers";

// Constants for testing
const contribution = parseUnits('10', 18);
const antiSpamFee = parseUnits('1', 18);

// Helper function to get max of two values
function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

const deployUpdraft = async () => {
  const upd = await hre.viem.deployContract('UPDToken');
  const feeToken = upd.address;
  //  100% is 1000000 (percentScale is 1000000 in Updraft.sol)
  const percentFee = 10000; // 1%
  const accrualRate = 100000; // 10% - higher for easier testing
  const cycleLength = 3600; // 1 hour in seconds
  const faucet = '0xdC0046B52e2E38AEe2271B6171ebb65cCD337518';
  const args = [feeToken, antiSpamFee, percentFee, cycleLength, accrualRate, faucet];
  const updraft = await hre.viem.deployContract('Updraft', args);
  return { updraft, upd, faucet };
};

const deployUpdraftAndApproveToSpendUPD = async () => {
  const { updraft, upd, faucet } = await loadFixture(deployUpdraft);
  await upd.write.approve([updraft.address, parseUnits('100000000000', 18)]);
  return { updraft, upd, faucet };
};

describe('Idea Contract Fee Distribution Test', () => {
  it('should distribute all contributor fees correctly and leave no tokens in the contract', async () => {
    // Deploy a fresh contract for this test
    const { updraft, upd, faucet } = await loadFixture(deployUpdraftAndApproveToSpendUPD);
    const publicClient = await hre.viem.getPublicClient();

    // Create a new idea with 10% contributor fee
    const contributorFee = 100000; // 10%
    const initialContribution = parseUnits('10', 18); // 10 UPD
    const hash = await updraft.write.createIdea([contributorFee, initialContribution, toHex({})]);
    const transaction = await publicClient.getTransactionReceipt({hash});
    const events = await getEventsFromTx('Updraft', transaction);
    const { idea } = events.find(event => event.eventName === 'IdeaCreated').args;
    const contract = await hre.viem.getContractAt('Idea', idea);

    // Get wallet clients for testing
    const [firstWallet, secondWallet, thirdWallet] = await hre.viem.getWalletClients();
    const firstWalletAddress = firstWallet.account.address;
    const secondWalletAddress = secondWallet.account.address;
    const thirdWalletAddress = thirdWallet.account.address;

    // Transfer tokens to test wallets
    const transferAmount = parseUnits('100', 18);
    await upd.write.transfer([secondWalletAddress, transferAmount]);
    await upd.write.transfer([thirdWalletAddress, transferAmount]);

    // Approve the idea contract to spend tokens
    await upd.write.approve([contract.address, parseUnits('1000', 18)]); // First wallet approval
    await upd.write.approve([contract.address, transferAmount], { account: secondWallet.account });
    await upd.write.approve([contract.address, transferAmount], { account: thirdWallet.account });

    // Get cycle length and other contract parameters
    const cycleLength = await contract.read.cycleLength();
    const percentScale = await contract.read.percentScale();

    // Get the token contract
    const tokenAddress = await contract.read.token();
    const token = await hre.viem.getContractAt('IERC20', tokenAddress);

    // Helper function to log contract state
    async function logContractState(label: string) {
      const contractBalance = await token.read.balanceOf([contract.address]);
      const contractTokens = await contract.read.tokens();
      const contributorFees = await contract.read.contributorFees();

      console.log(`\n--- ${label} ---`);
      console.log(`Contract balance: ${contractBalance}`);
      console.log(`Contract tokens: ${contractTokens}`);
      console.log(`Contributor fees: ${contributorFees}`);

      // Log cycle information
      let cyclesLength = 0;
      try {
        // Keep incrementing the index until we get an error
        while (true) {
          await contract.read.cycles([BigInt(cyclesLength)]);
          cyclesLength++;
        }
      } catch (error) {
        // We've reached the end of the cycles array
      }
      console.log(`\nCycles: ${cyclesLength}`);

      for (let i = 0; i < cyclesLength; i++) {
        try {
          const cycle = await contract.read.cycles([BigInt(i)]);
          console.log(`Cycle ${i}: number=${cycle[0]}, shares=${cycle[1]}, fees=${cycle[2]}, hasContributions=${cycle[3]}`);
        } catch (error) {
          console.log(`Error reading cycle ${i}: ${error.message}`);
        }
      }
    }

    console.log('\n--- Creating test scenario ---');
    await logContractState('Initial state');

    // Initial contribution was already made during contract creation
    console.log('\nInitial contribution made during contract creation');
    const firstContribution = initialContribution;
    const firstContributionAfterFee = firstContribution - antiSpamFee;

    // Second wallet contributes in the first cycle
    const secondContribution = parseUnits('20', 18);
    await contract.write.contribute([secondContribution], { account: secondWallet.account });
    console.log('\nSecond wallet contributed in first cycle');
    const secondContributionAfterFee = secondContribution - antiSpamFee;
    await logContractState('After second wallet contribution in first cycle');

    // Third wallet contributes in the first cycle
    const thirdContribution = parseUnits('30', 18);
    await contract.write.contribute([thirdContribution], { account: thirdWallet.account });
    console.log('\nThird wallet contributed in first cycle');
    const thirdContributionAfterFee = thirdContribution - antiSpamFee;
    await logContractState('After third wallet contribution in first cycle');

    // Advance time to the second cycle
    await time.increase(Number(cycleLength) + 1);
    console.log('\nAdvanced to second cycle');
    await logContractState('After advancing to second cycle');

    // First wallet contributes in the second cycle
    const firstContributionSecondCycle = parseUnits('15', 18);
    await contract.write.contribute([firstContributionSecondCycle]);
    console.log('\nFirst wallet contributed in second cycle');
    const firstContributionSecondCycleAfterFee = firstContributionSecondCycle - antiSpamFee;
    const firstContributionSecondCycleContributorFee = firstContributionSecondCycleAfterFee * BigInt(contributorFee) / BigInt(percentScale);
    await logContractState('After first wallet contribution in second cycle');

    // Second wallet contributes in the second cycle
    const secondContributionSecondCycle = parseUnits('25', 18);
    await contract.write.contribute([secondContributionSecondCycle], { account: secondWallet.account });
    console.log('\nSecond wallet contributed in second cycle');
    const secondContributionSecondCycleAfterFee = secondContributionSecondCycle - antiSpamFee;
    const secondContributionSecondCycleContributorFee = secondContributionSecondCycleAfterFee * BigInt(contributorFee) / BigInt(percentScale);
    await logContractState('After second wallet contribution in second cycle');

    // Advance time to the third cycle
    await time.increase(Number(cycleLength) + 1);
    console.log('\nAdvanced to third cycle');
    await logContractState('After advancing to third cycle');

    // Third wallet contributes in the third cycle
    const thirdContributionThirdCycle = parseUnits('35', 18);
    await contract.write.contribute([thirdContributionThirdCycle], { account: thirdWallet.account });
    console.log('\nThird wallet contributed in third cycle');
    const thirdContributionThirdCycleAfterFee = thirdContributionThirdCycle - antiSpamFee;
    const thirdContributionThirdCycleContributorFee = thirdContributionThirdCycleAfterFee * BigInt(contributorFee) / BigInt(percentScale);
    await logContractState('After third wallet contribution in third cycle');

    // Advance time to the fourth cycle to ensure all fees are distributed
    await time.increase(Number(cycleLength) + 1);
    console.log('\nAdvanced to fourth cycle');

    // Make a small contribution to update cycles
    const finalContribution = parseUnits('5', 18);
    await contract.write.contribute([finalContribution]);
    console.log('\nFirst wallet made small contribution in fourth cycle');
    const finalContributionAfterFee = finalContribution - antiSpamFee;
    const finalContributionContributorFee = finalContributionAfterFee * BigInt(contributorFee) / BigInt(percentScale);
    await logContractState('After final contribution in fourth cycle');

    // Calculate total contributions and expected contributor fees
    const totalContributions = firstContribution + secondContribution + thirdContribution +
                              firstContributionSecondCycle + secondContributionSecondCycle +
                              thirdContributionThirdCycle + finalContribution;

    const totalAntiSpamFees = antiSpamFee * 7n; // 7 contributions

    const totalContributorFees = firstContributionSecondCycleContributorFee +
                                secondContributionSecondCycleContributorFee +
                                thirdContributionThirdCycleContributorFee +
                                finalContributionContributorFee;

    const expectedNetContributions = totalContributions - totalAntiSpamFees;

    console.log('\n--- Contribution Summary ---');
    console.log(`Total contributions: ${totalContributions}`);
    console.log(`Total anti-spam fees: ${totalAntiSpamFees}`);
    console.log(`Total contributor fees: ${totalContributorFees}`);
    console.log(`Expected net contributions: ${expectedNetContributions}`);

    // Get contract balance before withdrawals
    const balanceBeforeWithdrawals = await token.read.balanceOf([contract.address]);
    console.log(`\nContract balance before withdrawals: ${balanceBeforeWithdrawals}`);

    // Withdraw all positions
    console.log('\n--- Withdrawing all positions ---');

    // First wallet positions
    console.log('\nFirst wallet positions:');
    const firstWalletPositions = await contract.read.numPositions([firstWalletAddress]);
    console.log(`First wallet has ${firstWalletPositions} positions`);

    let firstWalletWithdrawn = 0n;
    for (let i = 0; i < Number(firstWalletPositions); i++) {
      try {
        const balanceBefore = await token.read.balanceOf([firstWalletAddress]);
        await contract.write.withdraw([BigInt(i)]);
        const balanceAfter = await token.read.balanceOf([firstWalletAddress]);
        const withdrawn = balanceAfter - balanceBefore;
        firstWalletWithdrawn += withdrawn;
        console.log(`Successfully withdrew first wallet position ${i}: ${withdrawn}`);
        await logContractState(`After first wallet position ${i} withdrawal`);
      } catch (error) {
        console.log(`Error withdrawing first wallet position ${i}: ${error.message}`);
      }
    }
    console.log(`Total withdrawn by first wallet: ${firstWalletWithdrawn}`);

    // Second wallet positions
    console.log('\nSecond wallet positions:');
    const secondWalletPositions = await contract.read.numPositions([secondWalletAddress]);
    console.log(`Second wallet has ${secondWalletPositions} positions`);

    let secondWalletWithdrawn = 0n;
    for (let i = 0; i < Number(secondWalletPositions); i++) {
      try {
        const balanceBefore = await token.read.balanceOf([secondWalletAddress]);
        await contract.write.withdraw([BigInt(i)], { account: secondWallet.account });
        const balanceAfter = await token.read.balanceOf([secondWalletAddress]);
        const withdrawn = balanceAfter - balanceBefore;
        secondWalletWithdrawn += withdrawn;
        console.log(`Successfully withdrew second wallet position ${i}: ${withdrawn}`);
        await logContractState(`After second wallet position ${i} withdrawal`);
      } catch (error) {
        console.log(`Error withdrawing second wallet position ${i}: ${error.message}`);
      }
    }
    console.log(`Total withdrawn by second wallet: ${secondWalletWithdrawn}`);

    // Third wallet positions
    console.log('\nThird wallet positions:');
    const thirdWalletPositions = await contract.read.numPositions([thirdWalletAddress]);
    console.log(`Third wallet has ${thirdWalletPositions} positions`);

    let thirdWalletWithdrawn = 0n;
    for (let i = 0; i < Number(thirdWalletPositions); i++) {
      try {
        const balanceBefore = await token.read.balanceOf([thirdWalletAddress]);
        await contract.write.withdraw([BigInt(i)], { account: thirdWallet.account });
        const balanceAfter = await token.read.balanceOf([thirdWalletAddress]);
        const withdrawn = balanceAfter - balanceBefore;
        thirdWalletWithdrawn += withdrawn;
        console.log(`Successfully withdrew third wallet position ${i}: ${withdrawn}`);
        await logContractState(`After third wallet position ${i} withdrawal`);
      } catch (error) {
        console.log(`Error withdrawing third wallet position ${i}: ${error.message}`);
      }
    }
    console.log(`Total withdrawn by third wallet: ${thirdWalletWithdrawn}`);

    // Calculate the total contributions by each wallet (minus anti-spam fees)
    const firstWalletContributions = firstContributionAfterFee + firstContributionSecondCycleAfterFee + finalContributionAfterFee;
    const secondWalletContributions = secondContributionAfterFee + secondContributionSecondCycleAfterFee;
    const thirdWalletContributions = thirdContributionAfterFee + thirdContributionThirdCycleAfterFee;

    console.log(`\nFirst wallet contributions: ${firstWalletContributions}`);
    console.log(`First wallet withdrawals: ${firstWalletWithdrawn}`);
    console.log(`First wallet profit: ${firstWalletWithdrawn - firstWalletContributions}`);

    console.log(`\nSecond wallet contributions: ${secondWalletContributions}`);
    console.log(`Second wallet withdrawals: ${secondWalletWithdrawn}`);
    console.log(`Second wallet profit: ${secondWalletWithdrawn - secondWalletContributions}`);

    console.log(`\nThird wallet contributions: ${thirdWalletContributions}`);
    console.log(`Third wallet withdrawals: ${thirdWalletWithdrawn}`);
    console.log(`Third wallet profit: ${thirdWalletWithdrawn - thirdWalletContributions}`);

    // Calculate total withdrawn
    const totalWithdrawn = firstWalletWithdrawn + secondWalletWithdrawn + thirdWalletWithdrawn;
    console.log(`\nTotal withdrawn: ${totalWithdrawn}`);

    // Check the contract's final balance
    const contractBalance = await token.read.balanceOf([contract.address]);
    console.log(`Contract final balance: ${contractBalance}`);

    // Check the contract's internal token tracking
    const contractTokens = await contract.read.tokens();
    console.log(`Contract internal tokens tracking: ${contractTokens}`);

    // Check the contract's contributorFees
    const finalContributorFees = await contract.read.contributorFees();
    console.log(`Contract contributorFees: ${finalContributorFees}`);

    // Verify that all tokens were withdrawn
    console.log('\n--- Verification ---');
    console.log(`Expected net contributions: ${expectedNetContributions}`);
    console.log(`Total withdrawn: ${totalWithdrawn}`);
    console.log(`Difference: ${expectedNetContributions - totalWithdrawn}`);
    console.log(`Tokens left in contract: ${contractBalance}`);
    console.log(`contributorFees left: ${finalContributorFees}`);

    // Assert that the contract balance is zero
    expect(contractBalance).to.equal(0n, "Contract should have zero balance after all withdrawals");

    // Assert that the contract's internal token tracking is zero
    expect(contractTokens).to.equal(0n, "Contract's internal token tracking should be zero after all withdrawals");

    // Assert that the contract's contributorFees is zero
    expect(finalContributorFees).to.equal(0n, "Contract's contributorFees should be zero after all withdrawals");

    // Assert that the total withdrawn equals the expected net contributions
    expect(totalWithdrawn).to.equal(expectedNetContributions, "Total withdrawn should equal expected net contributions");
  });
});
