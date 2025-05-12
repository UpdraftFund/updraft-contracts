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

describe('Position Self-Transfer Tests', () => {
  describe('Idea Contract', () => {
    it('should delete the original position and create a new one when transferring to yourself without gaining extra tokens', async () => {
      const { contract, upd } = await loadFixture(deployIdeaAndGetContract);

      // Get the user's address
      const userAddress = await walletAddress();

      // Get initial position details
      const initialPositionCount = await contract.read.numPositions([userAddress]);
      const [initialPositionTokens, initialPositionShares] = await contract.read.checkPosition([userAddress, 0]);

      // Get contract's total tokens before transfer
      const initialTotalTokens = await contract.read.tokens();
      const initialTotalShares = await contract.read.totalShares();

      console.log(`Initial total tokens in contract: ${initialTotalTokens}`);
      console.log(`Initial total shares in contract: ${initialTotalShares}`);
      console.log(`Initial position tokens: ${initialPositionTokens}`);
      console.log(`Initial position shares: ${initialPositionShares}`);

      // Transfer the position to the same address
      await contract.write.transferPosition([userAddress, 0]);

      // Check the position count after transfer
      const finalPositionCount = await contract.read.numPositions([userAddress]);

      // Get contract's total tokens after transfer
      const finalTotalTokens = await contract.read.tokens();
      const finalTotalShares = await contract.read.totalShares();

      console.log(`Final total tokens in contract: ${finalTotalTokens}`);
      console.log(`Final total shares in contract: ${finalTotalShares}`);

      // Verify position count increased by 1
      expect(finalPositionCount).to.equal(initialPositionCount + 1n);

      // Verify original position no longer exists
      try {
        await contract.read.checkPosition([userAddress, 0]);
        // If we get here, the test should fail because the position should be deleted
        expect.fail('Original position still exists but should have been deleted');
      } catch (error) {
        // This is expected - position should be deleted
        expect(error.message).to.include('PositionDoesNotExist');
      }

      // Verify new position has the same tokens as the original
      const newPositionIndex = Number(finalPositionCount) - 1;
      const [newPositionTokens, newPositionShares] = await contract.read.checkPosition([userAddress, newPositionIndex]);

      console.log(`New position tokens: ${newPositionTokens}`);
      console.log(`New position shares: ${newPositionShares}`);

      // Verify the new position has exactly the same tokens as the original
      expect(newPositionTokens).to.equal(initialPositionTokens);

      // Verify the contract's total tokens remain unchanged
      expect(finalTotalTokens).to.equal(initialTotalTokens);

      // Verify the contract's total shares remain unchanged
      expect(finalTotalShares).to.equal(initialTotalShares);
    });
  });

  describe('Solution Contract', () => {
    it('should delete the original position and create a new one when transferring to yourself without gaining extra tokens', async () => {
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

      // Get contract's total tokens and shares before transfer
      const initialTotalTokens = await contract.read.totalTokens();
      const initialTotalShares = await contract.read.totalShares();

      console.log(`Initial total tokens in contract: ${initialTotalTokens}`);
      console.log(`Initial total shares in contract: ${initialTotalShares}`);
      console.log(`Initial position fees earned: ${initialPositionFees}`);
      console.log(`Initial position shares: ${initialPositionShares}`);

      // Get the position's contribution amount and other details
      const position = await contract.read.positionsByAddress([userAddress, 0]);
      const initialContribution = position[0]; // contribution is the first field in the Position struct
      const initialStartCycleIndex = position[1]; // startCycleIndex is the second field
      const initialLastCollectedCycleIndex = position[2]; // lastCollectedCycleIndex is the third field

      console.log(`Initial contribution: ${initialContribution}`);
      console.log(`Initial startCycleIndex: ${initialStartCycleIndex}`);
      console.log(`Initial lastCollectedCycleIndex: ${initialLastCollectedCycleIndex}`);

      // Transfer the position to the same address
      await contract.write.transferPosition([userAddress, 0]);

      // Check the position count after transfer
      const finalPositionCount = await contract.read.numPositions([userAddress]);

      // Get contract's total tokens and shares after transfer
      const finalTotalTokens = await contract.read.totalTokens();
      const finalTotalShares = await contract.read.totalShares();

      console.log(`Final total tokens in contract: ${finalTotalTokens}`);
      console.log(`Final total shares in contract: ${finalTotalShares}`);

      // Verify position count increased by 1
      expect(finalPositionCount).to.equal(initialPositionCount + 1n);

      // Verify original position is empty (deleted)
      const emptyPosition = await contract.read.positionsByAddress([userAddress, 0]);
      expect(emptyPosition[0]).to.equal(0n); // contribution should be 0

      // Verify new position has the same properties as the original
      const newPositionIndex = Number(finalPositionCount) - 1;
      const newPosition = await contract.read.positionsByAddress([userAddress, newPositionIndex]);
      const [newPositionFees, newPositionShares] = await contract.read.checkPosition([userAddress, newPositionIndex]);

      console.log(`New position fees earned: ${newPositionFees}`);
      console.log(`New position shares: ${newPositionShares}`);
      console.log(`New contribution: ${newPosition[0]}`);
      console.log(`New startCycleIndex: ${newPosition[1]}`);
      console.log(`New lastCollectedCycleIndex: ${newPosition[2]}`);

      // Verify the new position has the same contribution as the original
      expect(newPosition[0]).to.equal(initialContribution);

      // Verify the new position has the same startCycleIndex as the original
      expect(newPosition[1]).to.equal(initialStartCycleIndex);

      // Verify the new position has the same lastCollectedCycleIndex as the original
      expect(newPosition[2]).to.equal(initialLastCollectedCycleIndex);

      // Verify the new position has the same shares as the original
      expect(newPositionShares).to.equal(initialPositionShares);

      // Verify the new position has the same fees as the original
      expect(newPositionFees).to.equal(initialPositionFees);

      // Verify the contract's total tokens remain unchanged
      expect(finalTotalTokens).to.equal(initialTotalTokens);

      // Verify the contract's total shares remain unchanged
      expect(finalTotalShares).to.equal(initialTotalShares);
    });
  });
});
