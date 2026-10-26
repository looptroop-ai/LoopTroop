import { MockOpenCodeAdapter } from '../opencode/adapter'

export class SequencedMockOpenCodeAdapter extends MockOpenCodeAdapter {
  private promptCounts = new Map<string, number>()

  override async promptSession(...args: Parameters<MockOpenCodeAdapter['promptSession']>) {
    const sessionId = args[0]
    const nextCount = (this.promptCounts.get(sessionId) ?? 0) + 1
    this.promptCounts.set(sessionId, nextCount)

    const queueNext = <T>(queue: Map<string, T>) => {
      const queued = queue.get(`${sessionId}#${nextCount}`)
      if (queued !== undefined) queue.set(sessionId, queued)
    }
    queueNext(this.mockResponses)
    queueNext(this.mockStreamEvents)
    queueNext(this.mockAssistantInfos)

    return await super.promptSession(...args)
  }
}

export class StructuredRetryTimeoutAdapter extends MockOpenCodeAdapter {
  private promptCount = 0

  constructor(
    private readonly firstResponse: string,
    private readonly timeoutOnPrompt = 2,
  ) {
    super()
  }

  override async promptSession(...args: Parameters<MockOpenCodeAdapter['promptSession']>): Promise<string> {
    this.promptCount += 1
    if (this.promptCount === this.timeoutOnPrompt) {
      this.promptCalls.push({ sessionId: args[0], parts: args[1], options: args[3] })
      throw new Error('Timeout')
    }
    this.mockResponses.set(args[0], this.firstResponse)
    return await super.promptSession(...args)
  }
}
