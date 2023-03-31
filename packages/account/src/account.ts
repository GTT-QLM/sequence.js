import { commons, universal } from '@0xsequence/core'
import { migrator, defaults, version } from '@0xsequence/migration'
import { NetworkConfig } from '@0xsequence/network'
import { FeeOption, FeeQuote, isRelayer, Relayer, RpcRelayer } from '@0xsequence/relayer'
import { tracker } from '@0xsequence/sessions'
import { Orchestrator } from '@0xsequence/signhub'
import { encodeTypedDataDigest } from '@0xsequence/utils'
import { Wallet } from '@0xsequence/wallet'
import { ethers, TypedDataDomain, TypedDataField } from 'ethers'
import { BaseAccountStatusFetcher } from './status/fetcher'

export type AccountStatus = {
  original: {
    version: number,
    imageHash: string,
    context: commons.context.WalletContext
  }
  onChain: {
    imageHash: string,
    config: commons.config.Config,
    version: number,
    deployed: boolean
  },
  fullyMigrated: boolean,
  signedMigrations: migrator.SignedMigration[],
  version: number,
  presignedConfigurations: tracker.PresignedConfigLink[],
  imageHash: string,
  config: commons.config.Config,
  checkpoint: ethers.BigNumberish,
  canOnchainValidate: boolean,
}

export type AccountOptions = {
  // The only unique identifier for a wallet is the address
  address: string,

  // The config tracker keeps track of chained configs,
  // counterfactual addresses and reverse lookups for configurations
  // it must implement both the ConfigTracker and MigrationTracker
  tracker: tracker.ConfigTracker & migrator.PresignedMigrationTracker,

  // Versioned contexts contains the context information for each Sequence version
  contexts: commons.context.VersionedContext

  // Optional list of migrations, if not provided, the default migrations will be used
  // NOTICE: the last vestion is considered the "current" version for the account
  migrations?: migrator.Migrations

  // Orchestrator manages signing messages and transactions
  orchestrator: Orchestrator

  // Networks information and providers
  networks: NetworkConfig[]
}

class Chain0Reader implements commons.reader.Reader {
  async isDeployed(_wallet: string): Promise<boolean> {
    return false
  }

  async implementation(_wallet: string): Promise<string | undefined> {
    return undefined
  }

  async imageHash(_wallet: string): Promise<string | undefined> {
    return undefined
  }

  async nonce(_wallet: string, _space: ethers.BigNumberish): Promise<ethers.BigNumberish> {
    return ethers.constants.Zero
  }

  async isValidSignature(_wallet: string, _digest: ethers.utils.BytesLike, _signature: ethers.utils.BytesLike): Promise<boolean> {
    throw new Error('Method not supported.')
  }
}

export class Account {
  public readonly address: string

  public readonly networks: NetworkConfig[]
  public readonly tracker: tracker.ConfigTracker & migrator.PresignedMigrationTracker
  public readonly contexts: commons.context.VersionedContext

  public readonly migrator: migrator.Migrator
  public readonly migrations: migrator.Migrations

  public readonly fetcher: BaseAccountStatusFetcher

  private orchestrator: Orchestrator

  constructor(options: AccountOptions) {
    this.address = ethers.utils.getAddress(options.address)

    this.contexts = options.contexts
    this.tracker = options.tracker
    this.networks = options.networks
    this.orchestrator = options.orchestrator

    this.migrations = options.migrations || defaults.DefaultMigrations
    this.migrator = new migrator.Migrator(options.tracker, this.migrations, this.contexts)

    this.fetcher = new BaseAccountStatusFetcher({
      tracker: this.tracker,
      migrator: this.migrator,
      maxVersion: this.migrator.lastMigration().version,
      reader: (chainId: ethers.BigNumberish) => this.reader(chainId),
      contexts: this.contexts
    })
  }

  static async new(options: {
    config: commons.config.SimpleConfig,
    tracker: tracker.ConfigTracker & migrator.PresignedMigrationTracker,
    contexts: commons.context.VersionedContext,
    orchestrator: Orchestrator,
    networks: NetworkConfig[],
    migrations?: migrator.Migrations
  }): Promise<Account> {
    const mig = new migrator.Migrator(
      options.tracker,
      options.migrations ?? defaults.DefaultMigrations,
      options.contexts
    )

    const lastMigration = mig.lastMigration()
    const lastCoder = lastMigration.configCoder

    const config = lastCoder.fromSimple(options.config)
    const imageHash = lastCoder.imageHashOf(config)
    const context = options.contexts[lastMigration.version]
    const address = commons.context.addressOf(context, imageHash)

    await options.tracker.saveCounterfactualWallet({ config, context: Object.values(options.contexts) })

    return new Account({
      address,
      tracker: options.tracker,
      contexts: options.contexts,
      networks: options.networks,
      orchestrator: options.orchestrator,
      migrations: options.migrations
    })
  }

  getAddress(): Promise<string> {
    return Promise.resolve(this.address)
  }

  get version(): number {
    return this.migrator.lastMigration().version
  }

  get coders(): {
    signature: commons.signature.SignatureCoder,
    config: commons.config.ConfigCoder,
  } {
    const lastMigration = this.migrator.lastMigration()

    return {
      signature: lastMigration.signatureCoder,
      config: lastMigration.configCoder
    }
  }

  network(chainId: ethers.BigNumberish): NetworkConfig {
    const tcid = ethers.BigNumber.from(chainId)
    const found = this.networks.find((n) => tcid.eq(n.chainId))
    if (!found) throw new Error(`Network not found for chainId ${chainId}`)
    return found
  }

  provider(chainId: ethers.BigNumberish): ethers.providers.Provider {
    const found = this.network(chainId)
    if (!found.provider && !found.rpcUrl) throw new Error(`Provider not found for chainId ${chainId}`)
    return found.provider || new ethers.providers.JsonRpcProvider(found.rpcUrl)
  }

  reader(chainId: ethers.BigNumberish): commons.reader.Reader {
    if (ethers.constants.Zero.eq(chainId)) return new Chain0Reader()

    // TODO: Networks should be able to provide a reader directly
    // and we should default to the on-chain reader
    return new commons.reader.OnChainReader(this.provider(chainId))
  }

  relayer(chainId: ethers.BigNumberish): Relayer {
    const found = this.network(chainId)
    if (!found.relayer) throw new Error(`Relayer not found for chainId ${chainId}`)
    if (isRelayer(found.relayer)) return found.relayer
    return new RpcRelayer(found.relayer)
  }

  setOrchestrator(orchestrator: Orchestrator) {
    this.orchestrator = orchestrator
  }

  contextFor(version: number): commons.context.WalletContext {
    const ctx = this.contexts[version]
    if (!ctx) throw new Error(`Context not found for version ${version}`)
    return ctx
  }

  async walletForChain(chainId: ethers.BigNumberish): Promise<Wallet> {
    const [version, config] = await Promise.all([
      this.fetcher.versionOf(this.address, chainId),
      this.fetcher.configOf(this.address, chainId),
    ])

    return this.walletForStatus(chainId, version, config)
  }

  walletForStatus(
    chainId: ethers.BigNumberish,
    version: number,
    config: commons.config.Config,
  ): Wallet {
    const coder = universal.coderFor(version)
    return this.walletFor(
      chainId,
      this.contextFor(version),
      config,
      coder,
    )
  }

  walletFor(
    chainId: ethers.BigNumberish,
    context: commons.context.WalletContext,
    config: commons.config.Config,
    coders: typeof this.coders
  ): Wallet {
    const isNetworkZero = ethers.constants.Zero.eq(chainId)
    return new Wallet({
      config,
      context,
      chainId,
      coders,
      relayer: isNetworkZero ? undefined : this.relayer(chainId),
      address: this.address,
      orchestrator: this.orchestrator,
      reader: this.reader(chainId),
    })
  }

  // Gets the current on-chain version of the wallet
  // on a given network
  async onchainVersionInfo(chainId: ethers.BigNumberish): Promise<{
    first: {
      imageHash: string,
      context: commons.context.WalletContext,
      version: number
    }
    current: number
  }> {
    // First we need to use the tracker to get the counterfactual imageHash
    const firstImageHash = await this.tracker.imageHashOfCounterfactualWallet({
      wallet: this.address
    })

    if (!firstImageHash) {
      throw new Error(`Counterfactual imageHash not found for wallet ${this.address}`)
    }

    const current = await version.versionOf(
      this.address,
      firstImageHash.imageHash,
      this.contexts,
      this.reader(chainId)
    )

    // To find the first version, we need to try the firstImageHash
    // with every context, and find the first one that matches
    const first = version.counterfactualVersion(
      this.address,
      firstImageHash.imageHash,
      Object.values(this.contexts),
    )

    return { first: { ...firstImageHash, version: first }, current }
  }


  private async mustBeFullyMigrated(chainId: ethers.BigNumberish) {
    if (await this.fetcher.isMigrated(this.address, chainId).then((x) => !x)) {
      throw new Error(`Wallet ${this.address} is not fully migrated`)
    }
  }

  async predecorateTransactions(
    txs: commons.transaction.Transactionish,
    chainId: ethers.BigNumberish,
  ): Promise<commons.transaction.Transactionish> {
    // if onchain wallet config is not up to date
    // then we should append an extra transaction that updates it
    // to the latest "lazy" state

    const [imageHash, onChainImageHash] = await Promise.all([
      this.fetcher.imageHashOf(this.address, chainId),
      this.fetcher.onChainImageHashOf(this.address, chainId)
    ])

    if (imageHash !== onChainImageHash) {
      const [version, config] = await Promise.all([
        this.fetcher.versionOf(this.address, chainId),
        this.fetcher.configOf(this.address, chainId)
      ])

      const wallet = this.walletForStatus(chainId, version, config)

      const updateConfig = await wallet.buildUpdateConfigurationTransaction(config)
      return [(Array.isArray(txs) ? txs : [txs]), updateConfig.transactions].flat()
    }

    return txs
  }

  async decorateTransactions(
    bundle: commons.transaction.IntendedTransactionBundle
  ): Promise<commons.transaction.IntendedTransactionBundle> {
    const bootstrapBundle = await this.buildBootstrapTransactions(bundle.chainId)
    if (bootstrapBundle.transactions.length === 0) {
      return bundle
    }

    return {
      entrypoint: bootstrapBundle.entrypoint,
      chainId: bundle.chainId,
      intent: bundle.intent,
      transactions: [
        ...bootstrapBundle.transactions,
       {
          to: bundle.entrypoint,
          data: commons.transaction.encodeBundleExecData(bundle),
          gasLimit: 0,
          delegateCall: false,
          revertOnError: true,
          value: 0
        }
      ]
    }
  }

  async decorateSignature<T extends ethers.BytesLike>(
    signature: T,
    chainId: ethers.BigNumberish,
  ): Promise<T | string> {
    const presignedConfigurations = await this.fetcher.presignedConfigurationsOf(this.address, chainId, false)
    if (!presignedConfigurations || presignedConfigurations.length === 0) {
      return signature
    }

    const coder = this.coders.signature

    const chain = presignedConfigurations.map((c) => c.signature)
    const chainedSignature = coder.chainSignatures(signature, chain)
    return coder.encode(chainedSignature)
  }

  async publishWitness(): Promise<void> {
    const digest = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`This is a Sequence account woo! ${Date.now()}`))
    const signature = await this.signDigest(digest, 0, false)
    const decoded = this.coders.signature.decode(signature)
    const signatures = this.coders.signature.signaturesOfDecoded(decoded)
    return this.tracker.saveWitnesses({ wallet: this.address, digest, chainId: 0, signatures })
  }

  async signDigest(
    digest: ethers.BytesLike,
    chainId: ethers.BigNumberish,
    decorate: boolean = true
  ): Promise<string> {
    // If we are signing a digest for chainId zero then we can never be fully migrated
    // because Sequence v1 doesn't allow for signing a message on "all chains"

    // So we ignore the state on "chain zero" and instead use one of the states of the networks
    // wallet-webapp should ensure the wallet is as migrated as possible, trying to mimic
    // the behaviour of being migrated on all chains

    const chainRef = ethers.constants.Zero.eq(chainId) ? this.networks[0].chainId : chainId
    await this.mustBeFullyMigrated(chainRef)

    const use = await Promise.all([
      this.fetcher.configOf(this.address, chainRef),
      this.fetcher.versionOf(this.address, chainRef)
    ])

    const wallet = this.walletForStatus(chainId, use[1], use[0])
    const signature = await wallet.signDigest(digest)

    return decorate ? this.decorateSignature(signature, chainId) : signature
  }

  async editConfig(
    changes: {
      add?: commons.config.SimpleSigner[];
      remove?: string[];
      threshold?: ethers.BigNumberish;
    }
  ): Promise<void> {
    const currentConfig = await this.fetcher.configOf(this.address, 0)
    const newConfig = this.coders.config.editConfig(currentConfig, {
      ...changes,
      checkpoint: this.coders.config.checkpointOf(currentConfig).add(1)
    })

    return this.updateConfig(newConfig)
  }

  async updateConfig(
    config: commons.config.Config
  ): Promise<void> {
    // config should be for the current version of the wallet
    if (!this.coders.config.isWalletConfig(config)) {
      throw new Error(`Invalid config for wallet ${this.address}`)
    }

    const nextImageHash = this.coders.config.imageHashOf(config)

    // sign an update config struct
    const updateStruct = this.coders.signature.hashSetImageHash(nextImageHash)

    // sign the update struct, using chain id 0
    const signature = await this.signDigest(updateStruct, 0, false)

    // save the presigned transaction to the sessions tracker
    await this.tracker.savePresignedConfiguration({
      wallet: this.address,
      nextConfig: config,
      signature
    })

    this.clearCache()
  }

  /**
   *  This method is used to bootstrap the wallet on a given chain.
   *  this deploys the wallets and executes all the necessary transactions
   *  for that wallet to start working with the given version.
   * 
   *  This usually involves: (a) deploying the wallet, (b) executing migrations
   * 
   *  Notice: It should NOT explicitly include chained signatures. Unless internally used
   *  by any of the migrations.
   * 
   */
  async buildBootstrapTransactions(
    chainId: ethers.BigNumberish
  ): Promise<Omit<commons.transaction.IntendedTransactionBundle, 'chainId'>> {
    const transactions: commons.transaction.Transaction[] = []


    const promiseMigrations = this.fetcher.signedMigrationsOf(this.address, chainId)
    const promiseVersion = this.fetcher.versionOf(this.address, chainId)

    // Add wallet deployment if needed
    const deployed = await this.fetcher.isDeployed(this.address, chainId)

    if (!deployed) {
      const originalDeploymentInfo = await this.fetcher.originalDeploymentInfoOf(this.address)

      // Wallet deployment will vary depending on the version
      // so we need to use the context to get the correct deployment
      const deployTransaction = Wallet.buildDeployTransaction(
        originalDeploymentInfo.context,
        originalDeploymentInfo.imageHash
      )

      transactions.push(...deployTransaction.transactions)
    }

    const [signedMigrations, version] = await Promise.all([promiseMigrations, promiseVersion])

    // Get pending migrations
    transactions.push(...signedMigrations.map((m) => ({
      to: m.tx.entrypoint,
      data: commons.transaction.encodeBundleExecData(m.tx),
      value: 0,
      gasLimit: 0,
      revertOnError: true,
      delegateCall: false
    })))

    // Build the transaction intent, if the transaction has migrations
    // then we should use one of the intents of the migrations (anyone will do)
    // if it doesn't, then we must build a random intent, this is not ideal
    // because we will not be able to track the transaction later
    const id = signedMigrations.length > 0
      ? signedMigrations[0].tx.intent.id
      : ethers.utils.hexlify(ethers.utils.randomBytes(32))

    // Everything is encoded as a bundle
    // using the GuestModule of the account version
    const { guestModule } = this.contextFor(version)
    return { entrypoint: guestModule, transactions, intent: { id, wallet: this.address } }
  }

  async doBootstrap(
    chainId: ethers.BigNumberish,
    feeQuote?: FeeQuote,
    prestatus?: AccountStatus
  ) {
    const bootstrapTxs = await this.buildBootstrapTransactions(chainId)
    const intended = commons.transaction.intendTransactionBundle(
      bootstrapTxs,
      this.address,
      chainId,
      ethers.utils.hexlify(ethers.utils.randomBytes(32))
    )

    return this.relayer(chainId).relay(intended, feeQuote)
  }

  signMessage(message: ethers.BytesLike, chainId: ethers.BigNumberish): Promise<string> {
    return this.signDigest(ethers.utils.keccak256(message), chainId)
  }

  async signTransactions(
    txs: commons.transaction.Transactionish,
    chainId: ethers.BigNumberish
  ): Promise<commons.transaction.SignedTransactionBundle> {
    await this.mustBeFullyMigrated(chainId)

    const wallet = await this.walletForChain(chainId)
    const signed = await wallet.signTransactions(txs)

    return {
      ...signed,
      signature: await this.decorateSignature(signed.signature, chainId)
    }
  }

  async signMigrations(chainId: ethers.BigNumberish, editConfig: (prevConfig: commons.config.Config) => commons.config.Config): Promise<boolean> {
    const isMigrated = await this.fetcher.isMigrated(this.address, chainId)
    if (isMigrated) return false

    const wallet = await this.walletForChain(chainId)
    const version = await this.fetcher.versionOf(this.address, chainId)
    const signed = await this.migrator.signNextMigration(this.address, version, wallet, editConfig(wallet.config))
    if (!signed) return false

    await this.tracker.saveMigration(this.address, signed, this.contexts)
    return true
  }

  async signAllMigrations(editConfig: (prevConfig: commons.config.Config) => commons.config.Config) {
    await Promise.all(this.networks.map((n) => this.signMigrations(n.chainId, editConfig)))
    this.clearCache()
  }

  async isMigratedAllChains(): Promise<boolean> {
    const isMigrated = await Promise.all(this.networks.map((n) => this.fetcher.isMigrated(this.address, n.chainId)))
    return isMigrated.every((m) => m)
  }

  async sendSignedTransactions(
    signedBundle: commons.transaction.IntendedTransactionBundle,
    chainId: ethers.BigNumberish,
    quote?: FeeQuote
  ): Promise<ethers.providers.TransactionResponse> {
    const [decoratedBundle, _] = await Promise.all([
      this.decorateTransactions(signedBundle),
      this.mustBeFullyMigrated(chainId)
    ])

    return this.relayer(chainId).relay(decoratedBundle, quote)
  }

  async fillGasLimits(
    txs: commons.transaction.Transactionish,
    chainId: ethers.BigNumberish
  ): Promise<commons.transaction.SimulatedTransaction[]> {
    const wallet = await this.walletForChain(chainId)
    return wallet.fillGasLimits(txs)
  }

  async gasRefundQuotes(
    txs: commons.transaction.Transactionish,
    chainId: ethers.BigNumberish,
    stubSignatureOverrides: Map<string, string>
  ): Promise<{
    options: FeeOption[];
    quote?: FeeQuote,
    decorated: commons.transaction.IntendedTransactionBundle
  }> {
    const wallet = await this.walletForChain(chainId)

    const predecorated = await this.predecorateTransactions(txs, chainId)
    const transactions = commons.transaction.fromTransactionish(this.address, predecorated)

    // We can't sign the transactions (because we don't want to bother the user)
    // so we use the latest configuration to build a "stub" signature, the relayer
    // knows to ignore the wallet signatures
    const stubSignature = wallet.coders.config.buildStubSignature(wallet.config, stubSignatureOverrides)

    // Now we can decorate the transactions as always, but we need to manually build the signed bundle
    const intentId = ethers.utils.hexlify(ethers.utils.randomBytes(32))
    const signedBundle: commons.transaction.SignedTransactionBundle = {
      chainId,
      intent: {
        id: intentId,
        wallet: this.address,
      },
      signature: stubSignature,
      transactions,
      entrypoint: this.address,
      nonce: 0 // The relayer also ignored the nonce
    }

    const decoratedBundle = await this.decorateTransactions(signedBundle)
    const data = commons.transaction.encodeBundleExecData(decoratedBundle)
    const res = await this.relayer(chainId).getFeeOptionsRaw(decoratedBundle.entrypoint, data)
    return { ...res, decorated: decoratedBundle }
  }

  async prepareTransactions(args: {
    txs: commons.transaction.Transactionish,
    chainId: ethers.BigNumberish,
    stubSignatureOverrides: Map<string, string>
  }): Promise<{
    transactions: commons.transaction.SimulatedTransaction[],
    flatDecorated: commons.transaction.Transaction[],
    options: FeeOption[],
    quote?: FeeQuote
  }> {
    const transactions = await this.fillGasLimits(args.txs, args.chainId)
    const gasRefundQuote = await this.gasRefundQuotes(transactions, args.chainId, args.stubSignatureOverrides)
    const flatDecorated = commons.transaction.unwind(this.address, gasRefundQuote.decorated.transactions)

    return {
      transactions,
      flatDecorated,
      options: gasRefundQuote.options,
      quote: gasRefundQuote.quote
    }
  }

  async sendTransaction(
    txs: commons.transaction.Transactionish,
    chainId: ethers.BigNumberish,
    quote?: FeeQuote,
    skipPreDecorate: boolean = false,
    callback?: (signed: commons.transaction.SignedTransactionBundle) => void
  ): Promise<ethers.providers.TransactionResponse> {
    const predecorated = skipPreDecorate ? txs : await this.predecorateTransactions(txs, chainId)
    const signed = await this.signTransactions(predecorated, chainId)
    if (callback) callback(signed)

    const res = await this.sendSignedTransactions(signed, chainId, quote)
    this.clearCache()
    return res
  }

  async signTypedData(
    domain: TypedDataDomain,
    types: Record<string, Array<TypedDataField>>,
    message: Record<string, any>,
    chainId: ethers.BigNumberish
  ): Promise<string> {
    const digest = encodeTypedDataDigest({ domain, types, message })
    return this.signDigest(digest, chainId)
  }

  async getAllSigners(): Promise<{
    address: string,
    weight: number,
    network: number,
    flaggedForRemoval: boolean
  }[]> {
    const allSigners: {
      address: string,
      weight: number,
      network: number,
      flaggedForRemoval: boolean
    }[] = []

    // We need to get the signers for each status
    await Promise.all(this.networks.map(async network => {
      const chainId = network.chainId

      // Getting the chain with `longestPath` set to true will give us all the possible configurations
      // between the current onChain config and the latest config, including the ones "flagged for removal"
      const presignedConfigurations = await this.fetcher.presignedConfigurationsOf(this.address, chainId, true)

      const versions = await Promise.all([
        this.fetcher.onChainVersionOf(this.address, chainId),
        this.fetcher.versionOf(this.address, chainId)
      ])

      const fullChain = [
        await this.fetcher.onChainImageHashOf(this.address, chainId),
        ...(
          versions[0] !== versions[1] ? await this.fetcher.signedMigrationsOf(
            this.address, chainId
          ).then((r) => r.map((u) => universal.coderFor(u.toVersion).config.imageHashOf(u.toConfig as any))) : []
        ),
        ...presignedConfigurations.map((update) => update.nextImageHash)
      ]

      return Promise.all(fullChain.map(async (imageHash, iconf) => {
        const isLast = iconf === presignedConfigurations.length - 1
        const config = await this.tracker.configOfImageHash({ imageHash })
        if (!config) {
          console.warn(`AllSigners may be incomplete, config not found for imageHash ${imageHash}`)
          return
        }

        const coder = universal.genericCoderFor(config.version)
        const signers = coder.config.signersOf(config)

        signers.forEach((signer) => {
          const exists = allSigners.find((s) => (
            s.address === signer.address &&
            s.network === chainId
          ))

          if (exists && isLast && exists.flaggedForRemoval) {
            exists.flaggedForRemoval = false
            return
          }

          if (exists) return

          allSigners.push({
            address: signer.address,
            weight: signer.weight,
            network: chainId,
            flaggedForRemoval: !isLast
          })
        })
      }))
    }))

    return allSigners
  }

  clearCache(): void {
    this.fetcher.clearCache()
  }

  /**
   * @deprecated This method is way too slow, use the individual methods instead.
   */
  async status(chainId: ethers.BigNumberish, longestPath: boolean = false): Promise<AccountStatus> {
    const [
      originalVersion,
      originalImageHash,
      originalContext,
      onChainImageHash,
      onChainConfig,
      onChainVersion,
      onChainDeployed,
      fullyMigrated,
      signedMigrations,
      version,
      presignedConfigurations,
      imageHash,
      config
    ] = await Promise.all([
      this.fetcher.originalVersionOf(this.address),
      this.fetcher.originalImageHashOf(this.address),
      this.fetcher.originalContextOf(this.address),
      this.fetcher.onChainImageHashOf(this.address, chainId),
      this.fetcher.onChainConfigOf(this.address, chainId),
      this.fetcher.onChainVersionOf(this.address, chainId),
      this.fetcher.isDeployed(this.address, chainId),
      this.fetcher.isMigrated(this.address, chainId),
      this.fetcher.signedMigrationsOf(this.address, chainId),
      this.fetcher.versionOf(this.address, chainId),
      this.fetcher.presignedConfigurationsOf(this.address, chainId, longestPath),
      this.fetcher.imageHashOf(this.address, chainId),
      this.fetcher.configOf(this.address, chainId)
    ])

    const checkpoint = universal.coderFor(version).config.checkpointOf(config as any)
    const canOnchainValidate = (version === this.version && onChainDeployed)

    return {
      original: {
        version: originalVersion,
        imageHash: originalImageHash,
        context: originalContext
      },
      onChain: {
        imageHash: onChainImageHash,
        config: onChainConfig,
        version: onChainVersion,
        deployed: onChainDeployed
      },
      fullyMigrated,
      signedMigrations,
      version,
      presignedConfigurations,
      imageHash,
      config,
      checkpoint,
      canOnchainValidate
    }
  }
}
