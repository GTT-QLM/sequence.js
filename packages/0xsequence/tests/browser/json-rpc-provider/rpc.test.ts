import { JsonRpcProvider, loggingProviderMiddleware } from '@0xsequence/network'
import { configureLogger } from '@0xsequence/utils'
import { ethers } from 'ethers'

import { assert, test } from '../../utils/assert'

configureLogger({ logLevel: 'DEBUG', silence: false })

export const tests = async () => {
  // const provider = new ethers.providers.JsonRpcProvider('http://localhost:8545', 31337)
  const provider = new JsonRpcProvider('http://localhost:8545', { chainId: 31337 })

  await test('sending a json-rpc request', async () => {
    {
      const network = await provider.getNetwork()
      console.log('network?', network)
    }
    {
      const chainId = await provider.send('eth_chainId', [])
      assert.true(ethers.BigNumber.from(chainId).toString() === '31337')
    }
    {
      const chainId = await provider.send('eth_chainId', [])
      assert.true(ethers.BigNumber.from(chainId).toString() === '31337')
    }
    {
      const chainId = await provider.send('eth_chainId', [])
      assert.true(ethers.BigNumber.from(chainId).toString() === '31337')
    }
    {
      const chainId = await provider.send('eth_chainId', [])
      assert.true(ethers.BigNumber.from(chainId).toString() === '31337')
    }
    {
      const netVersion = await provider.send('net_version', [])
      assert.true(netVersion === '31337')
    }
  })
}
