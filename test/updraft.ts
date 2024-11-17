import hre from 'hardhat';
import { parseUnits, toHex } from 'viem';
import { assert, expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { getEventsFromTx, walletAddress } from './utilities/helpers.ts'

const profileData = {
  "team": "Adam, Victor, Bastin, Beigi, Amirerfan",
  "about": "Creators of Updraft"
}

const ideaData = {
  "name": "Build a monkey cage.",
  "description": "We need a cage for our monkey."
}

const antiSpamFee = parseUnits('1', 18); // 1 UPD
const contribution = parseUnits('10', 18) // 10 UPD

const deployUpdraft = async () => {
  const upd = await hre.viem.deployContract('UPDToken');
  const feeToken = upd.address;
  //  100% is 1000000 (percentScale is 1000000 in Updraft.sol)
  const percentFee = 10000; // 1%
  const accrualRate = 1000; // 0.1%
  const cycleLength = 3600; // 1 hour in seconds
  const humanity = '0xdC0046B52e2E38AEe2271B6171ebb65cCD337518';
  const args = [feeToken, antiSpamFee, percentFee, cycleLength, accrualRate, humanity];
  const updraft = await hre.viem.deployContract('Updraft', args);
  return { updraft, upd };
};

const approveUpdraftToSpendUPD = async () => {
  const { updraft, upd } = await loadFixture(deployUpdraft);
  await upd.write.approve([updraft.address, parseUnits('100000000000', 18)]);
  return { updraft, upd };
}

const deployIdeaAndGetTx = async () => {
  const { updraft } = await loadFixture(approveUpdraftToSpendUPD);
  const publicClient = await hre.viem.getPublicClient();
  //  100% is 1000000 (percentScale is 1000000 in Updraft.sol)
  const contributorFee = 10000; // 1%
  const hash = await updraft.write.createIdea([contributorFee, contribution, toHex(ideaData)]);
  const transaction = await publicClient.getTransactionReceipt({hash});
  return { transaction };
}

const deployIdeaAndGetContract = async () => {
  const { transaction } = await loadFixture(deployIdeaAndGetTx);
  const events = await getEventsFromTx('Updraft', transaction);
  const { idea } = events.find(event => event.eventName === 'IdeaCreated').args;
  const contract = await hre.viem.getContractAt('Idea',idea);
  return { contract };
}

describe('Updraft', () => {
  it('should deploy', async () => {
    await loadFixture(deployUpdraft);
  });
  it('should be approved to spend UPD', async () => {
    await loadFixture(approveUpdraftToSpendUPD);
  });
  it('should create a profile', async () => {
    const { updraft } = await loadFixture(approveUpdraftToSpendUPD);
    await updraft.write.updateProfile([toHex(profileData)]);
  });
  describe('Creating an Idea', () => {
    it('should emit an `IdeaCreated` event', async () => {
      const { transaction } = await loadFixture(deployIdeaAndGetTx);
      const events = await getEventsFromTx('Updraft', transaction);
      assert(events.find(event => event.eventName === 'IdeaCreated'), '"IdeaCreated" not found in events');
    });
    it('should give the caller a position in the Idea', async () => {
      const { contract: idea } = await loadFixture(deployIdeaAndGetContract);
      const numPositions = Number(await idea.read.positionsLength([await walletAddress()]));
      expect(numPositions).to.be.above(0);
    });
    it("should set the caller's position equal to their contribution minus the anti-spam fee", async () => {
      const { contract: idea } = await loadFixture(deployIdeaAndGetContract);
      const[tokens, shares] = await idea.read.checkPosition([await walletAddress()]);
      expect(tokens).to.equal(contribution - antiSpamFee);
    });
  });
});