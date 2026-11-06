/**
 * dsh-plugin-categories — host half.
 *
 * Stores the custom plugin-page layout as one JSON document and exposes it to
 * the client half over a webServer route. The client keeps a localStorage copy
 * so the page still works when this route is unavailable.
 *
 * Layout document (schema version 1):
 *
 *   {
 *     "version": 1,
 *     "categories": [
 *       { "id": "...", "name": "自己写的", "collapsed": false, "packages": ["@local/dsh-api-rules"] }
 *     ],
 *     "uncategorizedCollapsed": false,
 *     "collapsedGroups": { "basic": false, "extensions": true }
 *   }
 *
 * One package belongs to exactly one category; the first claim wins. A payload
 * this half does not understand is treated as "no layout yet" instead of being
 * guessed at, mirroring the client half.
 *
 * Storage:
 *   - with a profile: <DSH_PROFILE_DIR>/data/dsh-plugin-categories/state.json
 *   - otherwise:      <DSH_HOME>/dsh-plugin-categories/state.json
 *                     then      ~/.dsh/dsh-plugin-categories/state.json
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-plugin-categories'

/** No required service: everything below is optional (`ctx.get`). */
export const inject = []

const ROUTE = '/dsh-plugin-categories/state'
const SCHEMA_VERSION = 1
const MAX_NAME = 60
const MAX_CATEGORIES = 200
const MAX_PACKAGES_PER_CATEGORY = 2000

/** Sentinel id for the "uncategorized" header. */
const UNCAT = '__uncategorized__'

function dshHome(env = process.env) {
  const explicit = env['DSH_HOME']
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit
  return join(homedir(), '.dsh')
}

function profileDir(env = process.env) {
  const explicit = env['DSH_PROFILE_DIR']
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit
  return null
}

/** Where the layout lives. First existing parent wins; otherwise the profile path. */
function statePath(env = process.env) {
  const profile = profileDir(env)
  if (profile !== null) return join(profile, 'data', 'dsh-plugin-categories', 'state.json')
  return join(dshHome(env), 'dsh-plugin-categories', 'state.json')
}

function emptyState() {
  return {
    version: SCHEMA_VERSION,
    categories: [],
    uncategorizedCollapsed: false,
    // 整组折叠：官方「内置」「实验性」两组各一个独立开关，与分类无关。
    collapsedGroups: {},
  }
}

function clampName(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME)
}

let idSeq = 0
function makeId() {
  idSeq += 1
  return `c${Date.now().toString(36)}${idSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** Coerce any input into a layout document this plugin can render. */
export function normalize(raw) {
  const out = emptyState()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  if (raw.version !== SCHEMA_VERSION) return out
  if (raw.uncategorizedCollapsed === true) out.uncategorizedCollapsed = true
  // 整组折叠标志：按组 id 各存一个布尔，缺省 false。
  if (raw.collapsedGroups !== null && typeof raw.collapsedGroups === 'object' && !Array.isArray(raw.collapsedGroups)) {
    for (const key of ['basic', 'extensions']) {
      if (raw.collapsedGroups[key] === true) out.collapsedGroups[key] = true
    }
  }
  const list = Array.isArray(raw.categories) ? raw.categories : []
  const usedIds = new Set()
  for (const entry of list) {
    if (out.categories.length >= MAX_CATEGORIES) break
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const name = clampName(entry.name)
    if (name === '') continue
    let id = typeof entry.id === 'string' && entry.id !== '' && entry.id !== UNCAT ? entry.id : makeId()
    if (usedIds.has(id)) id = makeId()
    usedIds.add(id)
    const packages = []
    for (const value of Array.isArray(entry.packages) ? entry.packages : []) {
      if (packages.length >= MAX_PACKAGES_PER_CATEGORY) break
      if (typeof value !== 'string' || value === '' || packages.includes(value)) continue
      packages.push(value)
    }
    out.categories.push({ id, name, collapsed: entry.collapsed === true, packages })
  }
  // One package lives in exactly one category; the first claim wins.
  const claimed = new Set()
  for (const category of out.categories) {
    category.packages = category.packages.filter((pkg) => {
      if (claimed.has(pkg)) return false
      claimed.add(pkg)
      return true
    })
  }
  return out
}

async function readState(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState()
    throw error
  }
  try {
    return normalize(JSON.parse(text))
  } catch {
    // A corrupt document must not take the page down; start over instead.
    return emptyState()
  }
}

async function writeState(path, state) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

function writeJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  response.end(payload)
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks)
}

export function apply(ctx, _rawConfig) {
  const logger = ctx.get?.('logger')
  const path = statePath()

  // webServer is optional: without it the client half falls back to localStorage.
  ctx.inject(['webServer'], (webCtx) => {
    const handler = async (request, response) => {
      const method = request.method ?? 'GET'
      if (method !== 'GET' && method !== 'POST' && method !== 'PUT') {
        writeJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      try {
        if (method === 'GET') {
          const state = await readState(path)
          writeJson(response, 200, { ok: true, state })
          return
        }
        const raw = await readBody(request)
        let parsed
        try {
          parsed = JSON.parse(raw.toString('utf8') || 'null')
        } catch {
          writeJson(response, 400, { ok: false, error: 'invalid json' })
          return
        }
        const incoming = parsed !== null && typeof parsed === 'object' && 'state' in parsed ? parsed.state : parsed
        const state = normalize(incoming)
        await writeState(path, state)
        writeJson(response, 200, { ok: true, state })
      } catch (error) {
        logger?.warn?.(`[dsh-plugin-categories] ${ROUTE}: ${String(error)}`)
        writeJson(response, 500, { ok: false, error: String(error) })
      }
    }
    try {
      webCtx.webServer.register({ kind: 'exact', path: ROUTE, handler })
    } catch (error) {
      logger?.warn?.(`[dsh-plugin-categories] 路由注册失败: ${String(error)}`)
    }
  })

  logger?.info?.(`[dsh-plugin-categories] 就绪，布局文件: ${path}`)
}

export { statePath, ROUTE, SCHEMA_VERSION }
