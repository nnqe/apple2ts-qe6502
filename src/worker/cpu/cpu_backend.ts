import type { BreakpointMap } from "../../common/breakpoint"

export const enum CpuBackendId {
  BuiltIn6502 = 1,
}

export type TraceSink = ((str: string) => void) | null

export type CpuStepResult = number

export interface CpuBackend {
  readonly id: CpuBackendId

  reset(): void
  stepInstruction(trace?: TraceSink): CpuStepResult

  getStateSnapshot(): CpuStateSnapshot
  setStateSnapshot(snapshot: CpuStateSnapshot): void

  getCycleCount(): number
  setCycleCount(value: number): void

  getPStatus(): number
  setPStatus(value: number): void

  getPC(): number
  setPC(value: number): void

  getA(): number
  setA(value: number): void

  getX(): number
  setX(value: number): void

  getY(): number
  setY(value: number): void

  getStackPtr(): number
  setStackPtr(value: number): void

  getIrqMask(): number
  setIrqMask(value: number): void

  getNmiLine(): boolean
  setNmiLine(value: boolean): void

  getCarry(): boolean
  setCarry(value?: boolean): void

  interruptRequest(slot?: number, set?: boolean): void
  nonMaskableInterrupt(set?: boolean): void
  clearInterrupts(): void

  registerCycleCountCallback(
    fn: (userdata: number) => void,
    userdata: number,
  ): void

  getBreakpointMap(): BreakpointMap
  setBreakpoints(bp: BreakpointMap): void
  setBreakpointSkipOnce(): void

  isWatchpoint(addr: number, value: number, set: boolean): boolean
  setWatchpointBreak(): void

  setBasicStep(): void
  setStepOut(): void

  getStackString(): string
  getStackDump(): string[]
  setStackDump(dump: string[]): void

  get6502Instructions(): void
  getPCodeTable(): PCodeInstr[]
}
