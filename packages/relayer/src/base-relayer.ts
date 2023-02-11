import { AbstractProvider, BigNumberish, Interface, Provider } from 'ethers'
import { walletContracts } from '@0xsequence/abi'
import { WalletContext } from '@0xsequence/network'
import { WalletConfig, addressOf, imageHash, DecodedSignature, encodeSignature } from '@0xsequence/config'
import { SignedTransactions, Transaction, sequenceTxAbiEncode, readSequenceNonce } from '@0xsequence/transactions'
import { isBigNumberish, Optionals } from '@0xsequence/utils'

export interface BaseRelayerOptions {
  bundleCreation?: boolean
  creationGasLimit?: BigNumberish
  provider?: Provider
}

export function isBaseRelayerOptions(obj: any): obj is BaseRelayerOptions {
  return (
    (obj.bundleCreation !== undefined && typeof obj.bundleCreation === 'boolean') ||
    (obj.creationGasLimit !== undefined && isBigNumberish(obj.creationGasLimit)) ||
    (obj.provider !== undefined && (obj.provider instanceof AbstractProvider || typeof obj.provider === 'string'))
  )
}

export const BaseRelayerDefaults: Omit<Required<Optionals<BaseRelayerOptions>>, 'provider'> = {
  bundleCreation: true,
  creationGasLimit: 2n ** 17n
}

export class BaseRelayer {
  readonly provider: Provider | undefined
  public readonly bundleCreation: boolean
  public creationGasLimit: bigint

  constructor(options?: BaseRelayerOptions) {
    const opts = { ...BaseRelayerDefaults, ...options }
    this.bundleCreation = opts.bundleCreation
    this.provider = opts.provider
    this.creationGasLimit = BigInt(opts.creationGasLimit)
  }

  async isWalletDeployed(walletAddress: string): Promise<boolean> {
    if (!this.provider) throw new Error('Bundled creation provider not found')
    return (await this.provider.getCode(walletAddress)) !== '0x'
  }

  prepareWalletDeploy(config: WalletConfig, context: WalletContext): { to: string; data: string } {
    const factoryInterface = new Interface(walletContracts.factory.abi)

    return {
      to: context.factory,
      data: factoryInterface.encodeFunctionData(factoryInterface.getFunction('deploy'), [context.mainModule, imageHash(config)])
    }
  }

  async prependWalletDeploy(
    signedTransactions: Pick<SignedTransactions, 'config' | 'context' | 'transactions' | 'nonce' | 'signature'>
  ): Promise<{ to: string; execute: { transactions: Transaction[]; nonce: bigint; signature: string } }> {
    const { config, context, transactions, nonce, signature } = signedTransactions
    const walletAddress = addressOf(config, context)
    const walletInterface = new Interface(walletContracts.mainModule.abi)

    const encodedSignature = (async () => {
      const sig = await signature

      if (typeof sig === 'string') return sig
      return encodeSignature(sig)
    })()

    if (this.bundleCreation && !(await this.isWalletDeployed(walletAddress))) {
      return {
        to: context.guestModule!,
        execute: {
          transactions: [
            {
              ...this.prepareWalletDeploy(config, context),
              delegateCall: false,
              revertOnError: false,
              gasLimit: this.creationGasLimit,
              value: 0n
            },
            {
              delegateCall: false,
              revertOnError: true,
              gasLimit: 0n,
              to: walletAddress,
              value: 0n,
              data: walletInterface.encodeFunctionData(walletInterface.getFunction('execute'), [
                sequenceTxAbiEncode(transactions),
                nonce,
                await encodedSignature
              ])
            }
          ],
          nonce: 0n,
          signature: '0x'
        }
      }
    } else {
      return {
        to: walletAddress,
        execute: {
          transactions,
          nonce: BigInt(nonce),
          signature: await encodedSignature
        }
      }
    }
  }

  async prepareTransactions(
    config: WalletConfig,
    context: WalletContext,
    signature: string | Promise<string> | DecodedSignature | Promise<DecodedSignature>,
    ...transactions: Transaction[]
  ): Promise<{ to: string; data: string }> {
    //, gasLimit?: BigNumberish }> {
    const nonce = readSequenceNonce(...transactions)
    if (!nonce) {
      throw new Error('Unable to prepare transactions without a defined nonce')
    }
    const { to, execute } = await this.prependWalletDeploy({ config, context, transactions, nonce, signature })
    const walletInterface = new Interface(walletContracts.mainModule.abi)
    return {
      to,
      data: walletInterface.encodeFunctionData(walletInterface.getFunction('execute'), [
        sequenceTxAbiEncode(execute.transactions),
        execute.nonce,
        execute.signature
      ])
    }
  }
}
