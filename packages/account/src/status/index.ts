import { commons } from "@0xsequence/core"
import { migrator } from "@0xsequence/migration"
import { tracker } from "@0xsequence/sessions"
import { ethers } from "ethers"
import { Account } from "../account"

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

export type AccountStatusCache = Partial<{ [K in keyof AccountStatus]: Partial<AccountStatus[K]> }>

export interface AccountStatusFetcher {
  // Everything at once, fetched in the most efficient way possible
  statusOf(account: Account): Promise<AccountStatus>

  // Granular fetches for each piece of data

  isDeployed(account: Account, chainId: ethers.BigNumberish, cache?: AccountStatusCache): Promise<boolean>

  originalVersionOf(account: Account, cache?: AccountStatusCache): Promise<number>
  originalImageHashOf(account: Account, cache?: AccountStatusCache): Promise<string>
  originalContextOf(account: Account, cache?: AccountStatusCache): Promise<commons.context.WalletContext>

  onChainImageHashOf(account: Account, cache?: AccountStatusCache): Promise<string>
  onChainConfigOf(account: Account, cache?: AccountStatusCache): Promise<commons.config.Config>
  onChainVersionOf(account: Account, cache?: AccountStatusCache): Promise<number>

  isFullyMigrated(account: Account, cache?: AccountStatusCache): Promise<boolean>
  signedMigrationsOf(account: Account, cache?: AccountStatusCache): Promise<migrator.SignedMigration[]>
  versionOf(account: Account, cache?: AccountStatusCache): Promise<number>
  presignedConfigurationsOf(account: Account, cache?: AccountStatusCache): Promise<tracker.PresignedConfigLink[]>
  imageHashOf(account: Account, cache?: AccountStatusCache): Promise<string>
  configOf(account: Account, cache?: AccountStatusCache): Promise<commons.config.Config>
  checkpointOf(account: Account, cache?: AccountStatusCache): Promise<ethers.BigNumberish>
  canOnchainValidate(account: Account, cache?: AccountStatusCache): Promise<boolean>
}
