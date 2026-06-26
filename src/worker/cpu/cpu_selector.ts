import { getRequestedCpuCore, isQe6502CpuCore } from "../../common/cpu_core_config"
import type { CpuBackend } from "./cpu_backend"
import { builtInCpuBackend } from "./builtin_cpu_backend"
import { getQe6502CpuBackend } from "./qe6502_cpu_backend"

let activeCpu: CpuBackend | null = null

const getConfiguredCpuBackend = (): CpuBackend => {
  const core = getRequestedCpuCore()
  return isQe6502CpuCore(core) ? getQe6502CpuBackend(core) : builtInCpuBackend
}

export const getCpuBackend = (): CpuBackend => activeCpu ?? (activeCpu = getConfiguredCpuBackend())

export const setCpuBackend = (cpu: CpuBackend): void => {
  activeCpu = cpu
}
