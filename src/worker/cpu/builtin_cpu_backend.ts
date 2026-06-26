import type { BreakpointMap } from "../../common/breakpoint"
import { breakpointMap, clearInterrupts, doSetBasicStep, doSetBreakpoints,
  doSetBreakpointSkipOnce, interruptRequest, isWatchpoint, nonMaskableInterrupt,
  processInstruction, registerCycleCountCallback, setStepOut,
  setWatchpointBreak } from "../cpu6502"
import { get6502Instructions, getStackDump, getStackString, pcodes,
  reset6502, s6502, setAccumulator, setCarry, setCycleCount, setPC,
  setStackDump, setState6502, setX, setY } from "../instructions"
import { CpuBackendId, type CpuBackend, type CpuStepResult, type TraceSink } from "./cpu_backend"

const builtInStateSnapshot = (): CpuStateSnapshot => ({
  backendId: CpuBackendId.BuiltIn6502,
  cycleCount: s6502.cycleCount,
  PStatus: s6502.PStatus,
  PC: s6502.PC,
  Accum: s6502.Accum,
  XReg: s6502.XReg,
  YReg: s6502.YReg,
  StackPtr: s6502.StackPtr,
  flagIRQ: s6502.flagIRQ,
  flagNMI: s6502.flagNMI,
})

const applySnapshot = (snapshot: CpuStateSnapshot): void => {
  setState6502({
    cycleCount: snapshot.cycleCount,
    PStatus: snapshot.PStatus,
    PC: snapshot.PC,
    Accum: snapshot.Accum,
    XReg: snapshot.XReg,
    YReg: snapshot.YReg,
    StackPtr: snapshot.StackPtr,
    flagIRQ: snapshot.flagIRQ,
    flagNMI: snapshot.flagNMI,
  })
}

export const builtInCpuBackend: CpuBackend = {
  id: CpuBackendId.BuiltIn6502,

  reset: () => reset6502(),
  stepInstruction: (trace: TraceSink = null): CpuStepResult => processInstruction(trace),

  getStateSnapshot: builtInStateSnapshot,
  setStateSnapshot: applySnapshot,

  getCycleCount: () => s6502.cycleCount,
  setCycleCount: (value: number) => setCycleCount(value),

  getPStatus: () => s6502.PStatus,
  setPStatus: (value: number) => { s6502.PStatus = value },

  getPC: () => s6502.PC,
  setPC: (value: number) => setPC(value),

  getA: () => s6502.Accum,
  setA: (value: number) => setAccumulator(value),

  getX: () => s6502.XReg,
  setX: (value: number) => setX(value),

  getY: () => s6502.YReg,
  setY: (value: number) => setY(value),

  getStackPtr: () => s6502.StackPtr,
  setStackPtr: (value: number) => { s6502.StackPtr = value },

  getIrqMask: () => s6502.flagIRQ,
  setIrqMask: (value: number) => { s6502.flagIRQ = value & 0xff },

  getNmiLine: () => s6502.flagNMI,
  setNmiLine: (value: boolean) => { s6502.flagNMI = value },

  getCarry: () => (s6502.PStatus & 0x01) !== 0,
  setCarry: (value = true) => setCarry(value),

  interruptRequest: (slot = 0, set = true) => interruptRequest(slot, set),
  nonMaskableInterrupt: (set = true) => nonMaskableInterrupt(set),
  clearInterrupts: () => clearInterrupts(),

  registerCycleCountCallback: (fn: (userdata: number) => void, userdata: number) => registerCycleCountCallback(fn, userdata),

  getBreakpointMap: () => breakpointMap,
  setBreakpoints: (bp: BreakpointMap) => doSetBreakpoints(bp),
  setBreakpointSkipOnce: () => doSetBreakpointSkipOnce(),

  isWatchpoint: (addr: number, value: number, set: boolean) => isWatchpoint(addr, value, set),
  setWatchpointBreak: () => setWatchpointBreak(),

  setBasicStep: () => doSetBasicStep(),
  setStepOut: () => setStepOut(),

  getStackString: () => getStackString(),
  getStackDump: () => getStackDump(),
  setStackDump: (dump: string[]) => setStackDump(dump),

  get6502Instructions: () => get6502Instructions(),
  getPCodeTable: () => pcodes,
}
