import hre from "hardhat";
import { parseUnits, stringToHex } from "viem";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";

// Mock BrightID verifier contract for testing
const deployMockBrightID = async () => {
  const brightId = await hre.viem.deployContract("MockBrightID");
  console.log("Deployed MockBrightID at:", brightId.address);
  return { brightId };
};

const deployCookieJar = async () => {
  console.log("Starting deployCookieJar");
  // Deploy fresh contracts instead of using loadFixture to avoid caching issues
  const upd = await hre.viem.deployContract("UPDToken");
  const mockBrightId = await hre.viem.deployContract("MockBrightID");
  console.log("Deployed fresh MockBrightID at:", mockBrightId.address);

  // Get owner wallet
  const [ownerWallet] = await hre.viem.getWalletClients();
  const context = stringToHex("updraft", { size: 32 });

  const cookieJar = await hre.viem.deployContract("UpdCookieJar", [
    ownerWallet.account.address,
    upd.address,
    mockBrightId.address,
    context,
  ]);

  // Approve cookie jar to spend UPD tokens
  await upd.write.approve([cookieJar.address, parseUnits("1000000", 18)]);

  return { cookieJar, upd, brightId: mockBrightId, context };
};

// Mock BrightID contract for testing
const deployMockBrightIDAndCookieJar = async () => {
  console.log("Starting deployMockBrightIDAndCookieJar");
  // Deploy a fresh MockBrightID contract instead of using loadFixture to avoid caching issues
  const mockBrightId = await hre.viem.deployContract("MockBrightID");
  console.log("Deployed fresh MockBrightID at:", mockBrightId.address);

  // Test that the contract is properly deployed
  try {
    const testResult = await mockBrightId.read.isVerified([
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      mockBrightId.address,
    ]);
    console.log("Test call to isVerified on fresh MockBrightID succeeded, result:", testResult);
  } catch (error) {
    console.log("Test call to isVerified on fresh MockBrightID failed:", error);
  }

  // Deploy a fresh UPD token contract instead of using loadFixture to avoid caching issues
  const upd = await hre.viem.deployContract("UPDToken");

  // Get owner wallet
  const [ownerWallet] = await hre.viem.getWalletClients();
  const context = stringToHex("updraft", { size: 32 });

  const cookieJar = await hre.viem.deployContract("UpdCookieJar", [
    ownerWallet.account.address,
    upd.address,
    mockBrightId.address,
    context,
  ]);
  console.log("Deployed CookieJar at:", cookieJar.address);
  console.log("MockBrightID address:", mockBrightId.address);
  console.log("Are they the same?", cookieJar.address === mockBrightId.address);

  // Fund the cookie jar with some UPD tokens
  const fundAmount = parseUnits("1000", 18);
  await upd.write.transfer([cookieJar.address, fundAmount]);

  return { cookieJar, upd, brightId: mockBrightId, context };
};

describe("UpdCookieJar", () => {
  describe("Deployment", () => {
    it("should deploy successfully with correct parameters", async () => {
      const { cookieJar, upd, brightId: mockBrightId, context } = await loadFixture(deployCookieJar);

      // Diagnostic logging
      console.log("In Deployment test - CookieJar address:", cookieJar.address);
      console.log("In Deployment test - MockBrightID address:", mockBrightId.address);
      console.log("In Deployment test - Are they the same?", cookieJar.address === mockBrightId.address);

      // Test that the MockBrightID contract is working correctly
      console.log("In Deployment test - About to test isVerified on MockBrightID at:", mockBrightId.address);
      const isVerifiedResult = await mockBrightId.read.isVerified([context, mockBrightId.address]);
      console.log("In Deployment test - isVerified result:", isVerifiedResult);

      expect((await cookieJar.read.token()).toLowerCase()).to.equal(upd.address.toLowerCase());
      expect((await cookieJar.read.brightId()).toLowerCase()).to.equal(mockBrightId.address.toLowerCase());
      expect(await cookieJar.read.brightIdContext()).to.equal(context);
    });

    it("should fail deployment with zero address for token", async () => {
      const { brightId } = await loadFixture(deployMockBrightID);
      // Get owner wallet
      const [ownerWallet] = await hre.viem.getWalletClients();
      const context = stringToHex("updraft", { size: 32 });

      await expect(
        hre.viem.deployContract("UpdCookieJar", [
          ownerWallet.account.address,
          "0x0000000000000000000000000000000000000000",
          brightId.address,
          context,
        ]),
      ).to.be.rejectedWith("bad token");
    });
  });

  describe("Claiming", () => {
    it("should allow verified users to claim tokens", async () => {
      const { cookieJar, upd, brightId: mockBrightId, context } = await loadFixture(deployMockBrightIDAndCookieJar);

      // Diagnostic logging
      console.log("CookieJar address:", cookieJar.address);
      console.log("MockBrightID address:", mockBrightId.address);
      console.log("Are they the same?", cookieJar.address === mockBrightId.address);

      // Get test wallet
      const [walletClient] = await hre.viem.getWalletClients();
      const userAddress = walletClient.account.address;

      // Verify the user in the mock BrightID contract
      console.log("About to call verifyUserForContext on MockBrightID at:", mockBrightId.address);
      console.log("Context:", context);
      console.log("User address:", userAddress);

      // Check the current state before verification
      try {
        const isVerifiedBefore = await mockBrightId.read.isVerified([context, userAddress]);
        console.log("Is user verified before verification:", isVerifiedBefore);
      } catch (error) {
        console.log("Error checking verification status before verification:", error);
      }

      await mockBrightId.write.verifyUserForContext([context, userAddress]);
      console.log("Called verifyUserForContext successfully");

      // Check that the user is verified in the MockBrightID contract
      console.log("About to call isVerified on MockBrightID at:", mockBrightId.address);
      console.log("Context:", context);
      console.log("User address:", userAddress);

      // Add more diagnostic logging
      try {
        console.log("About to call isVerified with context:", context, "and user address:", userAddress);
        const isVerifiedInMock = await mockBrightId.read.isVerified([context, userAddress]);
        console.log("User verified in MockBrightID:", isVerifiedInMock);
      } catch (error) {
        console.log("Error calling isVerified on MockBrightID:", error);
        // Try calling isVerified with different parameters to see if it works
        try {
          console.log("Trying isVerified with zero context and contract address");
          const testResult = await mockBrightId.read.isVerified([
            "0x0000000000000000000000000000000000000000000000000000000000000000",
            mockBrightId.address,
          ]);
          console.log("Test call to isVerified with different parameters succeeded, result:", testResult);
        } catch (testError) {
          console.log("Test call to isVerified with different parameters also failed:", testError);
        }
      }

      // Check what address is stored in the CookieJar's brightId field
      const brightIdAddressInCookieJar = await cookieJar.read.brightId();
      console.log("BrightID address stored in CookieJar:", brightIdAddressInCookieJar);
      console.log(
        "Does it match MockBrightID address?",
        brightIdAddressInCookieJar.toLowerCase() === mockBrightId.address.toLowerCase(),
      );

      // Check initial balance
      const initialBalance = await upd.read.balanceOf([userAddress]);

      // Claim tokens
      await cookieJar.write.claim({ account: walletClient.account });

      // Check final balance
      const finalBalance = await upd.read.balanceOf([userAddress]);

      // Calculate expected amount (1% of 1000 UPD = 10 UPD)
      const expectedAmount = parseUnits("10", 18);

      expect(finalBalance - initialBalance).to.equal(expectedAmount);

      // Check that lastClaimAt was updated
      const lastClaimAt = await cookieJar.read.lastClaimAt([userAddress]);
      expect(Number(lastClaimAt)).to.be.greaterThan(0);
    });

    it("should reject claims from unverified users", async () => {
      const { cookieJar } = await loadFixture(deployMockBrightIDAndCookieJar);

      // Get test wallet
      const [walletClient] = await hre.viem.getWalletClients();

      // Try to claim without being verified
      await expect(cookieJar.write.claim({ account: walletClient.account })).to.be.rejectedWith(
        "not BrightID verified",
      );
    });

    it("should enforce cooldown period", async () => {
      const { cookieJar, brightId: mockBrightId, context } = await loadFixture(deployMockBrightIDAndCookieJar);

      // Get test wallet
      const [walletClient] = await hre.viem.getWalletClients();
      const userAddress = walletClient.account.address;

      // Verify the user
      await mockBrightId.write.verifyUserForContext([context, userAddress]);

      // First claim should succeed
      await cookieJar.write.claim({ account: walletClient.account });

      // Second claim should fail due to cooldown
      await expect(cookieJar.write.claim({ account: walletClient.account })).to.be.rejectedWith("cooldown");
    });

    it("should reject claims when contract is empty", async () => {
      const { cookieJar, brightId: mockBrightId, upd, context } = await loadFixture(deployMockBrightIDAndCookieJar);

      // Get test wallet
      const [walletClient] = await hre.viem.getWalletClients();
      const userAddress = walletClient.account.address;

      // Verify the user
      await mockBrightId.write.verifyUserForContext([context, userAddress]);

      // Check initial contract balance
      let contractBalance = await upd.read.balanceOf([cookieJar.address]);
      console.log("Initial contract balance:", contractBalance.toString());

      // Drain the contract by having users claim all tokens
      // First claim
      await cookieJar.write.claim({ account: walletClient.account });

      // Check contract balance after first claim
      contractBalance = await upd.read.balanceOf([cookieJar.address]);
      console.log("Contract balance after first claim:", contractBalance.toString());

      // Transfer more tokens to the contract to allow multiple claims
      const fundAmount = parseUnits("1000", 18);
      await upd.write.transfer([cookieJar.address, fundAmount]);

      // Check contract balance after funding
      contractBalance = await upd.read.balanceOf([cookieJar.address]);
      console.log("Contract balance after funding:", contractBalance.toString());

      // Wait for cooldown period to expire before making more claims
      // We need to advance time by at least 7 days (COOLDOWN period)
      await time.increase(7 * 24 * 60 * 60 + 1); // 7 days + 1 second

      // Keep claiming until the contract is empty or we've claimed enough times
      // that the next claim would fail due to insufficient balance
      let claimCount = 0;
      let lastClaimSucceeded = true;
      while (lastClaimSucceeded && claimCount < 1000) {
        // Increase limit to 1000
        // Safety limit
        try {
          console.log("Attempting claim #" + (claimCount + 1));
          await cookieJar.write.claim({ account: walletClient.account });
          claimCount++;
          // Check contract balance after each claim
          contractBalance = await upd.read.balanceOf([cookieJar.address]);
          console.log("Contract balance after claim #" + claimCount + ":", contractBalance.toString());

          // Wait for cooldown period to expire before next claim
          // We need to advance time by at least 7 days (COOLDOWN period)
          await time.increase(7 * 24 * 60 * 60 + 1); // 7 days + 1 second

          // Break if balance is low enough that next claim would fail
          if (contractBalance < 2n * 10n ** 18n) {
            // Less than 2 UPD tokens
            console.log("Contract balance is low, stopping claims");
            break;
          }
        } catch (error) {
          console.log("Claim #" + (claimCount + 1) + " failed with error:", (error as Error).message || error);
          lastClaimSucceeded = false;
        }
      }

      // Check final contract balance
      contractBalance = await upd.read.balanceOf([cookieJar.address]);
      console.log("Final contract balance:", contractBalance.toString());

      // Wait for cooldown period to expire before final claim attempt
      await time.increase(7 * 24 * 60 * 60 + 1); // 7 days + 1 second

      // Try to claim when contract is empty
      await expect(cookieJar.write.claim({ account: walletClient.account })).to.be.rejectedWith("empty");
    });
  });

  describe("Admin functions", () => {
    it("should allow owner to pause and unpause", async () => {
      const { cookieJar } = await loadFixture(deployMockBrightIDAndCookieJar);

      // Pause the contract
      await cookieJar.write.pause();

      // Verify it's paused
      expect(await cookieJar.read.paused()).to.be.true;

      // Unpause the contract
      await cookieJar.write.unpause();

      // Verify it's unpaused
      expect(await cookieJar.read.paused()).to.be.false;
    });

    it("should allow owner to update BrightID verifier", async () => {
      const { cookieJar } = await loadFixture(deployMockBrightIDAndCookieJar);

      // Deploy a new mock BrightID verifier
      const newBrightId = await hre.viem.deployContract("MockBrightID");
      const newContext = stringToHex("updraft-new", { size: 32 });

      // Update BrightID verifier
      await cookieJar.write.setBrightID([newBrightId.address, newContext]);

      // Verify the update
      expect((await cookieJar.read.brightId()).toLowerCase()).to.equal(newBrightId.address.toLowerCase());
      expect(await cookieJar.read.brightIdContext()).to.equal(newContext);
    });

    it("should allow owner to sweep non-UPD tokens", async () => {
      const { cookieJar } = await loadFixture(deployMockBrightIDAndCookieJar);

      // Deploy another token for testing sweep
      const otherToken = await hre.viem.deployContract("UPDToken");

      // Send some of this token to the cookie jar
      const sweepAmount = parseUnits("100", 18);
      await otherToken.write.transfer([cookieJar.address, sweepAmount]);

      // Verify cookie jar has the tokens
      expect(await otherToken.read.balanceOf([cookieJar.address])).to.equal(sweepAmount);

      // Get owner wallet
      const [ownerWallet] = await hre.viem.getWalletClients();

      // Get owner's initial balance
      const ownerInitialBalance = await otherToken.read.balanceOf([ownerWallet.account.address]);

      // Sweep the tokens
      await cookieJar.write.sweep([otherToken.address, ownerWallet.account.address], { account: ownerWallet.account });

      // Verify tokens were swept
      expect(await otherToken.read.balanceOf([cookieJar.address])).to.equal(0n);
      expect(await otherToken.read.balanceOf([ownerWallet.account.address])).to.equal(
        ownerInitialBalance + sweepAmount,
      );
    });

    it("should prevent sweeping UPD tokens", async () => {
      const { cookieJar } = await loadFixture(deployMockBrightIDAndCookieJar);

      // Get owner wallet
      const [ownerWallet] = await hre.viem.getWalletClients();

      // Try to sweep UPD tokens (should fail)
      const tokenAddress = await cookieJar.read.token();
      await expect(
        cookieJar.write.sweep([tokenAddress, ownerWallet.account.address], { account: ownerWallet.account }),
      ).to.be.rejectedWith("no sweep UPD");
    });
  });
});
