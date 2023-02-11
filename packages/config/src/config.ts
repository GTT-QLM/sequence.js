import { AbstractSigner, keccak256, solidityPacked, dataSlice, zeroPadValue, AbiCoder, getAddress, BigNumberish } from 'ethers'
import { WalletContext } from '@0xsequence/network'
import { WalletContractBytecode } from './bytecode'
import { cacheConfig } from './cache'

// WalletConfig is the configuration of key signers that can access
// and control the wallet
export interface WalletConfig {
  threshold: number
  signers: {
    weight: number
    address: string
  }[]

  address?: string
  chainId?: number
}

export interface WalletState {
  context: WalletContext
  config?: WalletConfig

  // the wallet address
  address: string

  // the chainId of the network
  chainId: number

  // whether the wallet has been ever deployed
  deployed: boolean

  // the imageHash of the `config` WalletConfig
  imageHash: string

  // the last imageHash of a WalletConfig, stored on-chain
  lastImageHash?: string

  // whether the WalletConfig object itself has been published to logs
  published?: boolean
}

// TODO: createWalletConfig and genConfig are very similar, lets update + remove one
export const createWalletConfig = async (
  threshold: number,
  signers: { weight: number; signer: string | AbstractSigner }[]
): Promise<WalletConfig> => {
  const config: WalletConfig = {
    threshold,
    signers: []
  }
  signers.forEach(async s => {
    config.signers.push({
      weight: s.weight,
      address: AbstractSigner.isSigner(s.signer) ? await s.signer.getAddress() : s.signer
    })
  })
  if (!isUsableConfig(config)) {
    throw new Error('wallet config is not usable')
  }
  return config
}

// isUsableConfig checks if a the sum of the owners in the configuration meets the necessary threshold to sign a transaction
// a wallet that has a non-usable configuration is not able to perform any transactions, and can be considered as destroyed
export const isUsableConfig = (config: WalletConfig): boolean => {
  const sum = config.signers.reduce((p, c) => BigInt(c.weight) + p, 0n)
  return sum > BigInt(config.threshold)
}

export const isValidConfigSigners = (config: WalletConfig, signers: string[]): boolean => {
  if (signers.length === 0) return true
  const a = config.signers.map(s => getAddress(s.address))
  const b = signers.map(s => getAddress(s))
  let valid = true
  b.forEach(s => {
    if (!a.includes(s)) valid = false
  })
  return valid
}

export const addressOf = (salt: WalletConfig | string, context: WalletContext, ignoreAddress: boolean = false): string => {
  if (typeof salt === 'string') {
    const codeHash = keccak256(
      solidityPacked(['bytes', 'bytes32'], [WalletContractBytecode, zeroPadValue(context.mainModule, 32)])
    )

    const hash = keccak256(solidityPacked(['bytes1', 'address', 'bytes32', 'bytes32'], ['0xff', context.factory, salt, codeHash]))

    return getAddress(dataSlice(hash, 12))
  }

  if (salt.address && !ignoreAddress) return salt.address
  return addressOf(imageHash(salt), context)
}

export const imageHash = (config: WalletConfig): string => {
  config = sortConfig(config)

  const imageHash = config.signers.reduce(
    (imageHash, signer) =>
      keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint8', 'address'], [imageHash, signer.weight, signer.address])),
    solidityPacked(['uint256'], [config.threshold])
  )

  cacheConfig(imageHash, config)

  return imageHash
}

// sortConfig normalizes the list of signer addreses in a WalletConfig
export const sortConfig = (config: WalletConfig): WalletConfig => {
  config.signers.sort((a, b) => compareAddr(a.address, b.address))

  // normalize
  config.signers.forEach(s => (s.address = getAddress(s.address)))
  if (config.address) config.address = getAddress(config.address)

  // ensure no duplicate signers in the config
  const signers = config.signers.map(s => s.address)
  const signerDupes = signers.filter((c, i) => signers.indexOf(c) !== i)
  if (signerDupes.length > 0) {
    throw new Error('invalid wallet config: duplicate signer addresses detected in the config, ${signerDupes}')
  }

  return config
}

export const isConfigEqual = (a: WalletConfig, b: WalletConfig): boolean => {
  return imageHash(a) === imageHash(b)
}

export const compareAddr = (a: string, b: string): number => {
  const bigA = BigInt(a)
  const bigB = BigInt(b)

  if (bigA < bigB) {
    return -1
  } else if (bigA === bigB) {
    return 0
  } else {
    return 1
  }
}

export function editConfig(
  config: WalletConfig,
  args: {
    threshold?: BigNumberish
    set?: { weight: BigNumberish; address: string }[]
    del?: { address: string }[]
  }
): WalletConfig {
  const normSigner = (s: { weight: BigNumberish; address: string }) => ({
    weight: Number(s.weight),
    address: getAddress(s.address)
  })

  const normSrcSigners = config.signers.map(normSigner)

  const normSetSigners = args.set ? args.set.map(normSigner) : []
  const normDelAddress = args.del ? args.del.map(a => getAddress(a.address)) : []

  const normSetAddress = normSetSigners.map(s => s.address)

  const newSigners = normSrcSigners
    .filter(s => normDelAddress.indexOf(s.address) === -1 && normSetAddress.indexOf(s.address) === -1)
    .concat(...normSetSigners)

  return sortConfig({
    address: config.address,
    threshold: args.threshold ? Number(args.threshold) : config.threshold,
    signers: newSigners
  })
}

// TODO: very similar to createWalletConfig, but doesn't allow an AbstractSigner object
// TODO: lets also check isUsableConfig before returning it
export function genConfig(threshold: BigNumberish, signers: { weight: BigNumberish; address: string }[]): WalletConfig {
  return sortConfig({
    threshold: Number(threshold),
    signers: signers.map(s => ({ weight: Number(s.weight), address: getAddress(s.address) }))
  })
}
