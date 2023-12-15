import { JsonRpcHandlerFunc, JsonRpcMiddleware, JsonRpcRequest, JsonRpcResponseCallback } from '@0xsequence/network'

import { Multicall, MulticallOptions } from '../multicall'

export const multicallMiddleware =
  (multicall?: Multicall | Partial<MulticallOptions>): JsonRpcMiddleware =>
  (next: JsonRpcHandlerFunc) => {
    const lib = Multicall.isMulticall(multicall) ? multicall : new Multicall(multicall!)
    return (request: JsonRpcRequest, callback: JsonRpcResponseCallback) => {
      return lib.handle(next, request, callback)
    }
  }
