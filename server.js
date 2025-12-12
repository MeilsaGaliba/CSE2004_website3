import http from 'http'
import { URL } from 'url'
import fs from 'fs'
import path from 'path'

const PORT = process.env.PORT || 3000
let OPENAI_API_KEY = process.env.OPENAI_API_KEY
const KEY_FILE = process.env.OPENAI_API_KEY_FILE || '.openai-key'
const BULLETIN_TXT_PATH = path.join(process.cwd(), 'bulletin.txt')
let BULLETIN_TEXT = ''
try {
  if (fs.existsSync(BULLETIN_TXT_PATH)) {
    BULLETIN_TEXT = fs.readFileSync(BULLETIN_TXT_PATH, 'utf8')
  }
} catch {}
if (!OPENAI_API_KEY && fs.existsSync(KEY_FILE)) {
  try {
    OPENAI_API_KEY = fs.readFileSync(KEY_FILE, 'utf8').trim()
  } catch {}
}

function send(res, status, data, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    ...headers,
  })
  res.end(JSON.stringify(data))
}

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('Not found')
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
    })
    res.end(buf)
  })
}

function buildPrompt({ systemPrompt, history = [], userMessage, context }) {
  const lines = [`System: ${systemPrompt}`]
  if (context && context.trim()) {
    lines.push(`Context:\n${context}`)
  }
  for (const turn of history.slice(-10)) {
    const role = turn.role === 'assistant' ? 'Assistant' : 'User'
    lines.push(`${role}: ${turn.content}`)
  }
  lines.push(`User: ${userMessage}`)
  return lines.join('\n\n')
}

function summarizeChecked(checked = []) {
  if (!Array.isArray(checked) || checked.length === 0) return ''
  const byCat = {}
  for (const c of checked) {
    const cat = (c.category || 'other').toLowerCase()
    if (!byCat[cat]) byCat[cat] = []
    const code = (c.code || '').trim()
    const name = (c.name || '').trim()
    const units = (c.units || '').trim()
    byCat[cat].push(`${code}${name ? ' - ' + name : ''}${units ? ' (' + units + 'u)' : ''}`)
  }
  const parts = []
  for (const [cat, items] of Object.entries(byCat)) {
    parts.push(`- ${cat}:`)
    for (const it of items) parts.push(`  • ${it}`)
  }
  return `Student reports these completed/checked courses:\n${parts.join('\n')}`
}

function guessCategoryByPrefix(code = '', name = '') {
  const prefix = (code.match(/^[A-Z]+/) || [''])[0]
  switch (prefix) {
    case 'MATH':
      return 'foundation'
    case 'DAT':
    case 'FIN':
    case 'MEC':
    case 'MKT':
    case 'SCOT':
    case 'ACCT':
    case 'OB':
    case 'MGT':
      return 'business'
    case 'CSE':
    case 'ESE':
      return 'cs'
    case 'CWP':
    case 'NSM':
      return 'capstone'
    default:
      return 'breadth'
  }
}

function guessCategoryFromBulletin(code = '', name = '') {
  if (!BULLETIN_TEXT) return null
  const needle = code.trim().replace(/\s+/g, ' ')
  if (!needle) return null
  const hay = BULLETIN_TEXT
  const idx = hay.toUpperCase().indexOf(needle.toUpperCase())
  if (idx === -1) return null
  const start = Math.max(0, idx - 2000)
  const context = hay.slice(start, idx + 2000)
  const tests = [
    { re: /Computer Science[^]*?(Core|Elective|Requirements)?/i, cat: 'cs' },
    { re: /Business[^]*?(Core|Elective|Requirements)?/i, cat: 'business' },
    { re: /Capstone|Integrated Learning Experience/i, cat: 'capstone' },
    { re: /Foundation Course Requirements/i, cat: 'foundation' },
    { re: /Breadth|Free Electives/i, cat: 'breadth' },
    { re: /Natural Sciences|NSM/i, cat: 'capstone' },
    { re: /College Writing/i, cat: 'capstone' },
  ]
  for (const t of tests) {
    if (t.re.test(context)) return t.cat
  }
  return null
}

const server = http.createServer(async (req, res) => {
  const { method, url } = req
  const parsed = new URL(url, `http://localhost:${PORT}`)

  if (method === 'OPTIONS') {
    return send(res, 204, {})
  }

  if (method === 'GET') {
    if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
      let fp = path.join(process.cwd(), 'index.html')
      try {
        if (!fs.existsSync(fp)) {
          const alt = path.join(process.cwd(), 'public', 'index.html')
          if (fs.existsSync(alt)) fp = alt
        }
      } catch {}
      return sendFile(res, fp, 'text/html; charset=utf-8')
    }
    if (parsed.pathname === '/styles.css') {
      const fp = path.join(process.cwd(), 'styles.css')
      return sendFile(res, fp, 'text/css; charset=utf-8')
    }
  }

  // categorizer for user-added courses
  if (method === 'POST' && parsed.pathname === '/api/categorize') {
    try {
      let body = ''
      req.on('data', (c) => (body += c))
      await new Promise((r) => req.on('end', r))
      const { code = '', name = '' } = JSON.parse(body || '{}')
      if (!code && !name) return send(res, 200, { category: 'breadth', source: 'default' })
      const fromBulletin = guessCategoryFromBulletin(code, name)
      if (fromBulletin) return send(res, 200, { category: fromBulletin, source: 'bulletin' })
      const cat = guessCategoryByPrefix(code, name)
      return send(res, 200, { category: cat, source: 'prefix' })
    } catch (err) {
      return send(res, 200, { category: 'breadth', source: 'error' })
    }
  }

  if (method === 'POST' && parsed.pathname === '/api/chat') {
    if (!OPENAI_API_KEY) {
      return send(res, 200, { reply: 'Advisor error: missing API key on server.' })
    }
    try {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      await new Promise((resolve) => req.on('end', resolve))
      let payload
      try {
        payload = JSON.parse(body || '{}')
      } catch {
        return send(res, 200, { reply: 'Advisor error: invalid JSON body.' })
      }
      const { message, history, checked } = payload || {}
      if (!message || typeof message !== 'string') {
        return send(res, 200, { reply: 'Advisor error: message is required.' })
      }

      const systemPrompt =
        'You are a helpful academic advisor for the Bachelor of Science in Business + Computer Science. Be concise and actionable. Use plain text (no markdown). If asked about requirements, map to the program structure (Foundation, Breadth/Free Electives, Business, Computer Science, Capstone). Reference course codes when relevant (e.g., MATH 1510). If you are unsure, say so briefly. If a Context section is provided with completed/checked courses, use it directly to tailor advice and do not ask the user to list them again.'
      const context = summarizeChecked(checked)
      try { console.log('AI context - checked courses:', Array.isArray(checked) ? checked.length : 0) } catch {}
      const prompt = buildPrompt({ systemPrompt, history, userMessage: message, context })

      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          input: prompt,
          temperature: 0.6
        }),
      })

      const json = await response.json()
      if (!response.ok) {
        console.error('OpenAI error:', json)
        const msg =
          json?.error?.message ||
          (typeof json === 'string' ? json : 'OpenAI request failed.')
        return send(res, 200, { reply: `Advisor error: ${msg}` })
      }
      let reply =
        json.output_text ||
        (Array.isArray(json.content) ? json.content.map((c) => c?.text).filter(Boolean).join('\n') : '') ||
        json.choices?.[0]?.message?.content
      if (!reply && Array.isArray(json.output)) {
        const texts = []
        for (const block of json.output) {
          if (Array.isArray(block.content)) {
            for (const part of block.content) {
              if (typeof part.text === 'string') texts.push(part.text)
            }
          }
        }
        reply = texts.join('\n')
      }
      reply = reply || 'Sorry, I could not generate a reply.'

      return send(res, 200, { reply })
    } catch (err) {
      console.error('Proxy error:', err)
      return send(res, 200, { reply: 'Advisor error: unable to reach OpenAI.' })
    }
  }

  send(res, 404, { error: 'Not found' })
})

server.listen(PORT, () => {
  console.log(`AI proxy listening on http://localhost:${PORT}`)
})



