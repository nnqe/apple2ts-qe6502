module.exports = {
  Model: { nmos: 0, nes: 1, wdc: 2, rw: 3, st: 4 },
  loadQe6502Browser: async () => {
    throw new Error("qe6502 WASM backend is not loaded in Jest tests")
  },
}
