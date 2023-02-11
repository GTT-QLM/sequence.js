/* Autogenerated file. Do not edit manually. */
/* tslint:disable */
/* eslint-disable */
import type {
  BaseContract,
  BigNumberish,
  BytesLike,
  CallOverrides,
  ContractTransaction,
  Interface,
  PayableOverrides,
  PopulatedTransaction,
  Signer
} from 'ethers'
import type { FunctionFragment, Result, EventFragment } from 'ethers/abi'
import type { Provider } from 'ethers/providers'
import type { Listener } from 'ethers/utils'
import type { TypedEventFilter, TypedEvent, TypedListener, OnEvent, PromiseOrValue } from './common'

export interface UniversalDeployer2Interface extends Interface {
  functions: {
    'deploy(bytes,uint256)': FunctionFragment
  }

  getFunction(nameOrSignatureOrTopic: 'deploy'): FunctionFragment

  encodeFunctionData(functionFragment: 'deploy', values: [PromiseOrValue<BytesLike>, PromiseOrValue<BigNumberish>]): string

  decodeFunctionResult(functionFragment: 'deploy', data: BytesLike): Result

  events: {
    'Deploy(address)': EventFragment
  }

  getEvent(nameOrSignatureOrTopic: 'Deploy'): EventFragment
}

export interface DeployEventObject {
  _addr: string
}
export type DeployEvent = TypedEvent<any, DeployEventObject>

export type DeployEventFilter = TypedEventFilter<DeployEvent>

export interface UniversalDeployer2 extends BaseContract {
  connect(signerOrProvider: Signer | Provider | string): this
  attach(addressOrName: string): this
  deployed(): Promise<this>

  interface: UniversalDeployer2Interface

  queryFilter<TEvent extends TypedEvent>(
    event: TypedEventFilter<TEvent>,
    fromBlockOrBlockhash?: string | number | undefined,
    toBlock?: string | number | undefined
  ): Promise<Array<TEvent>>

  listeners<TEvent extends TypedEvent>(eventFilter?: TypedEventFilter<TEvent>): Array<TypedListener<TEvent>>
  listeners(eventName?: string): Array<Listener>
  removeAllListeners<TEvent extends TypedEvent>(eventFilter: TypedEventFilter<TEvent>): this
  removeAllListeners(eventName?: string): this
  off: OnEvent<this>
  on: OnEvent<this>
  once: OnEvent<this>
  removeListener: OnEvent<this>

  functions: {
    deploy(
      _creationCode: PromiseOrValue<BytesLike>,
      _instance: PromiseOrValue<BigNumberish>,
      overrides?: PayableOverrides & { from?: PromiseOrValue<string> }
    ): Promise<ContractTransaction>
  }

  deploy(
    _creationCode: PromiseOrValue<BytesLike>,
    _instance: PromiseOrValue<BigNumberish>,
    overrides?: PayableOverrides & { from?: PromiseOrValue<string> }
  ): Promise<ContractTransaction>

  callStatic: {
    deploy(
      _creationCode: PromiseOrValue<BytesLike>,
      _instance: PromiseOrValue<BigNumberish>,
      overrides?: CallOverrides
    ): Promise<void>
  }

  filters: {
    'Deploy(address)'(_addr?: null): DeployEventFilter
    Deploy(_addr?: null): DeployEventFilter
  }

  estimateGas: {
    deploy(
      _creationCode: PromiseOrValue<BytesLike>,
      _instance: PromiseOrValue<BigNumberish>,
      overrides?: PayableOverrides & { from?: PromiseOrValue<string> }
    ): Promise<bigint>
  }

  populateTransaction: {
    deploy(
      _creationCode: PromiseOrValue<BytesLike>,
      _instance: PromiseOrValue<BigNumberish>,
      overrides?: PayableOverrides & { from?: PromiseOrValue<string> }
    ): Promise<PopulatedTransaction>
  }
}
