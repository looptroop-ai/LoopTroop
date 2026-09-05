import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTempDir, removeTempDir } from '../../test/tempDir'
import {
  enrichGenericOpenCodeProviderError,
  findOpenCodeLogErrorDetails,
  LOOPTROOP_OPENCODE_LOG_DIR,
  readOpenCodeNativeLogs,
} from '../logDiagnostics'

const tempDirs: string[] = []

function makeLogDir() {
  const dir = makeTempDir('looptroop-opencode-logs-')
  tempDirs.push(dir)
  return dir
}

function writeLog(dir: string, content: string, name = '2026-05-22T151603.log') {
  writeFileSync(join(dir, name), content)
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    removeTempDir(dir)
  }
})

describe('OpenCode log diagnostics', () => {
  it('extracts Kilo low-credit provider details from generic session logs', () => {
    const dir = makeLogDir()
    writeLog(dir, [
      'ERROR 2026-05-22T15:45:45 +166301ms service=llm providerID=kilo modelID=kilo-auto/free session.id=ses-kilo small=false agent=build mode=primary error={"error":{"name":"AI_APICallError","url":"https://api.kilo.ai/api/gateway/chat/completions?api_key=sk-url-secret","requestBodyValues":{"model":"anthropic/claude-haiku-4.5","messages":[{"role":"user","content":"prompt must not leak"}]},"statusCode":402,"isRetryable":false,"data":{"error":{"message":"Add credits to continue, or switch to a free model"}},"responseBody":"{\\"error\\":{\\"title\\":\\"Low Credit Warning!\\",\\"message\\":\\"Add credits to continue, or switch to a free model\\",\\"balance\\":-0.463916,\\"buyCreditsUrl\\":\\"https://app.kilo.ai/profile\\"},\\"error_type\\":\\"usage_limit_exceeded\\"}"}}} stream error',
    ].join('\n'))

    const details = findOpenCodeLogErrorDetails('ses-kilo', { logDirs: [dir] })

    expect(details).toMatchObject({
      name: 'AI_APICallError',
      providerId: 'kilo',
      providerModelId: 'kilo-auto/free',
      requestModel: 'anthropic/claude-haiku-4.5',
      statusCode: 402,
      isRetryable: false,
      responseErrorType: 'usage_limit_exceeded',
      responseErrorTitle: 'Low Credit Warning!',
      responseErrorMessage: 'Add credits to continue, or switch to a free model',
    })
    const serialized = JSON.stringify(details)
    expect(serialized).not.toContain('prompt must not leak')
    expect(serialized).not.toContain('requestBodyValues')
    expect(serialized).not.toContain('sk-url-secret')
    expect(details?.url).toBe('https://api.kilo.ai/api/gateway/chat/completions')
  })

  it('extracts OpenAI deactivated workspace errors', () => {
    const dir = makeLogDir()
    writeLog(dir, 'ERROR 2026-05-22T15:57:47 +3ms service=llm providerID=openai modelID=gpt-5.2 session.id=ses-deactivated small=false agent=build mode=primary error={"error":{"name":"AI_APICallError","url":"https://api.openai.com/v1/responses","statusCode":402,"isRetryable":false,"responseBody":"{\\"detail\\":{\\"code\\":\\"deactivated_workspace\\"}}"}}}')

    expect(findOpenCodeLogErrorDetails('ses-deactivated', { logDirs: [dir] })).toMatchObject({
      providerId: 'openai',
      providerModelId: 'gpt-5.2',
      statusCode: 402,
      isRetryable: false,
      responseErrorMessage: 'deactivated_workspace',
    })
  })

  it('extracts OpenAI usage-limit retry details', () => {
    const dir = makeLogDir()
    writeLog(dir, 'ERROR 2026-05-22T16:45:14 +2847102ms service=llm providerID=openai modelID=gpt-5.2 session.id=ses-limit small=false agent=build mode=primary error={"error":{"name":"AI_APICallError","url":"https://api.openai.com/v1/responses","statusCode":429,"isRetryable":true,"data":{"error":{"message":"The usage limit has been reached","type":"usage_limit_reached"}},"responseBody":"{\\"error\\":{\\"type\\":\\"usage_limit_reached\\",\\"message\\":\\"The usage limit has been reached\\",\\"plan_type\\":\\"team\\"}}"}}}')

    expect(findOpenCodeLogErrorDetails('ses-limit', { logDirs: [dir] })).toMatchObject({
      statusCode: 429,
      isRetryable: true,
      responseErrorType: 'usage_limit_reached',
      responseErrorMessage: 'The usage limit has been reached',
    })
  })

  it('returns a troubleshooting hint when a generic provider error has no matching local log', () => {
    const enrichment = enrichGenericOpenCodeProviderError('Provider returned error', 'ses-missing', {
      logDirs: [join(makeLogDir(), 'missing')],
    })

    expect(enrichment).toMatchObject({
      source: 'troubleshooting_hint',
    })
    expect(enrichment?.message).toContain(LOOPTROOP_OPENCODE_LOG_DIR)
  })

  it('ignores generic-only log lines and oversized logs', () => {
    const dir = makeLogDir()
    writeLog(dir, 'ERROR service=llm providerID=openrouter modelID=openrouter/free session.id=ses-generic error={"error":"Provider returned error"} stream error')
    writeLog(dir, 'ERROR service=llm providerID=openai modelID=gpt-5.2 session.id=ses-oversized error={"error":{"statusCode":429}}', 'large.log')

    expect(findOpenCodeLogErrorDetails('ses-generic', { logDirs: [dir] })).toBeUndefined()
    expect(findOpenCodeLogErrorDetails('ses-oversized', {
      logDirs: [dir],
      maxBytesPerFile: 10,
    })).toBeUndefined()
  })
})

describe('readOpenCodeNativeLogs', () => {
  it('reads a quoted timestamp instead of choking on its quotes', () => {
    const dir = makeLogDir()
    writeLog(dir, 'time="2026-05-22T15:16:03.000Z" level=INFO service=session session.id=ses-1 msg="hello"\n')

    const entries = readOpenCodeNativeLogs(['ses-1'], { logDirs: [dir] })

    expect(entries).toHaveLength(1)
    expect(entries[0]?.timestamp).toBe('2026-05-22T15:16:03.000Z')
  })

  it('keeps a line whose timestamp cannot be parsed, with no timestamp at all', () => {
    const dir = makeLogDir()
    writeLog(dir, 'time="not-a-date" level=INFO session.id=ses-1 msg="still useful"\n')

    const entries = readOpenCodeNativeLogs(['ses-1'], { logDirs: [dir] })

    expect(entries).toHaveLength(1)
    // Substituting the current time would invent ordering data and float an old
    // event above newer ones in the merged view.
    expect(entries[0]?.timestamp).toBeNull()
    expect(entries[0]?.content).toContain('still useful')
  })

  it('keeps reading the file after a line it cannot use', () => {
    const dir = makeLogDir()
    writeLog(dir, [
      'time="not-a-date" level=INFO session.id=ses-1 msg="first"',
      'time="2026-05-22T15:16:04.000Z" level=INFO session.id=ses-1 msg="second"',
      '',
    ].join('\n'))

    // One unreadable line used to abort the rest of the file, and the merged
    // log channel answered 500.
    expect(readOpenCodeNativeLogs(['ses-1'], { logDirs: [dir] }).map((entry) => entry.content))
      .toEqual([expect.stringContaining('first'), expect.stringContaining('second')])
  })

  it('ignores lines belonging to another session', () => {
    const dir = makeLogDir()
    writeLog(dir, [
      'time="2026-05-22T15:16:03.000Z" session.id=ses-other msg="theirs"',
      'time="2026-05-22T15:16:04.000Z" session.id=ses-1 msg="ours"',
      '',
    ].join('\n'))

    expect(readOpenCodeNativeLogs(['ses-1'], { logDirs: [dir] })).toHaveLength(1)
  })
})
