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
  const faucet = '0xdC0046B52e2E38AEe2271B6171ebb65cCD337518';
  const args = [feeToken, antiSpamFee, percentFee, cycleLength, accrualRate, faucet];
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
  const goal = parseUnits('10000', 18);
  const deadline = Math.floor(Date.now() / 1000) + 86400; // 1 day from now
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

  // Approve the solution contract to spend UPD directly
  await upd.write.approve([contract.address, parseUnits('100000000000', 18)]);

  return { contract, upd, updraft, idea };
};

describe('Position Split Security Tests', () => {
  describe('Idea Contract', () => {
    it('should not allow gaining extra tokens by splitting positions', async () => {
      const { contract, upd } = await loadFixture(deployIdeaAndGetContract);

      // Get the user's address
      const userAddress = await walletAddress();

      // Get initial position details
      const initialPositionCount = await contract.read.numPositions([userAddress]);
      const [initialPositionTokens, initialPositionShares] = await contract.read.checkPosition([userAddress, 0]);

      // Get contract's total tokens before split
      const initialTotalTokens = await contract.read.tokens();
      const initialTotalShares = await contract.read.totalShares();

      console.log(`Initial total tokens in contract: ${initialTotalTokens}`);
      console.log(`Initial total shares in contract: ${initialTotalShares}`);
      console.log(`Initial position tokens: ${initialPositionTokens}`);
      console.log(`Initial position shares: ${initialPositionShares}`);

      // Split position into 3 parts (original + 2 new)
      await contract.write.split([0, 3]);

      // Check the position count after split
      const finalPositionCount = await contract.read.numPositions([userAddress]);

      // Get contract's total tokens after split
      const finalTotalTokens = await contract.read.tokens();
      const finalTotalShares = await contract.read.totalShares();

      console.log(`Final total tokens in contract: ${finalTotalTokens}`);
      console.log(`Final total shares in contract: ${finalTotalShares}`);

      // Verify position count increased by 2
      expect(finalPositionCount).to.equal(initialPositionCount + 2n);

      // Get all positions' token amounts
      const [position0Tokens] = await contract.read.checkPosition([userAddress, 0]);
      const [position1Tokens] = await contract.read.checkPosition([userAddress, 1]);
      const [position2Tokens] = await contract.read.checkPosition([userAddress, 2]);

      console.log(`Position 0 tokens after split: ${position0Tokens}`);
      console.log(`Position 1 tokens: ${position1Tokens}`);
      console.log(`Position 2 tokens: ${position2Tokens}`);

      // Calculate the sum of all positions' tokens
      const totalPositionTokens = position0Tokens + position1Tokens + position2Tokens;
      console.log(`Sum of all positions' tokens: ${totalPositionTokens}`);

      // Verify the sum of all positions' tokens equals the initial position tokens
      expect(totalPositionTokens).to.equal(initialPositionTokens);

      // Verify the contract's total tokens remain unchanged
      expect(finalTotalTokens).to.equal(initialTotalTokens);

      // Verify the contract's total shares remain unchanged
      expect(finalTotalShares).to.equal(initialTotalShares);

      // Try to withdraw all positions and verify the total amount withdrawn
      const initialBalance = await upd.read.balanceOf([userAddress]);

      await contract.write.withdraw([0]);
      await contract.write.withdraw([1]);
      await contract.write.withdraw([2]);

      const finalBalance = await upd.read.balanceOf([userAddress]);
      const totalWithdrawn = finalBalance - initialBalance;

      console.log(`Total tokens withdrawn: ${totalWithdrawn}`);

      // Verify the total withdrawn equals the initial position tokens
      expect(totalWithdrawn).to.equal(initialPositionTokens);

      // Verify the contract's token balance is now 0
      const contractBalance = await upd.read.balanceOf([contract.address]);
      console.log(`Contract balance after all withdrawals: ${contractBalance}`);
      expect(contractBalance).to.equal(0n);
    });

    it('should not allow gaining extra tokens by splitting positions multiple times', async () => {
      const { contract, upd } = await loadFixture(deployIdeaAndGetContract);

      // Get the user's address
      const userAddress = await walletAddress();

      // Get initial position details
      const [initialPositionTokens] = await contract.read.checkPosition([userAddress, 0]);

      // Get contract's total tokens before split
      const initialTotalTokens = await contract.read.tokens();

      console.log(`Initial total tokens in contract: ${initialTotalTokens}`);
      console.log(`Initial position tokens: ${initialPositionTokens}`);

      // Split position into 2 parts (original + 1 new)
      await contract.write.split([0, 2]);

      // Split the first position again
      await contract.write.split([0, 2]);

      // Split the second position
      await contract.write.split([1, 2]);

      // Get contract's total tokens after splits
      const finalTotalTokens = await contract.read.tokens();

      console.log(`Final total tokens in contract: ${finalTotalTokens}`);

      // Verify the contract's total tokens remain unchanged
      expect(finalTotalTokens).to.equal(initialTotalTokens);

      // Get all positions' token amounts
      const positions = await contract.read.numPositions([userAddress]);
      console.log(`Total positions after splits: ${positions}`);

      let totalPositionTokens = 0n;

      // Sum up all positions' tokens
      for (let i = 0; i < Number(positions); i++) {
        const [positionTokens] = await contract.read.checkPosition([userAddress, i]);
        console.log(`Position ${i} tokens: ${positionTokens}`);
        totalPositionTokens += positionTokens;
      }

      console.log(`Sum of all positions' tokens: ${totalPositionTokens}`);

      // Verify the sum of all positions' tokens equals the initial position tokens
      expect(totalPositionTokens).to.equal(initialPositionTokens);

      // Now check all positions in detail
      let detailedTotalTokens = 0n;

      // Sum up all positions' tokens
      for (let i = 0; i < Number(positions); i++) {
        try {
          const [positionTokens] = await contract.read.checkPosition([userAddress, i]);
          console.log(`Position ${i} tokens: ${positionTokens}`);
          detailedTotalTokens += positionTokens;
        } catch (error) {
          console.log(`Error checking position ${i}: ${error.message}`);
        }
      }

      console.log(`Sum of all positions' tokens (detailed check): ${detailedTotalTokens}`);

      // Verify the sum of all positions' tokens equals the initial position tokens
      expect(detailedTotalTokens).to.equal(initialPositionTokens);
    });
  });

  describe('Solution Contract', () => {
    it('should not allow gaining extra tokens by splitting positions', async () => {
      const { contract, upd } = await loadFixture(deploySolutionAndGetContract);

      // Get the user's address
      const userAddress = await walletAddress();

      // Create a position by contributing
      const contributionAmount = parseUnits('20', 18);
      await contract.write.contribute([contributionAmount]);

      // Get cycle length and advance time to accumulate shares and fees
      const cycleLength = await contract.read.cycleLength();

      // Create a second wallet and have it contribute to generate fees
      const [, secondWallet] = await hre.viem.getWalletClients();
      const secondWalletAddress = secondWallet.account.address;

      // Transfer tokens to second wallet
      const transferAmount = parseUnits('100', 18);
      await upd.write.transfer([secondWalletAddress, transferAmount]);

      // Approve the solution contract to spend tokens
      await upd.write.approve([contract.address, transferAmount], { account: secondWallet.account });

      // Advance time to the second cycle
      await time.increase(Number(cycleLength) + 1);

      // Second wallet contributes in the second cycle (this will generate fees)
      const secondContribution = parseUnits('30', 18);
      await contract.write.contribute([secondContribution], { account: secondWallet.account });

      // Advance time to the third cycle to accumulate more shares
      await time.increase(Number(cycleLength) + 1);

      // Get initial position details
      const initialPositionCount = await contract.read.numPositions([userAddress]);
      const [initialPositionFees, initialPositionShares] = await contract.read.checkPosition([userAddress, 0]);

      // Get contract's total tokens and shares before split
      const initialTotalTokens = await contract.read.totalTokens();
      const initialTotalShares = await contract.read.totalShares();
      const initialTokensContributed = await contract.read.tokensContributed();

      console.log(`Initial total tokens in contract: ${initialTotalTokens}`);
      console.log(`Initial total shares in contract: ${initialTotalShares}`);
      console.log(`Initial tokens contributed: ${initialTokensContributed}`);
      console.log(`Initial position fees earned: ${initialPositionFees}`);
      console.log(`Initial position shares: ${initialPositionShares}`);

      // Get the position's contribution amount
      const position = await contract.read.positionsByAddress([userAddress, 0]);
      const initialContribution = position[0]; // contribution is the first field in the Position struct

      console.log(`Initial contribution: ${initialContribution}`);

      // Split position into 3 parts (original + 2 new)
      await contract.write.split([0, 3]);

      // Check the position count after split
      const finalPositionCount = await contract.read.numPositions([userAddress]);

      // Get contract's total tokens and shares after split
      const finalTotalTokens = await contract.read.totalTokens();
      const finalTotalShares = await contract.read.totalShares();
      const finalTokensContributed = await contract.read.tokensContributed();

      console.log(`Final total tokens in contract: ${finalTotalTokens}`);
      console.log(`Final total shares in contract: ${finalTotalShares}`);
      console.log(`Final tokens contributed: ${finalTokensContributed}`);

      // Verify position count increased by 2
      expect(finalPositionCount).to.equal(initialPositionCount + 2n);

      // Verify the contract's total tokens remain unchanged
      expect(finalTotalTokens).to.equal(initialTotalTokens);

      // Verify the contract's total shares remain unchanged
      expect(finalTotalShares).to.equal(initialTotalShares);

      // Verify tokensContributed remains unchanged
      expect(finalTokensContributed).to.equal(initialTokensContributed);

      // Get all positions' contribution amounts
      const position0 = await contract.read.positionsByAddress([userAddress, 0]);
      const position1 = await contract.read.positionsByAddress([userAddress, 1]);
      const position2 = await contract.read.positionsByAddress([userAddress, 2]);

      const position0Contribution = position0[0];
      const position1Contribution = position1[0];
      const position2Contribution = position2[0];

      console.log(`Position 0 contribution after split: ${position0Contribution}`);
      console.log(`Position 1 contribution: ${position1Contribution}`);
      console.log(`Position 2 contribution: ${position2Contribution}`);

      // Calculate the sum of all positions' contributions
      const totalPositionContributions = position0Contribution + position1Contribution + position2Contribution;
      console.log(`Sum of all positions' contributions: ${totalPositionContributions}`);

      // Verify the sum of all positions' contributions equals the initial position contribution
      expect(totalPositionContributions).to.equal(initialContribution);

      // Collect fees from all positions and verify the total amount collected
      const initialBalance = await upd.read.balanceOf([userAddress]);

      await contract.write.collectFees([0]);
      await contract.write.collectFees([1]);
      await contract.write.collectFees([2]);

      const finalBalance = await upd.read.balanceOf([userAddress]);
      const totalCollected = finalBalance - initialBalance;

      console.log(`Total fees collected: ${totalCollected}`);

      // Verify the total collected equals the initial position fees
      // Allow for a small rounding error (up to 3 wei) due to multiple divisions
      const maxAllowedDifference = 3n;
      const difference = totalCollected > initialPositionFees
        ? totalCollected - initialPositionFees
        : initialPositionFees - totalCollected;

      console.log(`Difference between collected fees and initial fees: ${difference}`);
      console.log(`Maximum allowed difference: ${maxAllowedDifference} wei`);

      expect(difference <= maxAllowedDifference).to.be.true;

      if (difference > 0n) {
        console.log(`Note: There was a difference of ${difference} wei, which is acceptable due to division rounding`);
      }
    });

    it('should not allow gaining extra tokens by splitting positions multiple times', async () => {
      const { contract, upd } = await loadFixture(deploySolutionAndGetContract);

      // Get the user's address
      const userAddress = await walletAddress();

      // Create a position by contributing
      const contributionAmount = parseUnits('20', 18);
      await contract.write.contribute([contributionAmount]);

      // Get cycle length and advance time to accumulate shares and fees
      const cycleLength = await contract.read.cycleLength();

      // Create a second wallet and have it contribute to generate fees
      const [, secondWallet] = await hre.viem.getWalletClients();
      const secondWalletAddress = secondWallet.account.address;

      // Transfer tokens to second wallet
      const transferAmount = parseUnits('100', 18);
      await upd.write.transfer([secondWalletAddress, transferAmount]);

      // Approve the solution contract to spend tokens
      await upd.write.approve([contract.address, transferAmount], { account: secondWallet.account });

      // Advance time to the second cycle
      await time.increase(Number(cycleLength) + 1);

      // Second wallet contributes in the second cycle (this will generate fees)
      const secondContribution = parseUnits('30', 18);
      await contract.write.contribute([secondContribution], { account: secondWallet.account });

      // Advance time to the third cycle to accumulate more shares
      await time.increase(Number(cycleLength) + 1);

      // Get initial position details
      const [initialPositionFees, initialPositionShares] = await contract.read.checkPosition([userAddress, 0]);

      // Get contract's total tokens and shares before split
      const initialTotalTokens = await contract.read.totalTokens();
      const initialTotalShares = await contract.read.totalShares();
      const initialTokensContributed = await contract.read.tokensContributed();

      console.log(`Initial total tokens in contract: ${initialTotalTokens}`);
      console.log(`Initial total shares in contract: ${initialTotalShares}`);
      console.log(`Initial tokens contributed: ${initialTokensContributed}`);
      console.log(`Initial position fees earned: ${initialPositionFees}`);
      console.log(`Initial position shares: ${initialPositionShares}`);

      // Get the position's contribution amount
      const position = await contract.read.positionsByAddress([userAddress, 0]);
      const initialContribution = position[0]; // contribution is the first field in the Position struct

      console.log(`Initial contribution: ${initialContribution}`);

      // Split position into 2 parts (original + 1 new)
      await contract.write.split([0, 2]);

      // Split the first position again
      await contract.write.split([0, 2]);

      // Split the second position
      await contract.write.split([1, 2]);

      // Get contract's total tokens and shares after splits
      const finalTotalTokens = await contract.read.totalTokens();
      const finalTotalShares = await contract.read.totalShares();
      const finalTokensContributed = await contract.read.tokensContributed();

      console.log(`Final total tokens in contract: ${finalTotalTokens}`);
      console.log(`Final total shares in contract: ${finalTotalShares}`);
      console.log(`Final tokens contributed: ${finalTokensContributed}`);

      // Verify the contract's total tokens remain unchanged
      expect(finalTotalTokens).to.equal(initialTotalTokens);

      // Verify the contract's total shares remain unchanged
      expect(finalTotalShares).to.equal(initialTotalShares);

      // Verify tokensContributed remains unchanged
      expect(finalTokensContributed).to.equal(initialTokensContributed);

      // Get all positions' contribution amounts
      const positions = await contract.read.numPositions([userAddress]);
      console.log(`Total positions after splits: ${positions}`);

      let totalPositionContributions = 0n;

      // Sum up all positions' contributions
      for (let i = 0; i < Number(positions); i++) {
        const positionData = await contract.read.positionsByAddress([userAddress, i]);
        const positionContribution = positionData[0];
        console.log(`Position ${i} contribution: ${positionContribution}`);
        totalPositionContributions += positionContribution;
      }

      console.log(`Sum of all positions' contributions: ${totalPositionContributions}`);

      // Verify the sum of all positions' contributions equals the initial position contribution
      expect(totalPositionContributions).to.equal(initialContribution);

      // Collect fees from all positions and verify the total amount collected
      const initialBalance = await upd.read.balanceOf([userAddress]);

      for (let i = 0; i < Number(positions); i++) {
        await contract.write.collectFees([i]);
      }

      const finalBalance = await upd.read.balanceOf([userAddress]);
      const totalCollected = finalBalance - initialBalance;

      console.log(`Total fees collected: ${totalCollected}`);

      // Verify the total collected equals the initial position fees
      // We should expect exact equality or at most a difference of 1 wei due to division rounding
      const maxAllowedDifference = 1n;
      const difference = totalCollected > initialPositionFees
        ? totalCollected - initialPositionFees
        : initialPositionFees - totalCollected;

      console.log(`Difference between collected fees and initial fees: ${difference}`);
      console.log(`Maximum allowed difference: ${maxAllowedDifference} wei`);

      expect(difference <= maxAllowedDifference).to.be.true;

      if (difference > 0n) {
        console.log(`Note: There was a difference of ${difference} wei, which is acceptable due to division rounding`);
      }
    });
  });
});
