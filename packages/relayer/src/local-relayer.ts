import { commons } from '@0xsequence/core'
import { logger } from '@0xsequence/utils'
import { Signer as AbstractSigner, BytesLike, providers } from 'ethers'

import { ProviderRelayer, ProviderRelayerOptions } from './provider-relayer'

import { FeeOption, FeeQuote, Relayer } from '.'

export type LocalRelayerOptions = Omit<ProviderRelayerOptions, 'provider'> & {
  signer: AbstractSigner
}

export function isLocalRelayerOptions(obj: any): obj is LocalRelayerOptions {
  return obj.signer !== undefined && AbstractSigner.isSigner(obj.signer)
}

export class LocalRelayer extends ProviderRelayer implements Relayer {
  private signer: AbstractSigner
  private txnOptions: providers.TransactionRequest

  constructor(options: LocalRelayerOptions | AbstractSigner) {
    super(AbstractSigner.isSigner(options) ? { provider: options.provider! } : { ...options, provider: options.signer.provider! })
    this.signer = AbstractSigner.isSigner(options) ? options : options.signer
    if (!this.signer.provider) throw new Error('Signer must have a provider')
  }

  async getFeeOptions(_address: string, ..._transactions: commons.transaction.Transaction[]): Promise<{ options: FeeOption[] }> {
    return { options: [] }
  }

  async getFeeOptionsRaw(
    _entrypoint: string,
    _data: BytesLike,
    _options?: {
      simulate?: boolean
    }
  ): Promise<{ options: FeeOption[] }> {
    return { options: [] }
  }

  async gasRefundOptions(address: string, ...transactions: commons.transaction.Transaction[]): Promise<FeeOption[]> {
    const { options } = await this.getFeeOptions(address, ...transactions)
    return options
  }

  setTransactionOptions(transactionRequest: providers.TransactionRequest) {
    this.txnOptions = transactionRequest
  }

  async relay(
    signedTxs: commons.transaction.IntendedTransactionBundle,
    quote?: FeeQuote,
    waitForReceipt: boolean = true
  ): Promise<commons.transaction.TransactionResponse<providers.TransactionReceipt>> {
    if (quote !== undefined) {
      logger.warn(`LocalRelayer doesn't accept fee quotes`)
    }

    const data = commons.transaction.encodeBundleExecData(signedTxs)

    // TODO: think about computing gas limit individually, summing together and passing across
    // NOTE: we expect that all txns have set their gasLimit ahead of time through proper estimation
    // const gasLimit = signedTxs.transactions.reduce((sum, tx) => sum.add(tx.gasLimit), ethers.BigNumber.from(0))
    // txRequest.gasLimit = gasLimit

    const responsePromise = this.signer.sendTransaction({
      to: signedTxs.entrypoint,
      data,
      ...this.txnOptions,
      gasLimit: 9000000
    })

    if (waitForReceipt) {
      const response: commons.transaction.TransactionResponse = await responsePromise
      response.receipt = await response.wait()
      return response
    } else {
      return responsePromise
    }
  }
}
