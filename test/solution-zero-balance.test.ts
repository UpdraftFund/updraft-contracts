import hre from 'hardhat';
import { parseUnits, toHex } from 'viem';
import { expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { getEventsFromTx, walletAddress } from './utilities/helpers.ts';
import { time } from "@nomicfoundation/hardhat-network-helpers";

const antiSpamFee = parseUnits('1', 18); // 1 UPD
const contribution = parseUnits('10', 18); // 10 UPD
const solutionData = { title: 'Test Solution', description: 'This is a test solution' };

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

const deployUpdraftAndApproveToSpendUPD = async () => {
  const { updraft, upd } = await loadFixture(deployUpdraft);
  await upd.write.approve([updraft.address, parseUnits('100000000000', 18)]);
  return { updraft, upd };
};

const deployIdeaAndGetContract = async () => {
  const { updraft, upd } = await loadFixture(deployUpdraftAndApproveToSpendUPD);
  const publicClient = await hre.viem.getPublicClient();
  //  100% is 1000000 (percentScale is 1000000 in Updraft.sol)
  const contributorFee = 100000; // 10% - higher for easier testing
  const hash = await updraft.write.createIdea([contributorFee, contribution, toHex({})]);
  const transaction = await publicClient.getTransactionReceipt({hash});
  const events = await getEventsFromTx('Updraft', transaction);
  const { idea } = events.find(event => event.eventName === 'IdeaCreated').args;
  const contract = await hre.viem.getContractAt('Idea', idea);
  return { contract, upd, updraft };
};

const deploySolutionAndGetContract = async () => {
  const { updraft, upd } = await loadFixture(deployUpdraftAndApproveToSpendUPD);
  const { contract: idea } = await loadFixture(deployIdeaAndGetContract);
  const publicClient = await hre.viem.getPublicClient();

  // Solution parameters
  const stake = parseUnits('100', 18);
  const goal = parseUnits('100', 18); // Small goal for testing
  const deadline = Math.floor(Date.now() / 1000) + 86400 * 7; // 7 days from now
  const contributorFee = 100000; // 10%

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
      toHex(solutionData)
    ]
  );

  const transaction = await publicClient.getTransactionReceipt({hash});
  const events = await getEventsFromTx('Updraft', transaction);
  const { solution } = events.find(event => event.eventName === 'SolutionCreated').args;
  const contract = await hre.viem.getContractAt('Solution', solution);

  return { contract, upd, updraft, idea };
};

describe('Solution Contract Fee Collection Test', () => {
  it('should allow all contributor fees to be fully collected', async () => {
    // Deploy the contract and get references
    const { contract, upd } = await loadFixture(deploySolutionAndGetContract);

    // Get wallet clients for testing
    const [firstWallet, secondWallet, thirdWallet] = await hre.viem.getWalletClients();
    const firstWalletAddress = firstWallet.account.address;
    const secondWalletAddress = secondWallet.account.address;
    const thirdWalletAddress = thirdWallet.account.address;

    // Transfer tokens to second and third wallets
    const transferAmount = parseUnits('100', 18);
    await upd.write.transfer([secondWalletAddress, transferAmount]);
    await upd.write.transfer([thirdWalletAddress, transferAmount]);

    // Approve the solution contract to spend tokens for all wallets
    await upd.write.approve([contract.address, parseUnits('1000', 18)]); // First wallet approval
    await upd.write.approve([contract.address, transferAmount], { account: secondWallet.account });
    await upd.write.approve([contract.address, transferAmount], { account: thirdWallet.account });

    console.log('\n--- Creating test scenario ---');

    // Get cycle length
    const cycleLength = await contract.read.cycleLength();

    // First wallet contributes in the first cycle
    const firstContribution = parseUnits('50', 18);
    await contract.write.contribute([firstContribution]);
    console.log('First wallet contributed in first cycle');

    // Second wallet contributes in the first cycle
    const secondContribution = parseUnits('20', 18);
    await contract.write.contribute([secondContribution], { account: secondWallet.account });
    console.log('Second wallet contributed in first cycle');

    // Third wallet contributes in the first cycle
    const thirdContribution = parseUnits('30', 18);
    await contract.write.contribute([thirdContribution], { account: thirdWallet.account });
    console.log('Third wallet contributed in first cycle');

    // Advance time to the second cycle
    await time.increase(Number(cycleLength) + 1);
    console.log('Advanced to second cycle');

    // First wallet contributes in the second cycle
    const firstContributionSecondCycle = parseUnits('15', 18);
    await contract.write.contribute([firstContributionSecondCycle]);
    console.log('First wallet contributed in second cycle');

    // Advance time to the third cycle
    await time.increase(Number(cycleLength) + 1);
    console.log('Advanced to third cycle');

    // Second wallet contributes in the third cycle
    const secondContributionThirdCycle = parseUnits('25', 18);
    await contract.write.contribute([secondContributionThirdCycle], { account: secondWallet.account });
    console.log('Second wallet contributed in third cycle');

    // Advance time to the fourth cycle
    await time.increase(Number(cycleLength) + 1);
    console.log('Advanced to fourth cycle');

    // Make a small contribution to update cycles
    await contract.write.contribute([antiSpamFee * 2n]);
    console.log('First wallet made small contribution in fourth cycle');

    // Get the token contract
    const tokenAddress = await contract.read.fundingToken();
    const token = await hre.viem.getContractAt('IERC20', tokenAddress);

    // Log the contract balance before fee collection
    const balanceBeforeCollection = await token.read.balanceOf([contract.address]);
    console.log(`\nContract balance before fee collection: ${balanceBeforeCollection}`);

    // Log the contract's internal token tracking before fee collection
    const tokensContributed = await contract.read.tokensContributed();
    const tokensWithdrawn = await contract.read.tokensWithdrawn();
    console.log(`Contract tokensContributed: ${tokensContributed}`);
    console.log(`Contract tokensWithdrawn: ${tokensWithdrawn}`);
    console.log(`Contract totalTokens: ${tokensContributed - tokensWithdrawn}`);

    // Get all positions for each wallet
    const firstWalletPositions = await contract.read.numPositions([firstWalletAddress]);
    const secondWalletPositions = await contract.read.numPositions([secondWalletAddress]);
    const thirdWalletPositions = await contract.read.numPositions([thirdWalletAddress]);

    console.log(`\nFirst wallet has ${firstWalletPositions} positions`);
    console.log(`Second wallet has ${secondWalletPositions} positions`);
    console.log(`Third wallet has ${thirdWalletPositions} positions`);

    // Log each position's details
    console.log('\n--- Position details ---');
    for (let i = 0; i < Number(firstWalletPositions); i++) {
      try {
        const [feesEarned, shares] = await contract.read.checkPosition([firstWalletAddress, BigInt(i)]);
        console.log(`First wallet position ${i}: feesEarned=${feesEarned}, shares=${shares}`);
      } catch (error) {
        console.log(`Error checking first wallet position ${i}: Position does not exist`);
      }
    }

    for (let i = 0; i < Number(secondWalletPositions); i++) {
      try {
        const [feesEarned, shares] = await contract.read.checkPosition([secondWalletAddress, BigInt(i)]);
        console.log(`Second wallet position ${i}: feesEarned=${feesEarned}, shares=${shares}`);
      } catch (error) {
        console.log(`Error checking second wallet position ${i}: Position does not exist`);
      }
    }

    for (let i = 0; i < Number(thirdWalletPositions); i++) {
      try {
        const [feesEarned, shares] = await contract.read.checkPosition([thirdWalletAddress, BigInt(i)]);
        console.log(`Third wallet position ${i}: feesEarned=${feesEarned}, shares=${shares}`);
      } catch (error) {
        console.log(`Error checking third wallet position ${i}: Position does not exist`);
      }
    }

    // Collect fees for all positions
    console.log('\n--- Collecting fees for all positions ---');

    // First wallet positions
    console.log('\nFirst wallet positions:');
    for (let i = 0; i < Number(firstWalletPositions); i++) {
      try {
        await contract.write.collectFees([BigInt(i)]);
        console.log(`Successfully collected fees for first wallet position ${i}`);
      } catch (error) {
        console.log(`Error collecting fees for first wallet position ${i}: ${error.message}`);
      }
    }

    // Second wallet positions
    console.log('\nSecond wallet positions:');
    for (let i = 0; i < Number(secondWalletPositions); i++) {
      try {
        await contract.write.collectFees([BigInt(i)], { account: secondWallet.account });
        console.log(`Successfully collected fees for second wallet position ${i}`);
      } catch (error) {
        console.log(`Error collecting fees for second wallet position ${i}: ${error.message}`);
      }
    }

    // Third wallet positions
    console.log('\nThird wallet positions:');
    for (let i = 0; i < Number(thirdWalletPositions); i++) {
      try {
        await contract.write.collectFees([BigInt(i)], { account: thirdWallet.account });
        console.log(`Successfully collected fees for third wallet position ${i}`);
      } catch (error) {
        console.log(`Error collecting fees for third wallet position ${i}: ${error.message}`);
      }
    }

    // Check the contract's token balance after fee collection
    const balanceAfterCollection = await token.read.balanceOf([contract.address]);
    console.log(`\nContract balance after fee collection: ${balanceAfterCollection}`);

    // Check the contract's internal token tracking after fee collection
    const tokensContributedAfter = await contract.read.tokensContributed();
    const tokensWithdrawnAfter = await contract.read.tokensWithdrawn();
    console.log(`Contract tokensContributed after: ${tokensContributedAfter}`);
    console.log(`Contract tokensWithdrawn after: ${tokensWithdrawnAfter}`);
    console.log(`Contract totalTokens after: ${tokensContributedAfter - tokensWithdrawnAfter}`);

    // Get information about cycles
    console.log('\n--- Cycle information ---');
    let cycleIndex = 0;
    let cycleExists = true;

    while (cycleExists) {
      try {
        const cycle = await contract.read.cycles([BigInt(cycleIndex)]);
        console.log(`Cycle ${cycleIndex}: number=${cycle[0]}, shares=${cycle[1]}, fees=${cycle[2]}, hasContributions=${cycle[3]}`);
        cycleIndex++;
      } catch (error) {
        cycleExists = false;
        console.log(`No more cycles after index ${cycleIndex - 1}`);
      }
    }

    // Calculate total contributor fees that should have been collected
    // Contributor fee is 10% of contributions after the first cycle
    const contributorFeePercent = await contract.read.contributorFee();
    const percentScale = await contract.read.percentScale();

    // Calculate expected contributor fees
    // First cycle contributions don't have contributor fees
    const firstCycleContributions = firstContribution + secondContribution + thirdContribution;
    const laterCycleContributions = firstContributionSecondCycle + secondContributionThirdCycle + (antiSpamFee * 2n);
    const expectedContributorFees = (laterCycleContributions * contributorFeePercent) / percentScale;

    console.log(`\nFirst cycle contributions: ${firstCycleContributions}`);
    console.log(`Later cycle contributions: ${laterCycleContributions}`);
    console.log(`Expected contributor fees: ${expectedContributorFees}`);

    // Calculate actual fees collected
    const totalFeesCollected = balanceBeforeCollection - balanceAfterCollection;
    console.log(`Actual fees collected: ${totalFeesCollected}`);

    // Calculate the difference
    const feesDifference = expectedContributorFees - totalFeesCollected;
    console.log(`Difference between expected and actual fees: ${feesDifference}`);

    // Verify that all contributor fees were collected
    // Allow for a small rounding error (up to 4 wei) due to multiple divisions
    const maxAllowedDifference = 4n;
    console.log(`Maximum allowed difference: ${maxAllowedDifference} wei`);

    // This test verifies that all contributor fees can be collected from the Solution contract
    const absDifference = feesDifference < 0n ? -feesDifference : feesDifference;
    expect(absDifference <= maxAllowedDifference).to.be.true;

    if (absDifference > 0n) {
      console.log(`Note: There was a difference of ${absDifference} wei, which is acceptable due to division rounding`);
    }

    // Also verify that the contract's internal accounting is correct
    const contributedMinusWithdrawn = tokensContributedAfter - tokensWithdrawnAfter;
    const expectedBalance = contributedMinusWithdrawn + 100000000000000000000n; // Add stake
    const balanceDifference = expectedBalance - balanceAfterCollection;

    console.log(`\nContract balance: ${balanceAfterCollection}`);
    console.log(`Expected balance (contributed - withdrawn + stake): ${expectedBalance}`);
    console.log(`Balance difference: ${balanceDifference}`);

    // Verify that the contract's balance matches its internal accounting
    const absBalanceDifference = balanceDifference < 0n ? -balanceDifference : balanceDifference;
    expect(absBalanceDifference <= maxAllowedDifference).to.be.true;

    if (absBalanceDifference > 0n) {
      console.log(`Note: There was a balance difference of ${absBalanceDifference} wei, which is acceptable due to division rounding`);
    }
  });
});

// Helper function to calculate total fees that should have been collected
async function calculateTotalFees(contract) {
  // Get all wallets
  const [firstWallet, secondWallet, thirdWallet] = await hre.viem.getWalletClients();
  const firstWalletAddress = firstWallet.account.address;
  const secondWalletAddress = secondWallet.account.address;
  const thirdWalletAddress = thirdWallet.account.address;

  // Get number of positions for each wallet
  const firstWalletPositions = await contract.read.numPositions([firstWalletAddress]);
  const secondWalletPositions = await contract.read.numPositions([secondWalletAddress]);
  const thirdWalletPositions = await contract.read.numPositions([thirdWalletAddress]);

  let totalFees = 0n;

  // Calculate fees for first wallet
  for (let i = 0; i < Number(firstWalletPositions); i++) {
    try {
      const [feesEarned] = await contract.read.checkPosition([firstWalletAddress, BigInt(i)]);
      totalFees += feesEarned;
    } catch (error) {
      // Skip positions that don't exist
    }
  }

  // Calculate fees for second wallet
  for (let i = 0; i < Number(secondWalletPositions); i++) {
    try {
      const [feesEarned] = await contract.read.checkPosition([secondWalletAddress, BigInt(i)]);
      totalFees += feesEarned;
    } catch (error) {
      // Skip positions that don't exist
    }
  }

  // Calculate fees for third wallet
  for (let i = 0; i < Number(thirdWalletPositions); i++) {
    try {
      const [feesEarned] = await contract.read.checkPosition([thirdWalletAddress, BigInt(i)]);
      totalFees += feesEarned;
    } catch (error) {
      // Skip positions that don't exist
    }
  }

  return totalFees;
}
