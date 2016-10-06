/**
 * This implements the Ethereum Kernel
 * Kernels must implement two methods `codeHandler` and `callHandler` (and `linkHandler` for sharding)
 * The Kernel Contract handles the following
 * - Interprocess communications
 * - Intializing the VM and exposes ROM to it (codeHandler)
 * - Expose namespace which VM instance exists and Intializes the Environment (callHandler)
 * - Provides some built in contract (runTx, runBlock)
 * - Provides resource sharing and limiting via gas
 *
 *   All State should be stored in the Environment.
 *
 */

// The Kernel Exposes this Interface to VM instances it makes
const Interface = require('./interface.js')

// The Kernel Stores all of its state in the Environment. The Interface is used
// to by the VM to retrive infromation from the Environment.
const Environment = require('./environment.js')
const DebugInterface = require('./debugInterface.js')
const Address = require('./address.js')
const U256 = require('./u256.js')
const Utils = require('./utils.js')
const Transaction = require('./transaction.js')
const Precompile = require('./precompile.js')

const identityContract = new Address('0x0000000000000000000000000000000000000004')
const meteringContract = new Address('0x000000000000000000000000000000000000000A')
const transcompilerContract = new Address('0x000000000000000000000000000000000000000B')

module.exports = class Kernel {
  // runs some code in the VM
  constructor (environment = new Environment()) {
    this.environment = environment

    this.environment.addAccount(identityContract, {})
    this.environment.addAccount(meteringContract, {})
    this.environment.addAccount(transcompilerContract, {})
  }

  // handles running code.
  // NOTE: it assumes that wasm will raise an exception if something went wrong,
  //       otherwise execution succeeded
  codeHandler (code, ethInterface = new Interface(new Environment())) {
    const debugInterface = new DebugInterface(ethInterface.environment)
    const module = WebAssembly.Module(code)
    const imports = {
      'ethereum': ethInterface.exportTable,
      'debug': debugInterface.exportTable,

      // export this for Rust
      // FIXME: remove once Rust has proper imports, see https://github.com/ethereum/evm2.0-design/issues/15
      'spectest': ethInterface.exportTable,

      // export this for Binaryen
      // FIXME: remove once C has proper imports, see https://github.com/ethereum/evm2.0-design/issues/16
      'env': ethInterface.exportTable
    }
    // add shims
    imports.ethereum.useGas = ethInterface.shims.exports.useGas
    imports.ethereum.getGasLeft = ethInterface.shims.exports.getGasLeft
    imports.ethereum.call = ethInterface.shims.exports.call

    const instance = WebAssembly.Instance(module, imports)

    ethInterface.setModule(instance)
    debugInterface.setModule(instance)

    if (instance.exports.main) {
      instance.exports.main()
    }
    return instance
  }

  // loads code from the merkle trie and delegates the message
  // Detects if code is EVM or WASM
  // Detects if the code injection is needed
  // Detects if transcompilation is needed
  callHandler (call) {
    // FIXME: this is here until these two contracts are compiled to WASM
    // The two special contracts (precompiles now, but will be real ones later)
    if (call.to.equals(meteringContract)) {
      return Precompile.meteringInjector(call)
    } else if (call.to.equals(transcompilerContract)) {
      return Precompile.transcompiler(call)
    } else if (call.to.equals(identityContract)) {
      return Precompile.identity(call)
    }

    let account = this.environment.state.get(call.to.toString())
    if (!account) {
      throw new Error('Account not found: ' + call.to.toString())
    }

    let code = Uint8Array.from(account.get('code'))
    if (code.length === 0) {
      throw new Error('Contract not found')
    }

    if (!Utils.isWASMCode(code)) {
      // throw new Error('Not an eWASM contract')

      // Transcompile code
      // FIXME: decide if these are the right values here: from: 0, gasLimit: 0, value: 0
      code = this.callHandler({ from: Address.zero(), to: transcompilerContract, gasLimit: 0, value: new U256(0), data: code }).returnValue

      if (code[0] === 0) {
        code = code.slice(1)
      } else {
        throw new Error('Transcompilation failed: ' + Buffer.from(code).slice(1).toString())
      }
    }

    // creats a new Kernel
    const environment = new Environment()
    environment.parent = this

    // copy the transaction details
    environment.code = code
    environment.address = call.to
    // FIXME: make distinction between origin and caller
    environment.origin = call.from
    environment.caller = call.from
    environment.callData = call.data
    environment.callValue = call.value
    environment.gasLeft = call.gasLimit

    environment.callHandler = this.callHandler.bind(this)
    environment.createHandler = this.createHandler.bind(this)

    const kernel = new Kernel(environment)
    kernel.codeHandler(code, new Interface(environment))

    // self destructed
    if (environment.selfDestruct) {
      const balance = this.state.get(call.to.toString()).get('balance')
      const beneficiary = this.state.get(environment.selfDestructAddress)
      beneficiary.set('balance', beneficiary.get('balance').add(balance))
      this.state.delete(call.to.toString())
    }

    // generate new stateroot
    // this.environment.state.set(address, { stateRoot: stateRoot })
    return {
      executionOutcome: 1, // success
      gasLeft: new U256(environment.gasLeft),
      gasRefund: new U256(environment.gasRefund),
      returnValue: environment.returnValue,
      selfDestruct: environment.selfDestruct,
      selfDestructAddress: environment.selfDestructAddress,
      logs: environment.logs
    }
  }
}
