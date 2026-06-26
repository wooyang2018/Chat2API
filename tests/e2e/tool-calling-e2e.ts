/**
 * End-to-End Tool Calling Test — MiniMax only
 *
 * This script:
 * 1. Opens a browser window (like the app's InAppLoginManager) to collect MiniMax token
 * 2. Tests MiniMax tool calling (non-stream + stream)
 *
 * Token is cached in tests/e2e/.minimax-token-cache.json (6h TTL).
 * Use --refresh to force re-collecting the token via browser login.
 *
 * Usage: node --experimental-strip-types tests/e2e/tool-calling-e2e.ts [--refresh]
 */

import { chromium } from 'playwright'
import axios from 'axios'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { ToolCallingEngine } from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import { ToolStreamParser } from '../../src/main/proxy/toolCalling/ToolStreamParser.ts'
import { getToolProtocol } from '../../src/main/proxy/toolCalling/protocols/index.ts'
import type { Provider } from '../../src/main/store/types.ts'

// ─── Token Cache ─────────────────────────────────────────────

const CACHE_FILE = path.join(import.meta.dirname, '.minimax-token-cache.json')
const CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6 hours (JWT tokens typically last longer)

interface CachedToken {
  jwtToken: string
  realUserID: string
  savedAt: number
}

function loadCachedToken(): { jwtToken: string; realUserID: string } | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null
    const raw = fs.readFileSync(CACHE_FILE, 'utf-8')
    const cached: CachedToken = JSON.parse(raw)
    if (Date.now() - cached.savedAt > CACHE_TTL_MS) {
      console.log('[Cache] Token cache expired, will re-collect.')
      return null
    }
    console.log('[Cache] Using cached MiniMax token (saved at', new Date(cached.savedAt).toLocaleString(), ')')
    return { jwtToken: cached.jwtToken, realUserID: cached.realUserID }
  } catch {
    return null
  }
}

function saveCachedToken(jwtToken: string, realUserID: string): void {
  const data: CachedToken = { jwtToken, realUserID, savedAt: Date.now() }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf-8')
  console.log('[Cache] Token saved to', CACHE_FILE)
}

// ─── Utilities ──────────────────────────────────────────────

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function md5(str: string): string {
  return crypto.createHash('md5').update(str).digest('hex')
}

function unixTimestamp(): number {
  return Math.floor(Date.now() / 1000)
}

// ─── Test Tools Definition ──────────────────────────────────

const TEST_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'get_weather',
      description: 'Get the current weather for a given city',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'The city name' },
        },
        required: ['city'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'calculate',
      description: 'Perform a mathematical calculation',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'The math expression to evaluate' },
        },
        required: ['expression'],
      },
    },
  },
]

const PROVIDER_MINIMAX: Provider = {
  id: 'minimax',
  name: 'MiniMax',
  type: 'builtin',
  authType: 'jwt',
  apiEndpoint: 'https://agent.minimaxi.com',
  headers: {},
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
} as Provider

// ─── Token Collection via Playwright ────────────────────────

function waitForUserEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(prompt, () => {
      rl.close()
      resolve()
    })
  })
}

async function collectMinimaxToken(): Promise<{ jwtToken: string; realUserID: string }> {
  console.log('\n========== MiniMax Token Collection ==========')
  console.log('Opening browser for MiniMax login...')

  const browser = await chromium.launch({ headless: false })
  const context = await browser.newContext()
  const page = await context.newPage()

  await page.goto('https://agent.minimaxi.com')

  await waitForUserEnter(
    '\n>>> Please log in to MiniMax (agent.minimaxi.com) in the browser window.\n' +
    '>>> After you are fully logged in and see the chat interface, press Enter here to collect the token...\n> '
  )

  // Collect _token (JWT) from localStorage
  const jwtToken = await page.evaluate(() => localStorage.getItem('_token') || '')

  let realUserID = ''
  // Try to get realUserID from user_detail_agent
  const userDetail = await page.evaluate(() => localStorage.getItem('user_detail_agent') || '')
  if (userDetail) {
    try {
      const parsed = JSON.parse(userDetail)
      realUserID = String(parsed.realUserID || parsed.id || '')
    } catch {
      // ignore
    }
  }
  // If no realUserID from user_detail_agent, extract from JWT
  if (!realUserID && jwtToken) {
    try {
      const parts = jwtToken.split('.')
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
      realUserID = payload?.user?.id || payload?.sub || ''
    } catch {
      // ignore
    }
  }

  await browser.close()

  if (!jwtToken || jwtToken.length < 20) {
    throw new Error('Failed to collect MiniMax token: _token not found in localStorage after login')
  }

  console.log('>>> MiniMax token collected!')
  return { jwtToken, realUserID }
}

// ─── MiniMax API Helpers ─────────────────────────────────────

const MINIMAX_BASE = 'https://agent.minimaxi.com'

const MINIMAX_FAKE_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Cache-Control': 'no-cache',
  Origin: MINIMAX_BASE,
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
}

const MINIMAX_USER_DATA: Record<string, any> = {
  device_platform: 'web',
  biz_id: '3',
  app_id: '3001',
  version_code: '22201',
  os_name: 'Mac',
  browser_name: 'chrome',
  device_memory: 8,
  cpu_core_num: 11,
  browser_language: 'zh-CN',
  browser_platform: 'MacIntel',
  screen_width: 1920,
  screen_height: 1080,
  lang: 'zh',
  timezone_offset: 28800,
  sys_language: 'zh',
  client: 'web',
}

function buildMinimaxRequestConfig(
  uri: string,
  body: any,
  jwtToken: string,
  realUserID: string,
  deviceId: string
) {
  const timestamp = unixTimestamp()
  const unix = `${Date.now()}`

  const userData: Record<string, any> = {
    ...MINIMAX_USER_DATA,
    uuid: realUserID,
    device_id: deviceId,
    user_id: realUserID,
    unix,
    token: jwtToken,
  }

  let queryStr = ''
  for (const key in userData) {
    if (userData[key] === undefined) continue
    queryStr += `&${key}=${userData[key]}`
  }
  queryStr = queryStr.substring(1)

  const fullUri = `${uri}?${queryStr}`
  const dataJson = JSON.stringify(body)
  const yy = md5(`${encodeURIComponent(fullUri)}_${dataJson}${md5(unix)}ooui`)
  const signature = md5(`${timestamp}${jwtToken}${dataJson}`)

  return {
    url: `${MINIMAX_BASE}${fullUri}`,
    headers: {
      Referer: `${MINIMAX_BASE}/`,
      token: jwtToken,
      ...MINIMAX_FAKE_HEADERS,
      'Content-Type': 'application/json',
      'x-timestamp': String(timestamp),
      'x-signature': signature,
      yy: yy,
    },
  }
}

async function minimaxRequestDeviceInfo(
  jwtToken: string,
  realUserID: string
): Promise<{ deviceId: string; userId: string; realUserID: string; jwtToken: string }> {
  const body = {}
  const config = buildMinimaxRequestConfig(
    '/v1/api/user/device/register',
    body,
    jwtToken,
    realUserID,
    ''
  )

  const response = await axios.request({
    method: 'POST',
    url: config.url,
    data: body,
    timeout: 15000,
    validateStatus: () => true,
    headers: config.headers,
  })

  console.log('[MiniMax] Device register response status:', response.status)
  console.log('[MiniMax] Device register response:', JSON.stringify(response.data, null, 2))

  if (response.status !== 200 || response.data?.statusInfo?.code !== 0) {
    throw new Error(`MiniMax device register failed: ${response.status} ${JSON.stringify(response.data)}`)
  }

  const deviceId = response.data?.data?.deviceID || response.data?.data?.deviceId || uuid()
  console.log('[MiniMax] Device info acquired, deviceId:', deviceId)
  return { deviceId, userId: realUserID, realUserID, jwtToken }
}

async function minimaxSendMessage(
  deviceInfo: any,
  text: string
): Promise<{ chatId: string; msgId: string }> {
  const body = {
    msg_type: 1,
    text,
    chat_type: 1,
    attachments: [],
    selected_mcp_tools: [],
    backend_config: {},
    sub_agent_ids: [],
  }

  const config = buildMinimaxRequestConfig(
    '/matrix/api/v1/chat/send_msg',
    body,
    deviceInfo.jwtToken,
    deviceInfo.realUserID,
    deviceInfo.deviceId
  )

  const response = await axios.request({
    method: 'POST',
    url: config.url,
    data: body,
    timeout: 30000,
    validateStatus: () => true,
    headers: config.headers,
  })

  console.log('[MiniMax] Send msg response status:', response.status)

  if (response.status !== 200 || response.data?.base_resp?.status_code !== 0) {
    throw new Error(`MiniMax send_msg failed: ${response.status} ${JSON.stringify(response.data)}`)
  }

  const chatId = response.data.chat_id
  const msgId = response.data.msg_id
  console.log(`[MiniMax] Message sent, chat_id: ${chatId}, msg_id: ${msgId}`)
  return { chatId, msgId }
}

async function minimaxPollForResponse(
  deviceInfo: any,
  chatId: string,
  maxPolls = 120,
  pollInterval = 1000
): Promise<string> {
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, pollInterval))

    const body = { chat_id: chatId }
    const config = buildMinimaxRequestConfig(
      '/matrix/api/v1/chat/get_chat_detail',
      body,
      deviceInfo.jwtToken,
      deviceInfo.realUserID,
      deviceInfo.deviceId
    )

    let response
    try {
      response = await axios.request({
        method: 'POST',
        url: config.url,
        data: body,
        timeout: 15000,
        validateStatus: () => true,
        headers: config.headers,
      })
    } catch (err) {
      console.log(`  [poll ${i + 1}] Request error: ${err instanceof Error ? err.message : err}`)
      continue
    }

    if (response.status !== 200) {
      console.log(`  [poll ${i + 1}] HTTP ${response.status}`)
      continue
    }

    // MiniMax get_chat_detail returns: { base_resp: { status_code }, messages: [...] }
    const responseData = response.data
    const baseResp = responseData?.base_resp
    const messages = responseData?.messages

    // Debug: log response structure on first few polls and when messages appear
    if (i < 3 || (messages && messages.length > 0)) {
      console.log(`  [poll ${i + 1}] base_resp:`, JSON.stringify(baseResp))
      console.log(`  [poll ${i + 1}] top-level keys:`, responseData ? Object.keys(responseData) : 'null')
      if (messages) {
        console.log(`  [poll ${i + 1}] messages count: ${messages.length}`)
        for (const msg of messages) {
          console.log(`    msg_type=${msg.msg_type}, content_len=${msg.msg_content?.length || 0}, finish_time=${msg.finish_time || 'none'}`)
          if (msg.msg_content) {
            console.log(`    content preview: ${String(msg.msg_content).substring(0, 100)}`)
          }
        }
      } else {
        const rawStr = typeof responseData === 'string' ? responseData : JSON.stringify(responseData)
        console.log(`  [poll ${i + 1}] No messages field. Raw:`, rawStr ? rawStr.substring(0, 300) : 'empty')
      }
    }

    if (baseResp?.status_code !== 0) {
      if (i < 5) console.log(`  [poll ${i + 1}] base_resp.status_code: ${baseResp?.status_code}`)
      continue
    }

    if (!messages) continue

    const aiMessage = messages.find((msg: any) => msg.msg_type === 2)
    if (aiMessage && aiMessage.msg_content) {
      // Check if the message is complete (has finish_time or is not still generating)
      const isComplete = aiMessage.finish_time || aiMessage.status === 'finished' || !aiMessage.generating
      if (isComplete) {
        console.log(`[MiniMax] AI response received after ${i + 1} polls`)
        return aiMessage.msg_content
      }
      // Still generating, keep polling but log progress
      console.log(`  [poll ${i + 1}] AI message still generating...`)
    }
  }

  throw new Error(`MiniMax: No AI response after ${maxPolls} polls`)
}

// ─── Test Result Type ────────────────────────────────────────

interface TestResult {
  name: string
  passed: boolean
  details: string
  toolCallsFound?: number
  rawContentPreview?: string
}

const results: TestResult[] = []

function recordResult(r: TestResult) {
  results.push(r)
  const status = r.passed ? 'PASS' : 'FAIL'
  console.log(`\n  [${status}] ${r.name}`)
  if (r.details) console.log(`  ${r.details}`)
  if (r.toolCallsFound !== undefined) console.log(`  Tool calls found: ${r.toolCallsFound}`)
}

// ─── MiniMax Tests ──────────────────────────────────────────

async function testMinimaxNonStream(jwtToken: string, realUserID: string) {
  console.log('\n===== MiniMax Non-Stream Tool Calling Test =====')

  try {
    // 1. Get device info
    const deviceInfo = await minimaxRequestDeviceInfo(jwtToken, realUserID)

    // 2. Transform request with ToolCallingEngine
    const engine = new ToolCallingEngine()
    const request = {
      model: 'MiniMax-M2.7',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What is the weather in Tokyo? Use the get_weather tool.' },
      ],
      tools: TEST_TOOLS,
    }

    const transformed = engine.transformRequest({
      request: request as any,
      provider: PROVIDER_MINIMAX,
      actualModel: 'MiniMax-M2.7',
    })

    console.log(`  Plan: mode=${transformed.plan.mode}, protocol=${transformed.plan.protocol}, inject=${transformed.plan.shouldInjectPrompt}`)

    // 3. Build the text to send (all messages combined)
    const allText = transformed.messages
      .map((m: any) => {
        if (typeof m.content === 'string') return m.content
        if (Array.isArray(m.content)) {
          return m.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
        }
        return ''
      })
      .join('\n')

    console.log(`  Text to send (${allText.length} chars), preview: ${allText.substring(0, 200)}...`)

    // 4. Send message and poll for response
    const { chatId } = await minimaxSendMessage(deviceInfo, allText)
    const responseContent = await minimaxPollForResponse(deviceInfo, chatId)

    console.log('\n  --- MiniMax Raw Response (first 500 chars) ---')
    console.log('  ' + responseContent.substring(0, 500))

    // 5. Parse with managedXmlProtocol
    const protocol = getToolProtocol(transformed.plan.protocol)
    const parseResult = protocol.parse(responseContent, {
      tools: transformed.plan.tools,
      protocol: transformed.plan.protocol,
    })

    console.log(`  Parsed: toolCalls=${parseResult.toolCalls.length}, protocol=${parseResult.protocol}`)
    console.log(`  Clean content: ${parseResult.content?.substring(0, 200)}`)

    // 6. Validate
    const passed = parseResult.toolCalls.length > 0
    recordResult({
      name: 'MiniMax Non-Stream Tool Calling',
      passed,
      details: passed
        ? `Found ${parseResult.toolCalls.length} tool call(s): ${parseResult.toolCalls.map((tc: any) => tc.function.name).join(', ')}`
        : 'No tool calls found in response',
      toolCallsFound: parseResult.toolCalls.length,
      rawContentPreview: responseContent.substring(0, 200),
    })

    for (const tc of parseResult.toolCalls) {
      console.log(`    → tool: ${tc.function.name}, args: ${tc.function.arguments}`)
    }
  } catch (error) {
    recordResult({
      name: 'MiniMax Non-Stream Tool Calling',
      passed: false,
      details: `Error: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

async function testMinimaxStream(jwtToken: string, realUserID: string) {
  console.log('\n===== MiniMax Stream Tool Calling Test =====')

  try {
    const deviceInfo = await minimaxRequestDeviceInfo(jwtToken, realUserID)

    const engine = new ToolCallingEngine()
    const request = {
      model: 'MiniMax-M2.7',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Calculate 123 * 456 using the calculate tool.' },
      ],
      tools: TEST_TOOLS,
    }

    const transformed = engine.transformRequest({
      request: request as any,
      provider: PROVIDER_MINIMAX,
      actualModel: 'MiniMax-M2.7',
    })

    const allText = transformed.messages
      .map((m: any) => {
        if (typeof m.content === 'string') return m.content
        if (Array.isArray(m.content)) {
          return m.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
        }
        return ''
      })
      .join('\n')

    // Send message
    const { chatId } = await minimaxSendMessage(deviceInfo, allText)

    // Simulate streaming by polling with incremental content extraction
    const toolStreamParser = new ToolStreamParser(transformed.plan)
    const baseChunk = {
      id: 'chatcmpl-minimax-stream',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'MiniMax-M2.7',
    }

    let lastContent = ''
    let emittedToolCalls: any[] = []
    let emittedContent = ''
    let pollCount = 0
    const maxPolls = 120
    const pollInterval = 1000

    // Poll repeatedly and emit increments (simulating the adapter's createPollingStream)
    while (pollCount < maxPolls) {
      await new Promise((r) => setTimeout(r, pollInterval))
      pollCount++

      const body = { chat_id: chatId }
      const config = buildMinimaxRequestConfig(
        '/matrix/api/v1/chat/get_chat_detail',
        body,
        deviceInfo.jwtToken,
        deviceInfo.realUserID,
        deviceInfo.deviceId
      )

      let response
      try {
        response = await axios.request({
          method: 'POST',
          url: config.url,
          data: body,
          timeout: 15000,
          validateStatus: () => true,
          headers: config.headers,
        })
      } catch (err) {
        console.log(`  [stream poll ${pollCount}] Request error: ${err instanceof Error ? err.message : err}`)
        continue
      }

      if (response.status !== 200) {
        console.log(`  [stream poll ${pollCount}] HTTP ${response.status}`)
        continue
      }

      // MiniMax get_chat_detail returns: { base_resp: { status_code }, messages: [...] }
      const responseData = response.data
      const baseResp = responseData?.base_resp
      const messages = responseData?.messages

      // Debug logging
      if (pollCount <= 3 || (messages && messages.length > 0)) {
        console.log(`  [stream poll ${pollCount}] base_resp:`, JSON.stringify(baseResp))
        console.log(`  [stream poll ${pollCount}] messages: ${messages?.length || 0}`)
        if (messages) {
          for (const msg of messages) {
            console.log(`    msg_type=${msg.msg_type}, content_len=${msg.msg_content?.length || 0}, finish_time=${msg.finish_time || 'none'}`)
          }
        }
      }

      if (baseResp?.status_code !== 0) continue
      if (!messages) continue

      const aiMessage = messages.find((msg: any) => msg.msg_type === 2)
      if (!aiMessage?.msg_content) continue

      const currentContent = aiMessage.msg_content
      if (currentContent === lastContent) continue

      // Extract incremental content
      const increment = currentContent.substring(lastContent.length)
      lastContent = currentContent

      // Check if generation is finished
      const isFinished = aiMessage.finish_time || aiMessage.status === 'finished'

      // Feed increment to ToolStreamParser
      const chunks = toolStreamParser.push(increment, baseChunk, emittedContent === '' && emittedToolCalls.length === 0)
      for (const chunk of chunks) {
        const delta = chunk.choices?.[0]?.delta
        if (delta?.content) {
          emittedContent += delta.content
          process.stdout.write(delta.content)
        }
        if (delta?.tool_calls) {
          emittedToolCalls.push(...delta.tool_calls)
        }
      }

      if (isFinished) {
        // Flush remaining
        const flushChunks = toolStreamParser.flush(baseChunk)
        for (const chunk of flushChunks) {
          const delta = chunk.choices?.[0]?.delta
          if (delta?.tool_calls) {
            emittedToolCalls.push(...delta.tool_calls)
          }
        }
        console.log(`\n  [MiniMax] Stream finished after ${pollCount} polls`)
        break
      }
    }

    console.log('\n\n  --- MiniMax Stream Results ---')
    console.log(`  Content emitted: ${emittedContent.substring(0, 200)}`)
    console.log(`  Tool calls emitted: ${emittedToolCalls.length}`)
    for (const tc of emittedToolCalls) {
      console.log(`    → tool: ${tc.function?.name}, args: ${tc.function?.arguments}`)
    }
    console.log(`  hasEmittedToolCall: ${toolStreamParser.hasEmittedToolCall()}`)

    const passed = emittedToolCalls.length > 0
    recordResult({
      name: 'MiniMax Stream Tool Calling',
      passed,
      details: passed
        ? `Stream emitted ${emittedToolCalls.length} tool call(s)`
        : 'No tool calls emitted in stream (expected: MiniMax stream does not integrate ToolStreamParser)',
      toolCallsFound: emittedToolCalls.length,
    })
  } catch (error) {
    recordResult({
      name: 'MiniMax Stream Tool Calling',
      passed: false,
      details: `Error: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║     Chat2API Tool Calling E2E Test                       ║')
  console.log('║     MiniMax | Stream + Non-Stream                        ║')
  console.log('╚══════════════════════════════════════════════════════════╝')

  // ── Step 1: Collect token (with cache) ──
  const forceRefresh = process.argv.includes('--refresh')
  let minimaxJwt: string | undefined
  let minimaxUserID: string | undefined

  if (!forceRefresh) {
    const cached = loadCachedToken()
    if (cached) {
      minimaxJwt = cached.jwtToken
      minimaxUserID = cached.realUserID
    }
  }

  if (!minimaxJwt || !minimaxUserID) {
    const collected = await collectMinimaxToken()
    minimaxJwt = collected.jwtToken
    minimaxUserID = collected.realUserID
    saveCachedToken(minimaxJwt, minimaxUserID)
  }

  console.log('\n>>> MiniMax JWT:', minimaxJwt.substring(0, 20) + '...')
  console.log('>>> MiniMax realUserID:', minimaxUserID)

  // ── Step 2: MiniMax Tests ──
  await testMinimaxNonStream(minimaxJwt, minimaxUserID)
  await testMinimaxStream(minimaxJwt, minimaxUserID)

  // ── Summary ──
  console.log('\n\n╔══════════════════════════════════════════════════════════╗')
  console.log('║                    TEST SUMMARY                           ║')
  console.log('╠══════════════════════════════════════════════════════════╣')
  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.passed).length
  for (const r of results) {
    const icon = r.passed ? '✓' : '✗'
    console.log(`║  ${icon} ${r.name.padEnd(45)} ${r.toolCallsFound !== undefined ? `(${r.toolCallsFound} calls)` : ''.padEnd(12)}║`)
  }
  console.log('╠══════════════════════════════════════════════════════════╣')
  console.log(`║  Total: ${results.length}  |  Passed: ${passed}  |  Failed: ${failed}                    ║`)
  console.log('╚══════════════════════════════════════════════════════════╝')

  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
