import hre from 'hardhat';
import { parseUnits, toHex, formatUnits } from 'viem';
import { expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { getEventsFromTx, walletAddress } from './utilities/helpers.ts';
import { time } from "@nomicfoundation/hardhat-network-helpers";

// Constants for testing
const antiSpamFee = parseUnits('1', 18);

// Helper function to format bigint values for better readability
function formatBigInt(value: bigint): string {
  return formatUnits(value, 18);
}

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
  return { updraft, upd, humanity };
};

const deployUpdraftAndApproveToSpendUPD = async () => {
  const { updraft, upd, humanity } = await loadFixture(deployUpdraft);
  // Approve a very large amount to avoid allowance issues
  await upd.write.approve([updraft.address, parseUnits('10000000', 18)]);
  return { updraft, upd, humanity };
};

describe('Idea Contract Fee Distribution with Realistic Amounts', () => {
  it('should handle fee distribution with realistic UPD amounts and many cycles/positions', async () => {
    // Deploy a fresh contract for this test
    const { updraft, upd, humanity } = await loadFixture(deployUpdraftAndApproveToSpendUPD);
    const publicClient = await hre.viem.getPublicClient();

    // Create a new idea with 10% contributor fee
    const contributorFee = 100000; // 10%
    console.log(`Creating idea with ${contributorFee / 10000}% contributor fee`);
    const initialContribution = parseUnits('500', 18); // 500 UPD
    const hash = await updraft.write.createIdea([contributorFee, initialContribution, toHex({})]);
    const transaction = await publicClient.getTransactionReceipt({hash});
    const events = await getEventsFromTx('Updraft', transaction);
    const { idea } = events.find(event => event.eventName === 'IdeaCreated').args;
    const contract = await hre.viem.getContractAt('Idea', idea);

    // Get wallet clients for testing - we'll use 5 wallets
    const [firstWallet, secondWallet, thirdWallet, fourthWallet, fifthWallet] = await hre.viem.getWalletClients();
    const wallets = [firstWallet, secondWallet, thirdWallet, fourthWallet, fifthWallet];
    const walletAddresses = wallets.map(wallet => wallet.account.address);
    const walletNames = ["First", "Second", "Third", "Fourth", "Fifth"];

    // Transfer tokens to test wallets
    for (let i = 1; i < wallets.length; i++) {
      const transferAmount = parseUnits('10000', 18);
      await upd.write.transfer([walletAddresses[i], transferAmount]);
      await upd.write.approve([contract.address, transferAmount], { account: wallets[i].account });
    }

    // Get cycle length and other parameters
    const cycleLength = await contract.read.cycleLength();
    const percentScale = await contract.read.percentScale();

    // Helper function to log the contributorFees variable
    const logContributorFees = async () => {
      const contributorFees = await contract.read.contributorFees();
      console.log(`contributorFees: ${formatBigInt(contributorFees)} UPD`);
    };

    // Arrays to track position details
    type Position = {
      wallet: string;
      walletIndex: number;
      positionIndex: number;
      cycle: number;
      contribution: bigint;
      contributionAfterFee: bigint;
      contributorFeePaid: bigint;
      actualWithdrawn: bigint;
    };

    const positions: Position[] = [];

    // Helper function to add a position to our tracking
    const addPosition = (
      wallet: string,
      walletIndex: number,
      positionIndex: number,
      cycle: number,
      contribution: bigint,
      contributionAfterFee: bigint,
      contributorFeePaid: bigint
    ) => {
      positions.push({
        wallet,
        walletIndex,
        positionIndex,
        cycle,
        contribution,
        contributionAfterFee,
        contributorFeePaid,
        actualWithdrawn: 0n
      });
    };

    console.log('\n--- Creating test scenario with realistic amounts ---');
    await logContributorFees();

    // Initial contribution was already made during contract creation
    console.log('Initial contribution made during contract creation (500 UPD)');
    const firstContribution = initialContribution;
    const firstContributionAfterFee = firstContribution - antiSpamFee;
    // No contributor fee in first cycle
    addPosition(
      "First",
      0,
      0,
      0,
      firstContribution,
      firstContributionAfterFee,
      0n
    );

    // Create 10 cycles with multiple contributions in each
    for (let cycle = 0; cycle < 10; cycle++) {
      console.log(`\n--- Cycle ${cycle} ---`);

      // Each wallet makes a contribution in this cycle
      for (let walletIndex = 0; walletIndex < wallets.length; walletIndex++) {
        // Skip first wallet in first cycle since it already contributed during creation
        if (cycle === 0 && walletIndex === 0) continue;

        // Vary contribution amounts to make it more realistic
        const baseAmount = 100 + (walletIndex * 50) + (cycle * 20);
        const contribution = parseUnits(baseAmount.toString(), 18);

        // Ensure we have enough allowance for each contribution
        if (walletIndex === 0) {
          await upd.write.approve([contract.address, contribution]);
          await contract.write.contribute([contribution]);
        } else {
          await upd.write.approve([contract.address, contribution], { account: wallets[walletIndex].account });
          await contract.write.contribute([contribution], { account: wallets[walletIndex].account });
        }

        console.log(`${walletNames[walletIndex]} wallet contributed ${baseAmount} UPD in cycle ${cycle}`);

        const contributionAfterFee = contribution - antiSpamFee;
        let contributorFeePaid = 0n;

        // No contributor fee in first cycle
        if (cycle > 0) {
          contributorFeePaid = contributionAfterFee * BigInt(contributorFee) / BigInt(percentScale);
        }

        // Get the position index
        const positionIndex = await contract.read.numPositions([walletAddresses[walletIndex]]) - 1n;

        addPosition(
          walletNames[walletIndex],
          walletIndex,
          Number(positionIndex),
          cycle,
          contribution,
          contributionAfterFee,
          contributorFeePaid
        );
      }

      // Advance time to the next cycle
      await time.increase(Number(cycleLength) + 1);
      console.log(`Advanced to cycle ${cycle + 1}`);
      await logContributorFees();
    }

    // Make a final small contribution to update cycles
    const finalContribution = antiSpamFee * 2n;
    // Ensure we have enough allowance for the final contribution
    await upd.write.approve([contract.address, finalContribution]);
    await contract.write.contribute([finalContribution]);
    console.log('\nFirst wallet made small contribution in final cycle');
    const finalContributionAfterFee = finalContribution - antiSpamFee;
    const finalContributionContributorFee = finalContributionAfterFee * BigInt(contributorFee) / BigInt(percentScale);

    // Get the position index
    const finalPositionIndex = await contract.read.numPositions([walletAddresses[0]]) - 1n;

    addPosition(
      "First",
      0,
      Number(finalPositionIndex),
      10,
      finalContribution,
      finalContributionAfterFee,
      finalContributionContributorFee
    );

    await logContributorFees();

    // Get the token contract
    const tokenAddress = await contract.read.token();
    const token = await hre.viem.getContractAt('IERC20', tokenAddress);

    // Calculate total contributions and expected contributor fees
    let totalContributions = 0n;
    let totalAntiSpamFees = 0n;
    let totalContributorFees = 0n;

    for (const position of positions) {
      totalContributions += position.contribution;
      totalAntiSpamFees += (position.contribution - position.contributionAfterFee);
      totalContributorFees += position.contributorFeePaid;
    }

    const expectedNetContributions = totalContributions - totalAntiSpamFees;

    // Log the contract balance before withdrawals
    const balanceBeforeWithdrawals = await token.read.balanceOf([contract.address]);
    console.log(`\nContract balance before withdrawals: ${formatBigInt(balanceBeforeWithdrawals)} UPD`);

    // Log the contract's internal token tracking before withdrawals
    const tokensBeforeWithdrawals = await contract.read.tokens();
    console.log(`Contract internal tokens tracking before withdrawals: ${formatBigInt(tokensBeforeWithdrawals)} UPD`);

    // Log expected values
    console.log(`\nTotal contributions: ${formatBigInt(totalContributions)} UPD`);
    console.log(`Total anti-spam fees: ${formatBigInt(totalAntiSpamFees)} UPD`);
    console.log(`Total contributor fees: ${formatBigInt(totalContributorFees)} UPD`);
    console.log(`Expected net contributions: ${formatBigInt(expectedNetContributions)} UPD`);

    // Get all positions for each wallet
    const walletPositions = [];
    for (let i = 0; i < wallets.length; i++) {
      const numPositions = await contract.read.numPositions([walletAddresses[i]]);
      walletPositions.push(Number(numPositions));
      console.log(`${walletNames[i]} wallet has ${numPositions} positions`);
    }

    // Get all cycles
    let cyclesCount = 0;
    try {
      // Keep trying to read cycles until we get an error
      while (true) {
        await contract.read.cycles([BigInt(cyclesCount)]);
        cyclesCount++;
      }
    } catch (error) {
      // We've reached the end of the cycles array
      console.log(`Found ${cyclesCount} cycles`);
    }

    // Helper function to check position details before withdrawal
    const checkPositionDetails = async (walletName: string, walletIndex: number, positionIndex: number, walletAddress: string, walletAccount?: any) => {
      try {
        // Check position using contract's checkPosition function
        let positionDetails;
        if (walletAccount) {
          positionDetails = await contract.read.checkPosition([walletAddress, BigInt(positionIndex)], { account: walletAccount });
        } else {
          positionDetails = await contract.read.checkPosition([walletAddress, BigInt(positionIndex)]);
        }

        // Get contract balance
        const contractBalance = await token.read.balanceOf([contract.address]);
        const contractTokens = await contract.read.tokens();
        const contributorFees = await contract.read.contributorFees();

        // Find the position in our tracking
        const position = positions.find(p => p.wallet === walletName && p.positionIndex === positionIndex);
        if (position) {
          // Calculate the original contribution amount (after anti-spam fee but before contributor fee)
          const originalContribution = position.contributionAfterFee - position.contributorFeePaid;

          // Get the original position tokens from the contract
          let originalPositionTokens = 0n;
          try {
            const positionData = await contract.read.positionsByAddress([walletAddress, BigInt(positionIndex)]);
            originalPositionTokens = positionData[1]; // tokens field in Position struct
          } catch (error) {
            console.log(`Error getting original position: ${error.message}`);
          }

          // Calculate fees that would be earned in this withdrawal
          const feesToBeEarned = positionDetails[0] - originalPositionTokens;

          console.log(`Position check for ${walletName} wallet position ${positionIndex}:`);
          console.log(`  Original contribution: ${formatBigInt(originalContribution)} UPD`);
          console.log(`  Position details from contract:`);
          console.log(`    Tokens from checkPosition: ${formatBigInt(positionDetails[0])} UPD`);
          console.log(`    Original position tokens: ${formatBigInt(originalPositionTokens)} UPD`);
          console.log(`    Fees to be earned: ${formatBigInt(feesToBeEarned)} UPD`);
          console.log(`    Shares: ${formatBigInt(positionDetails[1])} shares`);
          console.log(`  Contract state:`);
          console.log(`    Contract balance: ${formatBigInt(contractBalance)} UPD`);
          console.log(`    Contract tokens: ${formatBigInt(contractTokens)} UPD`);
          console.log(`    Contributor fees: ${formatBigInt(contributorFees)} UPD`);

          // Check if position is trying to withdraw more than what's left
          if (positionDetails[0] > contractBalance) {
            console.log(`  WARNING: Position is trying to withdraw ${formatBigInt(positionDetails[0])} UPD, but contract only has ${formatBigInt(contractBalance)} UPD`);
            console.log(`  Difference: ${formatBigInt(positionDetails[0] - contractBalance)} UPD`);
          }

          // Check if position is trying to withdraw more fees than available
          if (feesToBeEarned > contributorFees) {
            console.log(`  WARNING: Position is trying to withdraw ${formatBigInt(feesToBeEarned)} UPD in fees, but contract only has ${formatBigInt(contributorFees)} UPD in contributorFees`);
            console.log(`  Difference: ${formatBigInt(feesToBeEarned - contributorFees)} UPD`);
            console.log(`  This will likely cause an underflow in the contributorFees subtraction!`);
          }

          return positionDetails;
        }

        return [0n, 0n];
      } catch (error) {
        console.log(`Error checking ${walletName} wallet position ${positionIndex}: ${error.message}`);
        return [0n, 0n];
      }
    };

    // Helper function to track wallet balances and contributor fees during withdrawals
    const trackWithdrawal = async (walletName: string, walletIndex: number, positionIndex: number, walletAddress: string, walletAccount?: any) => {
      try {
        // First check the position details
        await checkPositionDetails(walletName, walletIndex, positionIndex, walletAddress, walletAccount);

        // Get balances and contributor fees before withdrawal
        const balanceBefore = await token.read.balanceOf([walletAddress]);
        const contributorFeesBefore = await contract.read.contributorFees();

        // Perform the withdrawal
        if (walletAccount) {
          await contract.write.withdraw([BigInt(positionIndex)], { account: walletAccount });
        } else {
          await contract.write.withdraw([BigInt(positionIndex)]);
        }

        // Get balances and contributor fees after withdrawal
        const balanceAfter = await token.read.balanceOf([walletAddress]);
        const contributorFeesAfter = await contract.read.contributorFees();

        // Calculate changes
        const withdrawn = balanceAfter - balanceBefore;
        const contributorFeesChange = contributorFeesBefore - contributorFeesAfter;

        // Find the position in our tracking
        const position = positions.find(p => p.wallet === walletName && p.positionIndex === positionIndex);
        if (position) {
          position.actualWithdrawn = withdrawn;

          // Calculate the original contribution amount (after anti-spam fee but before contributor fee)
          const originalContribution = position.contributionAfterFee - position.contributorFeePaid;

          // Calculate fees earned
          const feesEarned = withdrawn - originalContribution;

          console.log(`Successfully withdrew ${walletName} wallet position ${positionIndex}:`);
          console.log(`  Withdrawn amount: ${formatBigInt(withdrawn)} UPD`);
          console.log(`  Original contribution: ${formatBigInt(originalContribution)} UPD`);
          console.log(`  Fees earned: ${formatBigInt(feesEarned)} UPD`);
          console.log(`  Contributor fees change: ${formatBigInt(contributorFeesChange)} UPD`);
          console.log(`  Contributor fees remaining: ${formatBigInt(contributorFeesAfter)} UPD`);

          return withdrawn;
        }

        return 0n;
      } catch (error) {
        console.log(`Error withdrawing ${walletName} wallet position ${positionIndex}: ${error.message}`);
        return 0n;
      }
    };

    // Withdraw all positions for all wallets
    console.log('\n--- Withdrawing all positions ---');

    const walletWithdrawals = [];

    for (let walletIndex = 0; walletIndex < wallets.length; walletIndex++) {
      console.log(`\n${walletNames[walletIndex]} wallet positions:`);
      let walletWithdrawn = 0n;

      for (let positionIndex = 0; positionIndex < walletPositions[walletIndex]; positionIndex++) {
        const withdrawn = await trackWithdrawal(
          walletNames[walletIndex],
          walletIndex,
          positionIndex,
          walletAddresses[walletIndex],
          walletIndex > 0 ? wallets[walletIndex].account : undefined
        );
        walletWithdrawn += withdrawn;
      }

      walletWithdrawals.push(walletWithdrawn);
      console.log(`Total withdrawn by ${walletNames[walletIndex]} wallet: ${formatBigInt(walletWithdrawn)} UPD`);
    }

    // Calculate wallet contributions and profits
    console.log('\n--- Wallet Contributions and Profits ---');

    let totalWithdrawn = 0n;

    for (let walletIndex = 0; walletIndex < wallets.length; walletIndex++) {
      // Calculate total contributions by this wallet
      let walletContributions = 0n;
      let walletContributionsAfterFee = 0n;

      for (const position of positions.filter(p => p.walletIndex === walletIndex)) {
        walletContributions += position.contribution;
        walletContributionsAfterFee += position.contributionAfterFee - position.contributorFeePaid;
      }

      const walletProfit = walletWithdrawals[walletIndex] - walletContributionsAfterFee;

      console.log(`${walletNames[walletIndex]} wallet:`);
      console.log(`  Total contributions: ${formatBigInt(walletContributions)} UPD`);
      console.log(`  Contributions after fees: ${formatBigInt(walletContributionsAfterFee)} UPD`);
      console.log(`  Total withdrawals: ${formatBigInt(walletWithdrawals[walletIndex])} UPD`);
      console.log(`  Profit: ${formatBigInt(walletProfit)} UPD`);

      totalWithdrawn += walletWithdrawals[walletIndex];
    }

    // Check the contract's token balance
    const contractBalance = await token.read.balanceOf([contract.address]);
    console.log(`\nContract balance after all withdrawals: ${formatBigInt(contractBalance)} UPD`);

    // Check the contract's internal token tracking
    const contractTokens = await contract.read.tokens();
    console.log(`Contract internal tokens tracking: ${formatBigInt(contractTokens)} UPD`);

    // Check the contract's contributorFees
    await logContributorFees();

    // Verify that all tokens were withdrawn
    console.log('\n--- Verification ---');
    console.log(`Expected net contributions: ${formatBigInt(expectedNetContributions)} UPD`);
    console.log(`Total withdrawn: ${formatBigInt(totalWithdrawn)} UPD`);
    console.log(`Difference: ${formatBigInt(expectedNetContributions - totalWithdrawn)} UPD`);
    console.log(`Tokens left in contract: ${formatBigInt(contractBalance)} UPD`);

    // Calculate percentage of tokens left in contract
    if (contractBalance > 0) {
      const percentageLeft = Number(contractBalance) * 100 / Number(expectedNetContributions);
      console.log(`Percentage of tokens left in contract: ${percentageLeft.toFixed(6)}%`);
    }

    // Verify that all tokens were withdrawn
    expect(contractBalance).to.equal(0n);
  });
});
