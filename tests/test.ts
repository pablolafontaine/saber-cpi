import { SignerWallet } from "@saberhq/solana-contrib";
import type { IExchange } from "@saberhq/stableswap-sdk";
import {
  deployNewSwap,
  parseEventLogs,
  StableSwap,
  SWAP_PROGRAM_ID,
} from "@saberhq/stableswap-sdk";
import {
  SPLToken,
  Token as SToken,
  TOKEN_PROGRAM_ID,
  u64,
} from "@saberhq/token-utils";
import type { PublicKey, Signer, TransactionResponse } from "@solana/web3.js";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  Transaction,
} from "@solana/web3.js";

import { deployTestTokens } from "./deployTestTokens";
import {
  AMP_FACTOR,
  BOOTSTRAP_TIMEOUT,
  CLUSTER_URL,
  FEES,
  INITIAL_TOKEN_A_AMOUNT,
  INITIAL_TOKEN_B_AMOUNT,
  newKeypairWithLamports,
  sendAndConfirmTransactionWithTitle,
  sleep,
} from "./helpers";
import * as assert from "assert";

describe("Stableswap Test", () => {
  // Cluster connection
  let connection: Connection;
  // Fee payer
  let payer: Signer;
  // owner of the user accounts
  let owner: Signer;
  // Token pool
  let tokenPool: SPLToken;
  let userPoolAccount: PublicKey;
  // Tokens swapped
  let mintA: SPLToken;
  let mintB: SPLToken;
  let tokenAccountA: PublicKey;
  let tokenAccountB: PublicKey;
  // Admin fee accounts
  let adminFeeAccountA: PublicKey;
  let adminFeeAccountB: PublicKey;
  // Stable swap
  let exchange: IExchange;
  let stableSwap: StableSwap;
  let stableSwapAccount: Keypair;
  let stableSwapProgramId: PublicKey;

  before(async () => {
    connection = new Connection(CLUSTER_URL, "single");
    payer = await newKeypairWithLamports(connection, LAMPORTS_PER_SOL);
    owner = await newKeypairWithLamports(connection, LAMPORTS_PER_SOL);

    const provider = new SignerWallet(payer).createProvider(connection);
    const {
      mintA: tokenAMint,
      mintB: tokenBMint,
      seedPoolAccounts,
    } = await deployTestTokens({
      provider,
      minterSigner: owner,
      initialTokenAAmount: INITIAL_TOKEN_A_AMOUNT,
      initialTokenBAmount: INITIAL_TOKEN_B_AMOUNT,
    });

    stableSwapProgramId = SWAP_PROGRAM_ID;
    stableSwapAccount = Keypair.generate();

    const { swap: newSwap, initializeArgs } = await deployNewSwap({
      provider,
      swapProgramID: stableSwapProgramId,
      adminAccount: owner.publicKey,
      tokenAMint,
      tokenBMint,
      ampFactor: new u64(AMP_FACTOR),
      fees: FEES,

      initialLiquidityProvider: owner.publicKey,
      useAssociatedAccountForInitialLP: true,
      seedPoolAccounts,

      swapAccountSigner: stableSwapAccount,
    });

    exchange = {
      programID: stableSwapProgramId,
      swapAccount: stableSwapAccount.publicKey,
      lpToken: new SToken({
        symbol: "LP",
        name: "StableSwap LP",
        address: initializeArgs.poolTokenMint.toString(),
        decimals: 6,
        chainId: 100,
      }),
      tokens: [
        new SToken({
          symbol: "TOKA",
          name: "Token A",
          address: initializeArgs.tokenA.mint.toString(),
          decimals: 6,
          chainId: 100,
        }),
        new SToken({
          symbol: "TOKB",
          name: "Token B",
          address: initializeArgs.tokenB.mint.toString(),
          decimals: 6,
          chainId: 100,
        }),
      ],
    };

    stableSwap = newSwap;
    tokenPool = new SPLToken(
      connection,
      initializeArgs.poolTokenMint,
      TOKEN_PROGRAM_ID,
      payer
    );

    mintA = new SPLToken(
      connection,
      initializeArgs.tokenA.mint,
      TOKEN_PROGRAM_ID,
      payer
    );
    mintB = new SPLToken(
      connection,
      initializeArgs.tokenB.mint,
      TOKEN_PROGRAM_ID,
      payer
    );
    tokenAccountA = initializeArgs.tokenA.reserve;
    tokenAccountB = initializeArgs.tokenB.reserve;
    adminFeeAccountA = initializeArgs.tokenA.adminFeeAccount;
    adminFeeAccountB = initializeArgs.tokenB.adminFeeAccount;

    userPoolAccount = initializeArgs.destinationPoolTokenAccount;
  }, BOOTSTRAP_TIMEOUT);



  it("loadStableSwap", async () => {
    const fetchedStableSwap = await StableSwap.load(
      connection,
      stableSwapAccount.publicKey,
      stableSwapProgramId
    );

    
    const { state } = fetchedStableSwap;
    assert.ok(fetchedStableSwap.config.swapAccount.equals(
      stableSwapAccount.publicKey)
    );
    assert.ok(state.tokenA.adminFeeAccount.equals(adminFeeAccountA));
    assert.ok(state.tokenB.adminFeeAccount.equals(adminFeeAccountB));
    
    assert.ok(state.tokenA.reserve.equals(tokenAccountA));
    assert.ok(state.tokenB.reserve.equals(tokenAccountB));

    assert.ok(state.tokenA.mint.equals(mintA.publicKey));
    assert.ok(state.tokenB.mint.equals(mintB.publicKey));
    assert.ok(state.poolTokenMint.equals(tokenPool.publicKey));
    assert.equal(state.initialAmpFactor.toNumber(), AMP_FACTOR);
    assert.equal(state.targetAmpFactor.toNumber(), AMP_FACTOR);
    assert.deepEqual(state.fees, (FEES));

  });


  it("deposit", async () => {
    const depositAmountA = LAMPORTS_PER_SOL;
    const depositAmountB = LAMPORTS_PER_SOL;
    // Creating depositor token a account
    const userAccountA = await mintA.createAccount(owner.publicKey);
    await mintA.mintTo(userAccountA, owner, [], depositAmountA);
    // Creating depositor token b account
    const userAccountB = await mintB.createAccount(owner.publicKey);
    await mintB.mintTo(userAccountB, owner, [], depositAmountB);
    // Make sure all token accounts are created and approved
    await sleep(500);

    let txReceipt: TransactionResponse | null = null;
    // Depositing into swap
    const txn = new Transaction().add(
      stableSwap.deposit({
        userAuthority: owner.publicKey,
        sourceA: userAccountA,
        sourceB: userAccountB,
        poolTokenAccount: userPoolAccount,
        tokenAmountA: new u64(depositAmountA),
        tokenAmountB: new u64(depositAmountB),
        minimumPoolTokenAmount: new u64(0), 
      })
    );
    const txSig = await sendAndConfirmTransactionWithTitle(
      "deposit",
      connection,
      txn,
      payer,
      owner
    );
    txReceipt = await connection.getTransaction(txSig, {
      commitment: "confirmed",
    });

    let info = await mintA.getAccountInfo(userAccountA);
    assert.equal(info.amount.toNumber(), 0);
    info = await mintB.getAccountInfo(userAccountB);
    assert.equal(info.amount.toNumber(), 0);
    info = await mintA.getAccountInfo(tokenAccountA);
    assert.equal(info.amount.toNumber(), INITIAL_TOKEN_A_AMOUNT + depositAmountA);

    info = await mintB.getAccountInfo(tokenAccountB);
    assert.equal(info.amount.toNumber(), INITIAL_TOKEN_B_AMOUNT + depositAmountB);
    info = await tokenPool.getAccountInfo(userPoolAccount);
    assert.equal(info.amount.toNumber(), 4_000_000_000);

    const logMessages = parseEventLogs(txReceipt?.meta?.logMessages);
    assert.deepEqual(logMessages, ([
      {
        type: "Deposit",
        tokenAAmount: new u64(depositAmountA),
        tokenBAmount: new u64(depositAmountB),
        poolTokenAmount: new u64(2_000_000_000),
      },
    ]));
  });

  it("withdraw", async () => {
    const withdrawalAmount = 100000;
    const poolMintInfo = await tokenPool.getMintInfo();
    const oldSupply = poolMintInfo.supply.toNumber();
    const oldSwapTokenA = await mintA.getAccountInfo(tokenAccountA);
    const oldSwapTokenB = await mintB.getAccountInfo(tokenAccountB);
    const oldPoolToken = await tokenPool.getAccountInfo(userPoolAccount);
    const expectedWithdrawA = Math.floor(
      (oldSwapTokenA.amount.toNumber() * withdrawalAmount) / oldSupply
    );
    const expectedWithdrawB = Math.floor(
      (oldSwapTokenB.amount.toNumber() * withdrawalAmount) / oldSupply
    );

    // Creating withdraw token A account
    const userAccountA = await mintA.createAccount(owner.publicKey);
    // Creating withdraw token B account
    const userAccountB = await mintB.createAccount(owner.publicKey);
    // Make sure all token accounts are created and approved
    await sleep(500);

    let txReceipt: TransactionResponse | null = null;
    // Withdrawing pool tokens for A and B tokens
    const txn = new Transaction().add(
      stableSwap.withdraw({
        userAuthority: owner.publicKey,
        userAccountA,
        userAccountB,
        sourceAccount: userPoolAccount,
        poolTokenAmount: new u64(withdrawalAmount),
        minimumTokenA: new u64(0), 
        minimumTokenB: new u64(0), 
      })
    );
    const txSig = await sendAndConfirmTransactionWithTitle(
      "withdraw",
      connection,
      txn,
      payer,
      owner
    );
    txReceipt = await connection.getTransaction(txSig, {
      commitment: "confirmed",
    });

    let info = await mintA.getAccountInfo(userAccountA);
    assert.equal(info.amount.toNumber(), expectedWithdrawA);
    info = await mintB.getAccountInfo(userAccountB);
    assert.equal(info.amount.toNumber(), expectedWithdrawB);
    info = await tokenPool.getAccountInfo(userPoolAccount);
    assert.equal(info.amount.toNumber(), oldPoolToken.amount.toNumber() - withdrawalAmount);
    const newSwapTokenA = await mintA.getAccountInfo(tokenAccountA);
    assert.equal(newSwapTokenA.amount.toNumber(), oldSwapTokenA.amount.toNumber() - expectedWithdrawA);

    const newSwapTokenB = await mintB.getAccountInfo(tokenAccountB);
    assert.equal(newSwapTokenB.amount.toNumber(), oldSwapTokenB.amount.toNumber() - expectedWithdrawB);

    const logMessages = parseEventLogs(txReceipt?.meta?.logMessages ?? []);
    assert.deepEqual(logMessages, ([
      {
        type: "WithdrawA",
        tokenAAmount: new u64(expectedWithdrawA),
      },
      {
        type: "WithdrawB",
        tokenBAmount: new u64(expectedWithdrawB),
      },
      {
        type: "Burn",
        poolTokenAmount: new u64(withdrawalAmount),
      },
    ]));
  });

  
});
