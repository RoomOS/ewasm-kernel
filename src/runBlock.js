// run block; the block message handler
module.exports = (block, environment = new Environment()) => {
  // verify block then run each tx
  block.tx.forEach((tx) => {
    this.runTx(tx, environment)
  })
}
