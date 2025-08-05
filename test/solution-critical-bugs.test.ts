import { expect } from 'chai';
import hre from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { parseUnits, toHex } from 'viem';
import { getEventsFromTx } from './utilities/helpers.ts';

const antiSpamFee = parseUnits('1', 18); // 1 UPD

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
  await upd.write.approve([updraft.address, parseUnits('1000000', 18)]);
  return { updraft, upd };
};

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

  return { contract, upd, updraft, idea };
};

const deploySolutionAndGetContract = async () => {
  const { updraft, upd } = await loadFixture(deployUpdraftAndApproveToSpendUPD);
  const { contract: idea } = await loadFixture(deployIdeaAndGetContract);
  const publicClient = await hre.viem.getPublicClient();

  // Solution parameters
  const stake = parseUnits('100', 18);
  const goal = parseUnits('10000', 18);
  const deadline = Math.floor(Date.now() / 1000) + 86400 * 7; // 7 days from now
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

describe('Solution Contract - Critical Bugs', () => {
  describe('Division by Zero Vulnerabilities', () => {
    it('should handle totalShares() when no cycles exist', async () => {
      const { contract } = await loadFixture(deploySolutionAndGetContract);

      // This should return 0, not revert
      const totalShares = await contract.read.totalShares();
      expect(totalShares).to.equal(0n);
    });

    it('should handle refund when totalShares is zero', async () => {
      const { contract, upd } = await loadFixture(deploySolutionAndGetContract);

      // Get a second wallet for testing
      const [, secondWallet] = await hre.viem.getWalletClients();
      const secondWalletAddress = secondWallet.account.address;

      // Transfer tokens to second wallet
      const transferAmount = parseUnits('100', 18);
      await upd.write.transfer([secondWalletAddress, transferAmount]);
      await upd.write.approve([contract.address, transferAmount], { account: secondWallet.account });

      // Second wallet contributes
      const secondContribution = parseUnits('20', 18);
      await contract.write.contribute([secondContribution], { account: secondWallet.account });

      // Advance time past the deadline to make the goal fail
      const deadline = await contract.read.deadline();
      await time.increaseTo(Number(deadline) + 1);

      // Try to get refund - this might cause division by zero in stakeAward calculation
      // if totalShares() returns 0
      await expect(contract.write.refund([0], { account: secondWallet.account })).to.not.be.rejected;
    });

    it('should handle fee collection when cycle.shares is zero', async () => {
      const { contract, upd } = await loadFixture(deploySolutionAndGetContract);

      // Get a second wallet for testing
      const [, secondWallet] = await hre.viem.getWalletClients();
      const secondWalletAddress = secondWallet.account.address;

      // Transfer tokens to second wallet
      const transferAmount = parseUnits('100', 18);
      await upd.write.transfer([secondWalletAddress, transferAmount]);
      await upd.write.approve([contract.address, transferAmount], { account: secondWallet.account });

      // Second wallet contributes
      const secondContribution = parseUnits('20', 18);
      await contract.write.contribute([secondContribution], { account: secondWallet.account });

      // Advance time to create cycles
      const cycleLength = await contract.read.cycleLength();
      await time.increase(Number(cycleLength) + 1);

      // Try to collect fees - this might cause division by zero if cycle.shares is 0
      await expect(contract.write.collectFees([0], { account: secondWallet.account })).to.not.be.rejected;
    });
  });


});
