import { commons } from "@0xsequence/core"
import { Config } from "@0xsequence/core/src/commons/config"
import { WalletContext } from "@0xsequence/core/src/commons/context"
import { migrator, version } from '@0xsequence/migration'
import { SignedMigration } from "@0xsequence/migration/src/migrator"
import { tracker } from "@0xsequence/sessions"
import { PresignedConfigLink } from "@0xsequence/sessions/src/tracker"
import { PromiseCache } from "@0xsequence/utils"
import { ethers } from "ethers"

/**
 * @title BaseAccountStatusFetcher
 * @dev The `BaseAccountStatusFetcher` class is designed for fetching "status" data from an account in a deduplicated way.
 * It avoids making duplicated calls to internal dependencies. For example, if two methods depend on `imageHash`,
 * `imageHash` gets called only once. It also allows for fetching data with the least number of requests possible.
 *
 * The class can be used as a long-term cache by setting a long window and manually calling `clearCache()`.
 */
export class BaseAccountStatusFetcher {
  public reader: (chainId: ethers.BigNumberish) => commons.reader.Reader
  public tracker: tracker.ConfigTracker & migrator.PresignedMigrationTracker
  public migrator: migrator.Migrator
  public contexts: commons.context.VersionedContext
  public maxVersion: number

  constructor(
    config: {
      reader: (chainId: ethers.BigNumberish) => commons.reader.Reader,
      tracker: tracker.ConfigTracker & migrator.PresignedMigrationTracker,
      migrator: migrator.Migrator,
      contexts: commons.context.VersionedContext,
      maxVersion: number
    },
    public window: number = 500,
    private cache: PromiseCache = new PromiseCache()
  ) {
    this.reader = config.reader
    this.tracker = config.tracker
    this.migrator = config.migrator
    this.contexts = config.contexts
    this.maxVersion = config.maxVersion
  }

  clearCache() {
    this.cache.clear()
  }

  // On-chain methods

  async isDeployed(address: string, chainId: ethers.BigNumberish): Promise<boolean> {
    return this.cache.do('isDeployed', this.window, (address, chainId) => this.reader(chainId).isDeployed(address), address, chainId )
  }

  async onChainImageHashOf(address: string, chainId: ethers.BigNumberish): Promise<string> {
    const explicit = await this.cache.do('onChainImageHash', this.window, async (address, chainId) => this.reader(chainId).imageHash(address), address, chainId )
    if (explicit) return explicit
    return this.originalImageHashOf(address)
  }
  
  async onChainConfigOf(address: string, chainId: ethers.BigNumberish): Promise<Config> {
    const imageHash = await this.onChainImageHashOf(address, chainId)
    if (!imageHash) {
      throw new Error(`Could not find imageHash for account: ${address}`)
    }

    // No need to cache this since it's cached by the tracker
    return this.tracker.configOfImageHash({ imageHash }).then((result) => {
      if (!result) {
        throw new Error(`Could not find config for imageHash: ${imageHash}`)
      }
      return result
    })
  }

  // Original methods

  async originalDeploymentInfoOf(address: string): Promise<{ imageHash: string, context: WalletContext }> {
    // Optimization applied, the original imageHash is the same for all chains

    // No need to cache this since it's cached by the tracker
    return this.tracker.imageHashOfCounterfactualWallet({ wallet: address }).then((result) => {
      if (!result) {
        throw new Error(`Could not find original imageHash for account: ${address}`)
      }
      return result
    })
  }

  async originalImageHashOf(address: string): Promise<string> {
    return this.originalDeploymentInfoOf(address).then((result) => result.imageHash)
  }

  async originalContextOf(address: string): Promise<WalletContext> {
    return this.originalDeploymentInfoOf(address).then((result) => result.context)
  }

  async originalVersionOf(address: string): Promise<number> {
    // Optimization applied, the original version is the same for all chains
    // notice: this doesn't need to be cached, because it only uses `originalImageHashOf` which is cached
    const originalImageHash = await this.originalImageHashOf(address)
    return version.counterfactualVersion(address, originalImageHash, Object.values(this.contexts))
  }

  // Mixed methods

  async implementationOf(address: string, chainId: ethers.BigNumberish): Promise<string> {
    return this.cache.do('implementationOf', this.window, (address, chainId) => this.reader(chainId).implementation(address), address, chainId ).then((implementation) => {
      if (!implementation) {
        throw new Error(`Could not find implementation for account: ${address}`)
      }
      return implementation
    })
  }

  async onChainVersionOf(address: string, chainId: ethers.BigNumberish): Promise<number> {
    // This doesn't need to be cached, because it only uses internal cached methods
    if (await this.isDeployed(address, chainId).then((deployed) => !deployed)) {
      return this.originalVersionOf(address)
    }

    const implementation = await this.implementationOf(address, chainId)
    const versions = Object.values(this.contexts)

    for (const version of versions) {
      if (version.mainModule === implementation || version.mainModuleUpgradable === implementation) {
        return version.version
      }
    }

    throw new Error(`Could not find onChain version for account: ${address}`)
  }

  // Advanced methods
  async allSignedMigrationsInfo(address: string, chainId: ethers.BigNumberish): Promise<{
    lastVersion: number,
    lastImageHash: string,
    signedMigrations: SignedMigration[],
    missing: boolean
  }> {
    const [onChainImageHash, onChainVersion] = await Promise.all([
      this.onChainImageHashOf(address, chainId),
      this.onChainVersionOf(address, chainId),
    ])

    if (!onChainImageHash) {
      throw new Error(`Could not find onChain imageHash for account: ${address}`)
    }

    return this.cache.do('signedMigrationsOf', this.window, (address, fromImageHash, fromVersion, chainId) => this.migrator.getAllMigratePresignedTransaction({
      address, fromImageHash, fromVersion, chainId
    }), address, onChainImageHash, onChainVersion, chainId)
  }

  async isMigrated(address: string, chainId: ethers.BigNumberish): Promise<boolean> {
    // This doesn't need to be cached, because it only uses internal cached methods
    const onChainVersion = await this.onChainVersionOf(address, chainId)
    if (onChainVersion === this.maxVersion) {
      return true
    }

    const signedMigrationsInfo = await this.allSignedMigrationsInfo(address, chainId)
    if (signedMigrationsInfo.lastVersion === this.maxVersion) {
      return true
    }

    return false
  }

  async signedMigrationsOf(address: string, chainId: ethers.BigNumberish): Promise<SignedMigration[]> {
    return this.allSignedMigrationsInfo(address, chainId).then((result) => result.signedMigrations)
  }

  async presignedConfigurationsOf(address: string, chainId: ethers.BigNumberish, longestPath: boolean): Promise<PresignedConfigLink[]> {
    let fromImageHash: string

    const isMigrated = await this.isMigrated(address, chainId)
    if (isMigrated) {
      fromImageHash = await this.onChainImageHashOf(address, chainId)
    } else {
      const signedMigrationsInfo = await this.allSignedMigrationsInfo(address, chainId)
      fromImageHash = signedMigrationsInfo.lastImageHash
    }

    return this.cache.do('presignedConfigurationsOf', this.window, (wallet, fromImageHash, longestPath) => this.tracker.loadPresignedConfiguration({
      wallet, fromImageHash, longestPath
    }), address, fromImageHash, longestPath)
  }

  // High level methods

  async imageHashOf(address: string, chainId: ethers.BigNumberish): Promise<string> {
    // May have an imageHash assigned by a chain of delegations
    const presignedConfigurations = await this.presignedConfigurationsOf(address, chainId, false)
    if (presignedConfigurations.length !== 0) {
      return presignedConfigurations[presignedConfigurations.length - 1].nextImageHash
    }

    // May have an imageHash assigned on a migration
    const isMigrated = await this.isMigrated(address, chainId)
    if (isMigrated) {
      return this.allSignedMigrationsInfo(address, chainId).then((result) => result.lastImageHash)
    }

    // May have an onChain imageHash
    const onChainImageHash = await this.onChainImageHashOf(address, chainId)
    if (onChainImageHash) {
      return onChainImageHash
    }

    // The only option left is the original imageHash
    return this.originalImageHashOf(address)
  }

  async configOf(address: string, chainId: ethers.BigNumberish): Promise<Config> {
    const res = await this.imageHashOf(address, chainId).then((imageHash) => this.tracker.configOfImageHash({ imageHash }))
    if (!res) {
      throw new Error(`Could not find config for account: ${address}`)
    }

    return res
  }

  async versionOf(address: string, chainId: ethers.BigNumberish): Promise<number> {
    // This doesn't need to be cached, because it only uses internal cached methods
    const isMigrated = await this.isMigrated(address, chainId)

    if (isMigrated) {
      return this.maxVersion
    }

    return this.onChainVersionOf(address, chainId)
  }
}
