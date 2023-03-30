import { Config } from "@0xsequence/core/src/commons/config";
import { WalletContext } from "@0xsequence/core/src/commons/context";
import { version } from "@0xsequence/migration";
import { SignedMigration } from "@0xsequence/migration/src/migrator";
import { PresignedConfigLink } from "@0xsequence/sessions/src/tracker";
import { PromiseCache } from "@0xsequence/utils";
import { ethers } from "ethers";
import { Account } from "../account";

export class BaseAccountStatusFetcher {
  // On-chain methods

  constructor(public window: number = 1000) {}

  async isDeployed(account: Account, chainId: ethers.BigNumberish, cache: PromiseCache = new PromiseCache()): Promise<boolean> {
    return cache.do('isDeployed', this.window, (address, chainId) => account.reader(chainId).isDeployed(address), account.address, chainId )
  }

  async onChainImageHashOf(account: Account, chainId: ethers.BigNumberish, cache: PromiseCache = new PromiseCache()): Promise<string> {
    return cache.do('onChainImageHash', this.window, (address, chainId) => account.reader(chainId).imageHash(address), account.address, chainId ).then((imageHash) => {
      if (!imageHash) {
        throw new Error(`Could not find imageHash for account: ${account.address}`)
      }
      return imageHash
    })
  }
  
  async onChainConfigOf(account: Account, chainId: ethers.BigNumberish, cache: PromiseCache = new PromiseCache()): Promise<Config> {
    const imageHash = await this.onChainImageHashOf(account, chainId, cache)

    // No need to cache this since it's cached by the tracker
    return account.tracker.configOfImageHash({ imageHash }).then((config) => {
      if (!config) {
        throw new Error(`Could not find config for imageHash: ${imageHash}`)
      }
      return config
    })
  }

  // Original methods

  async originalDeploymentInfoOf(account: Account): Promise<{ imageHash: string, context: WalletContext }> {
    // Optimization applied, the original imageHash is the same for all chains

    // No need to cache this since it's cached by the tracker
    return account.tracker.imageHashOfCounterfactualWallet({ wallet: account.address }).then((result) => {
      if (!result) {
        throw new Error(`Could not find original imageHash for account: ${account.address}`)
      }
      return result
    })
  }

  async originalImageHashOf(account: Account, cache: PromiseCache = new PromiseCache()): Promise<string> {
    return this.originalDeploymentInfoOf(account).then((result) => result.imageHash)
  }

  async originalContextOf(account: Account, cache: PromiseCache = new PromiseCache()): Promise<WalletContext> {
    return this.originalDeploymentInfoOf(account).then((result) => result.context)
  }

  async originalVersionOf(account: Account, cache: PromiseCache = new PromiseCache()): Promise<number> {
    // Optimization applied, the original version is the same for all chains
    // notice: this doesn't need to be cached, because it only uses `originalImageHashOf` which is cached
    const originalImageHash = await this.originalImageHashOf(account, cache)
    return version.counterfactualVersion(account.address, originalImageHash, Object.values(account.contexts))
  }

  // Mixed methods

  async implementationOf(account: Account, chainId: ethers.BigNumberish, cache: PromiseCache = new PromiseCache()): Promise<string> {
    return cache.do('implementationOf', this.window, (address, chainId) => account.reader(chainId).implementation(address), account.address, chainId ).then((implementation) => {
      if (!implementation) {
        throw new Error(`Could not find implementation for account: ${account.address}`)
      }
      return implementation
    })
  }

  async onChainVersionOf(account: Account, chainId: ethers.BigNumberish, cache: PromiseCache = new PromiseCache()): Promise<number> {
    // This doesn't need to be cached, because it only uses internal cached methods
    if (await this.isDeployed(account, chainId, cache).then((deployed) => !deployed)) {
      return this.originalVersionOf(account, cache)
    }

    const implementation = await this.implementationOf(account, chainId, cache)
    const versions = Object.values(account.contexts)

    for (const version of versions) {
      if (version.mainModule === implementation || version.mainModuleUpgradable === implementation) {
        return version.version
      }
    }

    throw new Error(`Could not find onChain version for account: ${account.address}`)
  }

  // Advanced methods
  async allSignedMigrationsInfo(account: Account, chainId: ethers.BigNumberish, cache: PromiseCache = new PromiseCache()): Promise<{
    lastVersion: number,
    lastImageHash: string,
    signedMigrations: SignedMigration[],
    missing: boolean
  }> {
    const onChainImageHash = await this.onChainImageHashOf(account, chainId, cache)
    const onChainVersion = await this.onChainVersionOf(account, chainId, cache)

    return cache.do('signedMigrationsOf', this.window, (address, fromImageHash, fromVersion, chainId) => account.migrator.getAllMigratePresignedTransaction({
      address, fromImageHash, fromVersion, chainId
    }), account.address, onChainImageHash, onChainVersion, chainId)
  }

  async isMigrated(account: Account, chainId: ethers.BigNumberish, cache: PromiseCache = new PromiseCache()): Promise<boolean> {
    // This doesn't need to be cached, because it only uses internal cached methods
    const onChainVersion = await this.onChainVersionOf(account, chainId, cache)
    if (onChainVersion === account.version) {
      return true
    }

    const signedMigrationsInfo = await this.allSignedMigrationsInfo(account, chainId, cache)
    if (signedMigrationsInfo.lastVersion === account.version) {
      return true
    }

    return false
  }

  async signedMigrationsOf(account: Account, chainId: ethers.BigNumberish, cache: PromiseCache = new PromiseCache()): Promise<SignedMigration[]> {
    return this.allSignedMigrationsInfo(account, chainId, cache).then((result) => result.signedMigrations)
  }

  async presignedConfigurationsOf(account: Account, chainId: ethers.BigNumberish, longestPath: boolean, cache: PromiseCache = new PromiseCache()): Promise<PresignedConfigLink[]> {
    let fromImageHash: string

    const isMigrated = await this.isMigrated(account, chainId, cache)
    if (isMigrated) {
      fromImageHash = await this.onChainImageHashOf(account, chainId, cache)
    } else {
      const signedMigrationsInfo = await this.allSignedMigrationsInfo(account, chainId, cache)
      fromImageHash = signedMigrationsInfo.lastImageHash
    }

    return cache.do('presignedConfigurationsOf', this.window, (wallet, fromImageHash, longestPath) => account.tracker.loadPresignedConfiguration({
      wallet, fromImageHash, longestPath
    }), account.address, fromImageHash, longestPath)
  }

  // High level methods

  async imageHashOf(account: Account, chainId: ethers.BigNumberish, cache: PromiseCache = new PromiseCache()): Promise<string> {
    // May have an imageHash assigned by a chain of delegations
    const presignedConfigurations = await this.presignedConfigurationsOf(account, chainId, false, cache)
    if (presignedConfigurations.length !== 0) {
      return presignedConfigurations[-1].nextImageHash
    }

    // May have an imageHash assigned on a migration
    const isMigrated = await this.isMigrated(account, chainId, cache)
    if (isMigrated) {
      return this.allSignedMigrationsInfo(account, chainId, cache).then((result) => result.lastImageHash)
    }

    // May have an onChain imageHash
    const onChainImageHash = await this.onChainImageHashOf(account, chainId, cache)
    if (onChainImageHash) {
      return onChainImageHash
    }

    // The only option left is the original imageHash
    return this.originalImageHashOf(account, cache)
  }

  async configOf(account: Account, chainId: ethers.BigNumberish, cache: PromiseCache = new PromiseCache()): Promise<Config> {
    const res = await this.imageHashOf(account, chainId, cache).then((imageHash) => account.tracker.configOfImageHash({ imageHash }))
    if (!res) {
      throw new Error(`Could not find config for account: ${account.address}`)
    }

    return res
  }
}