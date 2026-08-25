/**
 * Dependency-free fallback for external builds where sandbox-runtime is not
 * installed. The shape intentionally follows the public sandbox-runtime API
 * used by sandbox-adapter.ts and the two violation UI consumers.
 */

export interface SandboxViolationEvent {
  line: string
  timestamp: Date
  command?: string
  encodedCommand?: string
}

export interface SandboxDependencyCheck {
  errors: string[]
  warnings: string[]
}

export function sanitizeViolationText(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim()
}

function encodeSandboxedCommand(command: string): string {
  const truncatedCommand = command.slice(0, 100)
  return Buffer.from(truncatedCommand).toString('base64')
}

export class SandboxViolationStore {
  private violations: SandboxViolationEvent[] = []
  private totalCount = 0
  private readonly maxSize = 100
  private readonly listeners = new Set<
    (violations: SandboxViolationEvent[]) => void
  >()

  addViolation(violation: SandboxViolationEvent): void {
    this.violations.push({
      ...violation,
      line: sanitizeViolationText(violation.line).replace(/[<>]/g, ''),
    })
    this.totalCount += 1
    if (this.violations.length > this.maxSize) {
      this.violations = this.violations.slice(-this.maxSize)
    }
    this.notifyListeners()
  }

  getViolations(limit?: number): SandboxViolationEvent[] {
    if (limit === undefined) {
      return [...this.violations]
    }
    if (limit <= 0) {
      return []
    }
    return this.violations.slice(-limit)
  }

  getCount(): number {
    return this.violations.length
  }

  getTotalCount(): number {
    return this.totalCount
  }

  getViolationsForCommand(command: string): SandboxViolationEvent[] {
    const commandBase64 = encodeSandboxedCommand(command)
    return this.violations.filter(
      violation => violation.encodedCommand === commandBase64,
    )
  }

  clear(): void {
    this.violations = []
    // Match the real store: clear removes the retained tail but preserves the
    // lifetime count used by the footer and expanded violation view.
    this.notifyListeners()
  }

  subscribe(
    listener: (violations: SandboxViolationEvent[]) => void,
  ): () => void {
    this.listeners.add(listener)
    listener(this.getViolations())
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      this.listeners.delete(listener)
    }
  }

  private notifyListeners(): void {
    const violations = this.getViolations()
    for (const listener of this.listeners) {
      listener(violations)
    }
  }
}

const sandboxViolationStore = new SandboxViolationStore()

export class SandboxManager {
  static create(..._args: unknown[]): SandboxManager {
    return new SandboxManager()
  }

  static isSupportedPlatform(): boolean {
    return false
  }

  static isSandboxingEnabled(): boolean {
    return false
  }

  static checkDependencies(
    ..._args: unknown[]
  ): SandboxDependencyCheck {
    return { errors: [], warnings: [] }
  }

  static wrapWithSandbox(
    command: string,
    ..._args: unknown[]
  ): Promise<string> {
    return Promise.resolve(command)
  }

  static initialize(..._args: unknown[]): Promise<void> {
    return Promise.resolve()
  }

  static updateConfig(..._args: unknown[]): void {}

  static reset(): Promise<void> {
    sandboxViolationStore.clear()
    return Promise.resolve()
  }

  static getFsReadConfig(): Record<string, never> {
    return {}
  }

  static getFsWriteConfig(): Record<string, never> {
    return {}
  }

  static getNetworkRestrictionConfig(): Record<string, never> {
    return {}
  }

  static getIgnoreViolations(): undefined {
    return undefined
  }

  static getAllowUnixSockets(): undefined {
    return undefined
  }

  static getAllowLocalBinding(): boolean {
    return false
  }

  static getEnableWeakerNestedSandbox(): boolean {
    return false
  }

  static getProxyPort(): undefined {
    return undefined
  }

  static getSocksProxyPort(): undefined {
    return undefined
  }

  static getLinuxHttpSocketPath(): undefined {
    return undefined
  }

  static getLinuxSocksSocketPath(): undefined {
    return undefined
  }

  static waitForNetworkInitialization(): Promise<boolean> {
    return Promise.resolve(false)
  }

  static getSandboxViolationStore(): SandboxViolationStore {
    return sandboxViolationStore
  }

  static annotateStderrWithSandboxFailures(
    _command: string,
    stderr: string,
  ): string {
    return stderr
  }

  static cleanupAfterCommand(): void {}

  dispose(): void {}
}

export const SandboxRuntimeConfigSchema = {
  parse(value: unknown): unknown {
    return value ?? {}
  },
  safeParse(value: unknown): { success: true; data: unknown } {
    return { success: true, data: value ?? {} }
  },
}
