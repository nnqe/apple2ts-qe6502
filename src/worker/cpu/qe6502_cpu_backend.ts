import { BRK_ILLEGAL_6502, BRK_ILLEGAL_65C02, BRK_INSTR, type BreakpointMap } from "../../common/breakpoint"
import { BreakpointMap as BreakpointMapClass } from "../../common/breakpoint"
import { type CpuCoreName, Qe6502RockwellCpuCore } from "../../common/cpu_core_config"
import { MEMORY_BANKS } from "../../common/memorybanks"
import { getInstructionString } from "../../common/util_disassemble"
import { RUN_MODE, toHex } from "../../common/utility"
import { get6502Instructions, pcodes } from "../instructions"
import { memGet, memGetRaw, memSet, specialJumpTable } from "../memory"
import { SWITCHES } from "../softswitches"
import { CpuBackendId, type CpuBackend, type CpuStepResult, type TraceSink } from "./cpu_backend"

type Qe6502Cpu = {
  restart(): number
  jumpTo(address: number): number
  tick(input?: number): number
  busAddress(): number
  busData(): number
  busStatus(): number
  isOpcodeFetch(): boolean
  irqAssert(assertIrq: boolean): void
  nmiAssert(assertNmi: boolean): void
  save(): Uint8Array
  load(snapshot: Uint8Array): number
  pc(): number
  setPc(value: number): void
  s(): number
  setS(value: number): void
  a(): number
  setA(value: number): void
  x(): number
  setX(value: number): void
  y(): number
  setY(value: number): void
  p(): number
  setP(value: number): void
}

type Qe6502Runtime = {
  createCpu(cpuModel?: number): Qe6502Cpu
}

type Qe6502AdapterModule = {
  loadQe6502Browser(source: string): Promise<Qe6502Runtime>
  Model: {
    nmos: number
    rw: number
  }
}

type Qe6502PrivateSnapshot = {
  qe6502Snapshot?: number[]
}

type InstructionInfo = {
  instr: number
  vLo: number
  vHi: number
  code: PCodeInstr
}

const enum QeBreakpointResult {
  NoBreak,
  Break,
  HiddenBreak,
}

const Qe6502BackendId = 2 as CpuBackendId
const Qe6502WasmPublicPath = "qe6502/qe6502_js.wasm"
const Qe6502StatusWriting = 1
const InitialPStatus = 0x24
const InitialStackPtr = 0xff
const WaitSubroutineStart = 0xfca8
const WaitSubroutineEnd = 0xfcb3

let runOnlyModeRef: () => boolean = () => false
let doSetRunModeRef: (mode: RUN_MODE, doShowDebugTab?: boolean) => void = () => {}

void import("../motherboard").then(({ runOnlyMode, doSetRunMode }) => {
  runOnlyModeRef = runOnlyMode
  doSetRunModeRef = doSetRunMode
}).catch(error => {
  console.error("Failed to initialize qe6502 debugger controls", error)
})

const resolveQe6502WasmUrl = (): string => {
  if (typeof location === "undefined") {
    return `/${Qe6502WasmPublicPath}`
  }
  const currentUrl = new URL(location.href)
  if (currentUrl.pathname.includes("/assets/")) {
    return new URL(`../${Qe6502WasmPublicPath}`, currentUrl).toString()
  }
  return `/${Qe6502WasmPublicPath}`
}

const isQe6502PrivateSnapshot = (value: unknown): value is Qe6502PrivateSnapshot => {
  if (!value || typeof value !== "object") return false
  const snapshot = (value as Qe6502PrivateSnapshot).qe6502Snapshot
  return snapshot === undefined ||
    (Array.isArray(snapshot) && snapshot.length === 64 && snapshot.every(byte => Number.isInteger(byte)))
}

let memoryBankFunctionsReady = false

const fillInMemoryBankFunctions = (): void => {
  memoryBankFunctionsReady = true

  MEMORY_BANKS["MAIN"].enabled = (addr = 0) => {
    if (addr >= 0xd000) {
      return !SWITCHES.ALTZP.isSet && SWITCHES.BSRREADRAM.isSet
    } else if (addr >= 0x200) {
      return !SWITCHES.RAMRD.isSet
    }
    return !SWITCHES.ALTZP.isSet
  }

  MEMORY_BANKS["AUX"].enabled = (addr = 0) => {
    if (addr >= 0xd000) {
      return SWITCHES.ALTZP.isSet && SWITCHES.BSRREADRAM.isSet
    } else if (addr >= 0x200) {
      return SWITCHES.RAMRD.isSet
    }
    return SWITCHES.ALTZP.isSet
  }

  MEMORY_BANKS["ROM"].enabled = () => !SWITCHES.BSRREADRAM.isSet
  MEMORY_BANKS["MAIN-DXXX-1"].enabled = () => !SWITCHES.ALTZP.isSet && SWITCHES.BSRREADRAM.isSet && !SWITCHES.BSRBANK2.isSet
  MEMORY_BANKS["MAIN-DXXX-2"].enabled = () => !SWITCHES.ALTZP.isSet && SWITCHES.BSRREADRAM.isSet && SWITCHES.BSRBANK2.isSet
  MEMORY_BANKS["AUX-DXXX-1"].enabled = () => SWITCHES.ALTZP.isSet && SWITCHES.BSRREADRAM.isSet && !SWITCHES.BSRBANK2.isSet
  MEMORY_BANKS["AUX-DXXX-2"].enabled = () => SWITCHES.ALTZP.isSet && SWITCHES.BSRREADRAM.isSet && SWITCHES.BSRBANK2.isSet

  MEMORY_BANKS["CXXX-ROM"].enabled = (addr = 0) => {
    if (addr >= 0xc300 && addr <= 0xc3ff) {
      return SWITCHES.INTCXROM.isSet || !SWITCHES.SLOTC3ROM.isSet
    } else if (addr >= 0xc800) {
      return SWITCHES.INTCXROM.isSet || SWITCHES.INTC8ROM.isSet
    }
    return SWITCHES.INTCXROM.isSet
  }

  MEMORY_BANKS["CXXX-CARD"].enabled = (addr = 0) => {
    if (addr >= 0xc300 && addr <= 0xc3ff) {
      return SWITCHES.INTCXROM.isSet ? false : SWITCHES.SLOTC3ROM.isSet
    } else if (addr >= 0xc800) {
      return !SWITCHES.INTCXROM.isSet && !SWITCHES.INTC8ROM.isSet
    }
    return !SWITCHES.INTCXROM.isSet
  }
}

const checkMemoryBank = (bankKey: string, address: number): boolean => {
  if (!memoryBankFunctionsReady) fillInMemoryBankFunctions()
  const bank = MEMORY_BANKS[bankKey]
  if (!bank) return false
  if (address < bank.min || address > bank.max) return false
  if (bank.enabled && !bank.enabled(address)) return false
  return true
}

class Qe6502CpuBackend implements CpuBackend {
  readonly id = Qe6502BackendId

  private qeCpu: Qe6502Cpu | null = null
  private cycleCount = 0
  private irqMask = 0
  private nmiLine = false
  private breakpointMap: BreakpointMap = new BreakpointMapClass()
  private breakpointSkipOnce = false
  private watchpointBreak = false
  private hasWatchpoints = false
  private pendingSnapshot: CpuStateSnapshot | null = null
  private resetWhenReady = true
  private cycleCountCallbacks: Array<(userdata: number) => void> = []
  private cycleCountCallbackData: number[] = []

  stepInstruction: (trace?: TraceSink) => CpuStepResult = () => -1

  constructor(private readonly core: CpuCoreName) {
    void this.loadRuntime()
  }

  reset(): void {
    const cpu = this.qeCpu
    if (!cpu) {
      this.resetWhenReady = true
      return
    }
    cpu.restart()
    this.syncInterruptPins()
  }

  getStateSnapshot(): CpuStateSnapshot {
    const cpu = this.qeCpu
    const snapshot: CpuStateSnapshot = {
      backendId: this.id,
      cycleCount: this.cycleCount,
      PStatus: cpu ? cpu.p() : InitialPStatus,
      PC: cpu ? cpu.pc() : 0,
      Accum: cpu ? cpu.a() : 0,
      XReg: cpu ? cpu.x() : 0,
      YReg: cpu ? cpu.y() : 0,
      StackPtr: cpu ? cpu.s() : InitialStackPtr,
      flagIRQ: this.irqMask,
      flagNMI: this.nmiLine,
    }
    if (cpu) {
      snapshot.backendPrivate = { qe6502Snapshot: Array.from(cpu.save()) }
    }
    return snapshot
  }

  setStateSnapshot(snapshot: CpuStateSnapshot): void {
    this.cycleCount = snapshot.cycleCount
    this.irqMask = snapshot.flagIRQ & 0xff
    this.nmiLine = snapshot.flagNMI

    const cpu = this.qeCpu
    if (!cpu) {
      this.pendingSnapshot = snapshot
      this.resetWhenReady = false
      return
    }
    this.applySnapshotToCpu(cpu, snapshot)
  }

  getCycleCount(): number { return this.cycleCount }
  setCycleCount(value: number): void { this.cycleCount = value }

  getPStatus(): number { return this.qeCpu ? this.qeCpu.p() : InitialPStatus }
  setPStatus(value: number): void { this.qeCpu?.setP(value) }

  getPC(): number { return this.qeCpu ? this.qeCpu.pc() : 0 }
  setPC(value: number): void {
    const cpu = this.qeCpu
    if (cpu) cpu.jumpTo(value)
  }

  getA(): number { return this.qeCpu ? this.qeCpu.a() : 0 }
  setA(value: number): void { this.qeCpu?.setA(value) }

  getX(): number { return this.qeCpu ? this.qeCpu.x() : 0 }
  setX(value: number): void { this.qeCpu?.setX(value) }

  getY(): number { return this.qeCpu ? this.qeCpu.y() : 0 }
  setY(value: number): void { this.qeCpu?.setY(value) }

  getStackPtr(): number { return this.qeCpu ? this.qeCpu.s() : InitialStackPtr }
  setStackPtr(value: number): void { this.qeCpu?.setS(value) }

  getIrqMask(): number { return this.irqMask }
  setIrqMask(value: number): void {
    this.irqMask = value & 0xff
    this.qeCpu?.irqAssert(this.irqMask !== 0)
  }

  getNmiLine(): boolean { return this.nmiLine }
  setNmiLine(value: boolean): void {
    this.nmiLine = value
    this.qeCpu?.nmiAssert(value)
  }

  getCarry(): boolean { return (this.getPStatus() & 0x01) !== 0 }
  setCarry(value = true): void {
    const cpu = this.qeCpu
    if (!cpu) return
    cpu.setP(value ? cpu.p() | 0x01 : cpu.p() & 0xfe)
  }

  interruptRequest(slot = 0, set = true): void {
    if (set) {
      this.irqMask |= 1 << slot
    } else {
      this.irqMask &= ~(1 << slot)
    }
    this.irqMask &= 0xff
    this.qeCpu?.irqAssert(this.irqMask !== 0)
  }

  nonMaskableInterrupt(set = true): void {
    this.nmiLine = set
    this.qeCpu?.nmiAssert(set)
  }

  clearInterrupts(): void {
    this.irqMask = 0
    this.nmiLine = false
    this.syncInterruptPins()
  }

  registerCycleCountCallback(fn: (userdata: number) => void, userdata: number): void {
    this.cycleCountCallbacks.push(fn)
    this.cycleCountCallbackData.push(userdata)
  }

  getBreakpointMap(): BreakpointMap { return this.breakpointMap }

  setBreakpoints(bp: BreakpointMap): void {
    this.breakpointMap = bp
    this.hasWatchpoints = this.mapHasWatchpoints(bp)
  }

  setBreakpointSkipOnce(): void {
    this.breakpointSkipOnce = true
  }

  isWatchpoint(addr: number, value: number, set: boolean): boolean {
    if (!this.hasWatchpoints) return false
    const bp = this.breakpointMap.get(addr)
    if (!bp || !bp.watchpoint || bp.disabled) return false
    if (bp.hexvalue >= 0 && bp.hexvalue !== value) return false
    if (bp.memoryBank && !checkMemoryBank(bp.memoryBank, addr)) return false
    return set ? bp.memset : bp.memget
  }

  setWatchpointBreak(): void {
    this.watchpointBreak = true
  }

  setBasicStep(): void {}
  setStepOut(): void {}

  getStackString(): string {
    const stackPtr = this.getStackPtr()
    const values: string[] = []
    for (let i = 0xff; i > stackPtr && values.length < 16; i--) {
      values.push(`$${toHex(memGet(0x100 + i, false))}`)
    }
    return values.join(" ")
  }

  getStackDump(): string[] { return [] }
  setStackDump(): void {}

  get6502Instructions(): void { get6502Instructions() }
  getPCodeTable(): PCodeInstr[] { return pcodes }

  private async loadRuntime(): Promise<void> {
    try {
      const qe6502 = await import("../../qe6502/qe6502.js") as Qe6502AdapterModule
      const runtime = await qe6502.loadQe6502Browser(resolveQe6502WasmUrl())
      const model = this.core === Qe6502RockwellCpuCore ? qe6502.Model.rw : qe6502.Model.nmos
      const cpu = runtime.createCpu(model)
      this.qeCpu = cpu

      if (this.pendingSnapshot) {
        this.applySnapshotToCpu(cpu, this.pendingSnapshot)
        this.pendingSnapshot = null
      } else if (this.resetWhenReady) {
        cpu.restart()
        this.syncInterruptPins()
      }

      this.stepInstruction = this.runInstruction
    } catch (error) {
      console.error("Failed to initialize qe6502 backend", error)
    }
  }

  private applySnapshotToCpu(cpu: Qe6502Cpu, snapshot: CpuStateSnapshot): void {
    if (isQe6502PrivateSnapshot(snapshot.backendPrivate) && snapshot.backendPrivate.qe6502Snapshot) {
      cpu.load(Uint8Array.from(snapshot.backendPrivate.qe6502Snapshot))
    } else {
      cpu.setA(snapshot.Accum)
      cpu.setX(snapshot.XReg)
      cpu.setY(snapshot.YReg)
      cpu.setS(snapshot.StackPtr)
      cpu.setP(snapshot.PStatus)
      cpu.jumpTo(snapshot.PC)
    }
    this.syncInterruptPins()
  }

  private readonly runInstruction = (trace?: TraceSink): CpuStepResult => {
    const cpu = this.qeCpu as Qe6502Cpu
    const pc = cpu.pc()
    let instructionInfo: InstructionInfo | null = null

    const getInfo = (): InstructionInfo => {
      instructionInfo ??= this.readInstructionInfo(pc)
      return instructionInfo
    }

    if (!runOnlyModeRef()) {
      const bpResult = this.hitBreakpoint(pc, getInfo)
      if (bpResult === QeBreakpointResult.Break || bpResult === QeBreakpointResult.HiddenBreak) {
        doSetRunModeRef(RUN_MODE.PAUSED, bpResult !== QeBreakpointResult.HiddenBreak)
        return -1
      }
    }

    const fn = specialJumpTable.get(pc)
    if (fn && (!SWITCHES.INTCXROM.isSet || (pc & 0xf000) !== 0xc000)) {
      fn()
    }

    const shouldTrace = trace && (pc < WaitSubroutineStart || pc > WaitSubroutineEnd)
    if (shouldTrace) getInfo()

    let cycles = 0
    for (;;) {
      const status = cpu.busStatus()
      const addr = cpu.busAddress()
      if ((status & Qe6502StatusWriting) !== 0) {
        memSet(addr, cpu.busData())
        cpu.tick()
      } else {
        cpu.tick(memGet(addr))
      }
      cycles++
      if (cpu.isOpcodeFetch()) break
    }

    if (shouldTrace && instructionInfo) {
      this.emitTrace(trace, pc, instructionInfo)
    }

    this.cycleCount += cycles
    this.processCycleCountCallbacks()
    return cycles
  }

  private hitBreakpoint(pc: number, getInfo: () => InstructionInfo): QeBreakpointResult {
    if (this.watchpointBreak) {
      this.watchpointBreak = false
      return QeBreakpointResult.Break
    }

    if (this.breakpointSkipOnce) {
      this.breakpointSkipOnce = false
      return QeBreakpointResult.NoBreak
    }

    if (this.breakpointMap.size === 0) return QeBreakpointResult.NoBreak

    if (pc === 0xd805) {
      const lineNum = memGet(0x75, false) + (memGet(0x76, false) << 8)
      const bp = this.breakpointMap.get(lineNum)
      if (bp && !bp.disabled && !bp.watchpoint) {
        if (bp.once) this.breakpointMap.delete(lineNum)
        return QeBreakpointResult.HiddenBreak
      }
    }

    const pcBreakpoint = this.breakpointMap.get(pc)
    if (pcBreakpoint && this.breakpointMatches(pcBreakpoint, pc)) {
      return this.finishBreakpoint(pc, pcBreakpoint, pc)
    }

    const anyBreakpoint = this.breakpointMap.get(-1)
    if (anyBreakpoint && this.breakpointMatches(anyBreakpoint, pc)) {
      return this.finishBreakpoint(-1, anyBreakpoint, pc)
    }

    const info = getInfo()
    const instrBreakpointKey = info.instr | BRK_INSTR
    const instrBreakpoint = this.breakpointMap.get(instrBreakpointKey)
    if (instrBreakpoint && this.instructionBreakpointMatches(instrBreakpoint, info) && this.breakpointMatches(instrBreakpoint, pc)) {
      return this.finishBreakpoint(instrBreakpointKey, instrBreakpoint, pc)
    }

    const illegal65C02 = this.breakpointMap.get(BRK_ILLEGAL_65C02)
    if (illegal65C02 && info.code.name === "???" && this.breakpointMatches(illegal65C02, pc)) {
      return this.finishBreakpoint(BRK_ILLEGAL_65C02, illegal65C02, pc)
    }

    const illegal6502 = this.breakpointMap.get(BRK_ILLEGAL_6502)
    if (illegal6502 && !info.code.is6502 && this.breakpointMatches(illegal6502, pc)) {
      return this.finishBreakpoint(BRK_ILLEGAL_6502, illegal6502, pc)
    }

    return QeBreakpointResult.NoBreak
  }

  private breakpointMatches(bp: Breakpoint, pc: number): boolean {
    if (bp.disabled || bp.watchpoint) return false
    if (bp.expression1.register !== "" && !this.checkBreakpointExpression(bp)) return false
    if (bp.hitcount > 1) {
      bp.nhits++
      if (bp.nhits < bp.hitcount) return false
      bp.nhits = 0
    }
    if (bp.memoryBank && !checkMemoryBank(bp.memoryBank, pc)) return false
    return true
  }

  private instructionBreakpointMatches(bp: Breakpoint, info: InstructionInfo): boolean {
    if (!bp.instruction) return false
    if (bp.hexvalue < 0) return true
    const hexvalue = (info.vHi << 8) + info.vLo
    return hexvalue === bp.hexvalue
  }

  private finishBreakpoint(key: number, bp: Breakpoint, pc: number): QeBreakpointResult {
    if (bp.once) {
      this.breakpointMap.delete(key >= 0 && key < 0x10000 ? pc : key)
    }
    return bp.hidden ? QeBreakpointResult.HiddenBreak : QeBreakpointResult.Break
  }

  private checkBreakpointExpression(bp: Breakpoint): boolean {
    const passes1 = this.checkBreakpointSingleExpression(bp.expression1)
    if (bp.expressionOperator === "") return passes1
    if (bp.expressionOperator === "&&" && !passes1) return false
    if (bp.expressionOperator === "||" && passes1) return true
    return this.checkBreakpointSingleExpression(bp.expression2)
  }

  private checkBreakpointSingleExpression(expr: BreakpointExpression): boolean {
    let val = 0
    switch (expr.register) {
      case "$": val = memGetRaw(expr.address); break
      case "A": val = this.getA(); break
      case "X": val = this.getX(); break
      case "Y": val = this.getY(); break
      case "S": val = this.getStackPtr(); break
      case "P": val = this.getPStatus(); break
      case "C": val = this.getPC(); break
      default: return false
    }
    switch (expr.operator) {
      case "==": return val === expr.value
      case "!=": return val !== expr.value
      case "<": return val < expr.value
      case "<=": return val <= expr.value
      case ">": return val > expr.value
      case ">=": return val >= expr.value
    }
  }

  private readInstructionInfo(pc: number): InstructionInfo {
    const instr = memGet(pc, false)
    const code = pcodes[instr]
    const vLo = code.bytes > 1 ? memGet(pc + 1, false) : -1
    const vHi = code.bytes > 2 ? memGet(pc + 2, false) : 0
    return { instr, vLo, vHi, code }
  }

  private emitTrace(trace: TraceSink, pc: number, info: InstructionInfo): void {
    if (!trace) return
    const ins = getInstructionString(pc, info.code as PCodeInstr1, info.vLo, info.vHi, this.getPStatus()) + "          "
    const count = ("00000000" + this.cycleCount.toString()).slice(-8)
    let out = `${count}  ${ins.slice(0, 29)}  ${this.getProcessorStatus()}`
    let endsubroutine = out.indexOf("JMP")
    if (endsubroutine === -1) endsubroutine = out.indexOf("RTS")
    if (endsubroutine !== -1) {
      let tmp = out.slice(endsubroutine, endsubroutine + 15)
      tmp = tmp.replaceAll(" ", "_")
      out = out.slice(0, endsubroutine) + tmp + out.slice(endsubroutine + 15)
    }
    trace(out)
  }

  private getProcessorStatus(): string {
    const p = this.getPStatus()
    const pString =
      ((p & 0x80) ? "N" : ".") +
      ((p & 0x40) ? "V" : ".") +
      ((p & 0x10) ? "B" : ".") +
      ((p & 0x08) ? "D" : ".") +
      ((p & 0x04) ? "I" : ".") +
      ((p & 0x02) ? "Z" : ".") +
      ((p & 0x01) ? "C" : ".")

    return (
      `${toHex(this.getA())}  ` +
      `${toHex(this.getX())}  ` +
      `${toHex(this.getY())}  ` +
      `${toHex(this.getStackPtr())}  ` +
      `${toHex(p)}  ` +
      pString
    )
  }

  private mapHasWatchpoints(bp: BreakpointMap): boolean {
    for (const item of bp.values()) {
      if (item.watchpoint && !item.disabled) return true
    }
    return false
  }

  private processCycleCountCallbacks(): void {
    for (let i = 0; i < this.cycleCountCallbacks.length; i++) {
      this.cycleCountCallbacks[i](this.cycleCountCallbackData[i])
    }
  }

  private syncInterruptPins(): void {
    const cpu = this.qeCpu
    if (!cpu) return
    cpu.irqAssert(this.irqMask !== 0)
    cpu.nmiAssert(this.nmiLine)
  }
}

const qe6502CpuBackends = new Map<CpuCoreName, CpuBackend>()

export const getQe6502CpuBackend = (core: CpuCoreName): CpuBackend => {
  let backend = qe6502CpuBackends.get(core)
  if (!backend) {
    backend = new Qe6502CpuBackend(core)
    qe6502CpuBackends.set(core, backend)
  }
  return backend
}
