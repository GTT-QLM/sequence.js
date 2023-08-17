import { ethers } from 'ethers'
import { commons } from '@0xsequence/core'
import { Status } from '../orchestrator'
import { SapientSigner } from './signer'

export class SignerWrapper implements SapientSigner {
  constructor(
    public signer: ethers.Signer,
    public eoa: boolean = true
  ) {}

  getAddress(): Promise<string> {
    return this.signer.getAddress()
  }

  async buildDeployTransaction(): Promise<commons.transaction.TransactionBundle | null> {
    // Wrapped signers don't require deployment
    return null
  }

  async decorateTransactions(
    bundle: commons.transaction.IntendedTransactionBundle
  ): Promise<commons.transaction.IntendedTransactionBundle> {
    return bundle
  }

  async requestSignature(
    _id: string,
    message: ethers.BytesLike,
    _metadata: Object,
    callbacks: {
      onSignature: (signature: ethers.BytesLike) => void
      onRejection: (error: string) => void
      onStatus: (situation: string) => void
    }
  ): Promise<boolean> {
    callbacks.onSignature(await this.signer.signMessage(message))
    return true
  }

  notifyStatusChange(_i: string, _s: Status, _m: Object): void {}

  suffix(): ethers.BytesLike {
    return [2]
  }
}
