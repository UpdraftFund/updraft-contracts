# Updraft Smart Contracts

This repository contains the smart contracts for the Updraft protocol, a decentralized crowdfunding platform where users can fund "Ideas" and propose "Solutions" to those ideas.

## Protocol Features

- Time-based rewards: Contributors earn increasing shares over time through cycle-based accrual
- Dual-layer funding: Ideas get initial funding, then Solutions can be proposed and funded separately
- Community incentives: Contributor fees are distributed proportionally to long-term supporters
- Cross-chain compatibility: Solutions can reference Ideas from other chains
- Anti-spam mechanisms: Minimal fees prevent spam while keeping participation accessible

The protocol creates a sustainable ecosystem where good ideas get funded, solutions get developed, and long-term community members are rewarded for their continued support.

## Mechanism

Updraft is an implementation of [Attention Streams](https://docs.google.com/document/d/1TKA-K8YadRdgz-Qek01TUcCkRaI9CKCXGtJ31AbVWIU/edit?tab=t.0#heading=h.qbu28op5v4zs) for crowdfunding.

## Definitions

Definitions of _shares, interest, funder reward (AKA contributor fee)_ and other terms can be found in the [Updraft guide](https://guide.updraft.fund/updraft/advanced-topics/sort-order#interest) and [glossary](https://guide.updraft.fund/updraft/appendix/glossary).

## Contracts Overview

### Core Contracts

1. **UPDToken.sol** - The UPD ERC-20 token contract
2. **Updraft.sol** - The main Updraft contract that manages Ideas and Solutions
3. **Idea.sol** - The contract for Idea funding
4. **Solution.sol** - The contract for Solution funding

### Additional Contracts

1. **CookieJar.sol** - A faucet contract that distributes UPD tokens to BrightID verified users
2. **MockBrightID.sol** - A mock BrightID verifier for testing purposes
3. **interfaces/IBrightID.sol** - Interface for BrightID verification

## CookieJar Contract

The CookieJar contract implements a faucet that distributes UPD tokens to BrightID verified users with the following features:

- Users can claim 1% of the contract's UPD balance once every 7 days
- Only BrightID verified users can claim tokens
- The contract is pausable by the owner
- The contract includes a sweep function to recover accidentally sent tokens (except UPD)
- The BrightID verifier contract and context can be updated by the owner

### Deployment

To deploy the CookieJar contract, use the deployment script:

```bash
npx hardhat run scripts/deployCookieJar.ts --network <network>
```

### Testing

To run tests for the CookieJar contract:

```bash
npx hardhat test test/cookie-jar.test.ts
```
