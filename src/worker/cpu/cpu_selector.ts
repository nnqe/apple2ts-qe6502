import type { CpuBackend } from "./cpu_backend"
import { builtInCpuBackend } from "./builtin_cpu_backend"

let activeCpu: CpuBackend | null = null

export const getCpuBackend = (): CpuBackend => activeCpu ?? builtInCpuBackend

export const setCpuBackend = (cpu: CpuBackend): void => {
  activeCpu = cpu
}
