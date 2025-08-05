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
  const accrualRate = 100000; // 10% - higher for easier testing
  const cycleLength = 3600; // 1 hour
  const faucet = '0xdC0046B52e2E38AEe2271B6171ebb65cCD337518';
  const args = [feeToken, antiSpamFee, percentFee, cycleLength, accrualRate, faucet];
  const updraft = await hre.viem.deployContract('Updraft', args);
  return { updraft, upd, faucet };
};

const deployUpdraftAndApproveToSpendUPD = async () => {
  const { updraft, upd, faucet } = await loadFixture(deployUpdraft);
  await upd.write.approve([updraft.address, parseUnits('10000000', 18)]);
  return { updraft, upd, faucet };
};

describe('Cycle Overwrite Bug Fix', () => {
  it('should preserve cycles with contributions after withdrawal in same cycle', async () => {
    const { updraft, upd, faucet } = await loadFixture(deployUpdraftAndApproveToSpendUPD);
    const publicClient = await hre.viem.getPublicClient();

    // Create idea with 10% contributor fee
    const contributorFee = 100000; // 10%
    const initialContribution = parseUnits('100', 18);
    const hash = await updraft.write.createIdea([contributorFee, initialContribution, toHex({})]);
    const transaction = await publicClient.getTransactionReceipt({hash});
    const events = await getEventsFromTx('Updraft', transaction);
    const { idea } = events.find(event => event.eventName === 'IdeaCreated').args;
    const contract = await hre.viem.getContractAt('Idea', idea);

    // Get wallet clients
    const [creatorWallet, contributorWallet] = await hre.viem.getWalletClients();
    
    // Transfer tokens and approve
    const transferAmount = parseUnits('100000', 18);
    await upd.write.transfer([contributorWallet.account.address, transferAmount]);
    await upd.write.approve([contract.address, transferAmount], { account: contributorWallet.account });
    await upd.write.approve([contract.address, parseUnits('100000', 18)]);

    // Step 1: Contributor makes a contribution in first cycle
    const contribution = parseUnits('1000', 18);
    await contract.write.contribute([contribution], { account: contributorWallet.account });

    // Step 2: Advance to second cycle and make a contribution to create fees
    const cycleLength = await contract.read.cycleLength();
    await time.increase(Number(cycleLength) + 1);
    const secondContribution = parseUnits('100', 18);
    await contract.write.contribute([secondContribution]);

    // Step 3: Advance to third cycle
    await time.increase(Number(cycleLength) + 1);
    
    // Step 4: Creator withdraws (creates cycle with hasContributions: false initially)
    await contract.write.withdraw([0]);

    // Step 5: Contributor makes another contribution in the SAME cycle
    const thirdContribution = parseUnits('500', 18);
    await contract.write.contribute([thirdContribution], { account: contributorWallet.account });

    // Check that the cycle now has hasContributions: true
    const cycle = await contract.read.cycles([BigInt(2)]);
    expect(cycle[3]).to.be.true; // hasContributions should be true

    // Step 6: Advance time and trigger fee distribution
    await time.increase(Number(cycleLength) + 1);
    await contract.write.contribute([antiSpamFee * 2n]);

    // Step 7: Check that contributor gets fees from the third contribution
    const contributorPosition = await contract.read.checkPosition([contributorWallet.account.address, 0]);
    const contributorTokens = contributorPosition[0];
    
    // Contributor should have gained fees from the third contribution
    expect(contributorTokens > contribution).to.be.true;

    // Step 8: Withdraw all positions and verify no tokens are stuck
    await contract.write.withdraw([0], { account: contributorWallet.account });
    await contract.write.withdraw([1], { account: contributorWallet.account });
    await contract.write.withdraw([1]); // Creator's second position

    const finalTokens = await contract.read.tokens();
    const finalContributorFees = await contract.read.contributorFees();
    
    // No significant tokens should be stuck in the contract (allow for dust)
    expect(finalTokens < parseUnits('1', 18)).to.be.true; // Less than 1 UPD dust
    expect(finalContributorFees).to.equal(0n);
  });

  it('should preserve cycles with airdrop fees after withdrawal in same cycle', async () => {
    const { updraft, upd, faucet } = await loadFixture(deployUpdraftAndApproveToSpendUPD);
    const publicClient = await hre.viem.getPublicClient();

    // Create idea with 10% contributor fee
    const contributorFee = 100000; // 10%
    const initialContribution = parseUnits('100', 18);
    const hash = await updraft.write.createIdea([contributorFee, initialContribution, toHex({})]);
    const transaction = await publicClient.getTransactionReceipt({hash});
    const events = await getEventsFromTx('Updraft', transaction);
    const { idea } = events.find(event => event.eventName === 'IdeaCreated').args;
    const contract = await hre.viem.getContractAt('Idea', idea);

    // Get wallet clients
    const [creatorWallet, contributorWallet, airdropperWallet] = await hre.viem.getWalletClients();
    
    // Transfer tokens and approve
    const transferAmount = parseUnits('100000', 18);
    await upd.write.transfer([contributorWallet.account.address, transferAmount]);
    await upd.write.transfer([airdropperWallet.account.address, transferAmount]);
    await upd.write.approve([contract.address, transferAmount], { account: contributorWallet.account });
    await upd.write.approve([contract.address, transferAmount], { account: airdropperWallet.account });
    await upd.write.approve([contract.address, parseUnits('100000', 18)]);

    // Step 1: Contributor makes a contribution in first cycle
    const contribution = parseUnits('1000', 18);
    await contract.write.contribute([contribution], { account: contributorWallet.account });

    // Step 2: Advance to second cycle and make a contribution to create fees
    const cycleLength = await contract.read.cycleLength();
    await time.increase(Number(cycleLength) + 1);
    const secondContribution = parseUnits('100', 18);
    await contract.write.contribute([secondContribution]);

    // Step 3: Advance to third cycle
    await time.increase(Number(cycleLength) + 1);
    
    // Step 4: Creator withdraws (creates cycle with hasContributions: false initially)
    await contract.write.withdraw([0]);

    // Step 5: Airdrop happens in the SAME cycle (this was the bug!)
    const airdropAmount = parseUnits('10000', 18);
    await contract.write.airdrop([airdropAmount], { account: airdropperWallet.account });

    // Check that the cycle now has hasContributions: true
    const cycle = await contract.read.cycles([BigInt(2)]);
    expect(cycle[3]).to.be.true; // hasContributions should be true
    expect(cycle[2] > 0n).to.be.true; // fees should be > 0

    // Step 6: Advance time and trigger fee distribution
    await time.increase(Number(cycleLength) + 1);
    await contract.write.contribute([antiSpamFee * 2n]);

    // Step 7: Check that contributor gets fees from the airdrop
    const contributorPosition = await contract.read.checkPosition([contributorWallet.account.address, 0]);
    const contributorTokens = contributorPosition[0];
    
    // Contributor should have gained significant fees from the airdrop
    const expectedMinGain = parseUnits('5000', 18); // Should get majority of 10k airdrop
    expect(contributorTokens > contribution + expectedMinGain).to.be.true;

    // Step 8: Withdraw all positions and verify no tokens are stuck
    await contract.write.withdraw([0], { account: contributorWallet.account });
    await contract.write.withdraw([1]);

    const finalTokens = await contract.read.tokens();
    const finalContributorFees = await contract.read.contributorFees();
    
    // No significant tokens should be stuck in the contract (allow for dust)
    expect(finalTokens < parseUnits('1', 18)).to.be.true; // Less than 1 UPD dust
    expect(finalContributorFees).to.equal(0n);
  });

  it('should handle multiple withdrawals in same cycle without overwriting', async () => {
    const { updraft, upd, faucet } = await loadFixture(deployUpdraftAndApproveToSpendUPD);
    const publicClient = await hre.viem.getPublicClient();

    // Create idea
    const contributorFee = 100000; // 10%
    const initialContribution = parseUnits('100', 18);
    const hash = await updraft.write.createIdea([contributorFee, initialContribution, toHex({})]);
    const transaction = await publicClient.getTransactionReceipt({hash});
    const events = await getEventsFromTx('Updraft', transaction);
    const { idea } = events.find(event => event.eventName === 'IdeaCreated').args;
    const contract = await hre.viem.getContractAt('Idea', idea);

    // Get wallet clients
    const [creatorWallet, contributorWallet, contributor2Wallet] = await hre.viem.getWalletClients();

    // Transfer tokens and approve
    const transferAmount = parseUnits('100000', 18);
    await upd.write.transfer([contributorWallet.account.address, transferAmount]);
    await upd.write.transfer([contributor2Wallet.account.address, transferAmount]);
    await upd.write.approve([contract.address, transferAmount], { account: contributorWallet.account });
    await upd.write.approve([contract.address, transferAmount], { account: contributor2Wallet.account });
    await upd.write.approve([contract.address, parseUnits('100000', 18)]);

    // Setup: Create positions in first cycle
    await contract.write.contribute([parseUnits('1000', 18)], { account: contributorWallet.account });
    await contract.write.contribute([parseUnits('500', 18)], { account: contributor2Wallet.account });

    const cycleLength = await contract.read.cycleLength();
    await time.increase(Number(cycleLength) + 1);
    await contract.write.contribute([parseUnits('100', 18)]);

    await time.increase(Number(cycleLength) + 1);

    // Test: Multiple withdrawals in same cycle, then contribution
    await contract.write.withdraw([0]); // Creates cycle with hasContributions: false
    await contract.write.withdraw([0], { account: contributorWallet.account }); // Another withdrawal

    // Now make a contribution - should preserve the cycle
    await contract.write.contribute([parseUnits('200', 18)], { account: contributor2Wallet.account });

    // Check cycle state - should have hasContributions: true
    const cycle = await contract.read.cycles([BigInt(2)]);
    expect(cycle[3]).to.be.true; // hasContributions should be true
    expect(cycle[2] > 0n).to.be.true; // fees should be > 0

    // Clean up
    await contract.write.withdraw([0], { account: contributor2Wallet.account });
    await contract.write.withdraw([1], { account: contributor2Wallet.account });
    await contract.write.withdraw([1]);

    const finalTokens = await contract.read.tokens();
    expect(finalTokens < parseUnits('1', 18)).to.be.true; // Less than 1 UPD dust
  });

  it('should handle airdrop immediately after withdrawal in same cycle', async () => {
    const { updraft, upd, faucet } = await loadFixture(deployUpdraftAndApproveToSpendUPD);
    const publicClient = await hre.viem.getPublicClient();

    // Create idea
    const contributorFee = 100000; // 10%
    const initialContribution = parseUnits('100', 18);
    const hash = await updraft.write.createIdea([contributorFee, initialContribution, toHex({})]);
    const transaction = await publicClient.getTransactionReceipt({hash});
    const events = await getEventsFromTx('Updraft', transaction);
    const { idea } = events.find(event => event.eventName === 'IdeaCreated').args;
    const contract = await hre.viem.getContractAt('Idea', idea);

    // Get wallet clients
    const [creatorWallet, contributorWallet, airdropperWallet] = await hre.viem.getWalletClients();

    // Transfer tokens and approve
    const transferAmount = parseUnits('100000', 18);
    await upd.write.transfer([contributorWallet.account.address, transferAmount]);
    await upd.write.transfer([airdropperWallet.account.address, transferAmount]);
    await upd.write.approve([contract.address, transferAmount], { account: contributorWallet.account });
    await upd.write.approve([contract.address, transferAmount], { account: airdropperWallet.account });
    await upd.write.approve([contract.address, parseUnits('100000', 18)]);

    // Setup: Create position and advance cycles
    await contract.write.contribute([parseUnits('1000', 18)], { account: contributorWallet.account });

    const cycleLength = await contract.read.cycleLength();
    await time.increase(Number(cycleLength) + 1);
    await contract.write.contribute([parseUnits('100', 18)]);

    await time.increase(Number(cycleLength) + 1);

    // Critical test: withdrawal immediately followed by airdrop
    await contract.write.withdraw([0]); // Creates cycle with hasContributions: false

    // Airdrop immediately in the same transaction block/cycle
    const airdropAmount = parseUnits('5000', 18);
    await contract.write.airdrop([airdropAmount], { account: airdropperWallet.account });

    // Verify the cycle is preserved with airdrop fees
    const cycle = await contract.read.cycles([BigInt(2)]);
    expect(cycle[3]).to.be.true; // hasContributions should be true
    expect(cycle[2] > 0n).to.be.true; // fees should be > 0 from airdrop

    // Verify contributor gets the airdrop fees
    await time.increase(Number(cycleLength) + 1);
    await contract.write.contribute([antiSpamFee * 2n]);

    const contributorPosition = await contract.read.checkPosition([contributorWallet.account.address, 0]);
    expect(contributorPosition[0] > parseUnits('1000', 18)).to.be.true; // Should have gained from airdrop

    // Clean up
    await contract.write.withdraw([0], { account: contributorWallet.account });
    await contract.write.withdraw([1]);

    const finalTokens = await contract.read.tokens();
    expect(finalTokens < parseUnits('1', 18)).to.be.true; // Less than 1 UPD dust
  });
});
