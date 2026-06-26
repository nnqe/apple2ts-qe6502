export type CpuCoreName = "ct" | "qe" | "qe-rw"

export const BuiltInCpuCore: CpuCoreName = "ct"
export const Qe6502NmosCpuCore: CpuCoreName = "qe"
export const Qe6502RockwellCpuCore: CpuCoreName = "qe-rw"

const parseCoreValue = (value: string | null | undefined): CpuCoreName | null => {
  switch ((value ?? "").trim().toLowerCase()) {
    case BuiltInCpuCore:
      return BuiltInCpuCore
    case Qe6502NmosCpuCore:
      return Qe6502NmosCpuCore
    case Qe6502RockwellCpuCore:
      return Qe6502RockwellCpuCore
    default:
      return null
  }
}

const getConfiguredCore = (): string | undefined => process.env.apple2ts_cpu_core

export const getRequestedCpuCore = (): CpuCoreName => {
  return parseCoreValue(getConfiguredCore()) ?? BuiltInCpuCore
}

export const isQe6502CpuCore = (core: CpuCoreName = getRequestedCpuCore()): boolean => {
  return core === Qe6502NmosCpuCore || core === Qe6502RockwellCpuCore
}

export const getCpuCoreLabel = (core: CpuCoreName = getRequestedCpuCore()): string => {
  switch (core) {
    case Qe6502NmosCpuCore:
      return "QE NMOS"
    case Qe6502RockwellCpuCore:
      return "QE-RW 65C02"
    case BuiltInCpuCore:
    default:
      return "CT"
  }
}
