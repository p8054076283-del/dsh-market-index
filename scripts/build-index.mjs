#!/usr/bin/env node
/**
 * 从 awesome-dsh-plugin 目录生成 DSH 插件市场索引（format 1）。
 *
 * 输入：https://awesome-dsh-plugin.com/plugins.json（社区最大的插件目录，每日 CI 更新）
 * 输出：index.json —— DSH「插件 → 发现」页直接可用的索引文件
 *
 * 每条目录记录带 npm 包名和版本；真值以 registry 为准：取 dist-tags.latest 的
 * manifest，要求它声明了 dsh.bundle（否则装进 profile 也不是一个组合包层），
 * 发布时间取 packument 的 time 字段。engines.dsh 原样透传，让「发现」页自己算兼容性。
 *
 * 用法：
 *   node scripts/build-index.mjs [--out index.json] [--catalog <url|file>] [--concurrency 16]
 *   node scripts/build-index.mjs --check     # 只校验已存在的 index.json，不重新生成
 */
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const CATALOG_URL = 'https://awesome-dsh-plugin.com/plugins.json'
const DEFAULT_OUT = 'index.json'
const REGISTRY = 'https://registry.npmmirror.com'
const FALLBACK_REGISTRY = 'https://registry.npmjs.org'
const MAX_VERSIONS_PER_PLUGIN = 1
const USER_AGENT = 'dsh-market-index-builder/1.0 (+https://github.com/)'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}
const flag = (name) => process.argv.includes(`--${name}`)

const out = arg('out', DEFAULT_OUT)
const catalogSource = arg('catalog', CATALOG_URL)
const concurrency = Number(arg('concurrency', '16'))

const log = (...parts) => console.error(...parts)

async function fetchJson(url, { retries = 3, headers = {} } = {}) {
  let lastError
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...headers },
        signal: AbortSignal.timeout(45_000),
      })
      if (response.status === 404) return undefined
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    } catch (error) {
      lastError = error
      if (attempt < retries) await new Promise((done) => setTimeout(done, 800 * attempt))
    }
  }
  throw lastError
}

/** 有效的 SemVer range 才透传，非法值直接丢掉（索引校验器会拒绝整份文档）。 */
function semverRange(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  if (value.startsWith('workspace:')) return undefined
  // 交给索引校验器做最终判断；这里只挡掉明显不是 range 的东西。
  if (!/^[v=<>~^*0-9xX|\s.+-]+$/u.test(value)) return undefined
  return value.trim()
}

function localized(text) {
  if (!text) return undefined
  if (typeof text === 'string') return { en: text }
  const en = typeof text.en === 'string' ? text.en.trim() : ''
  const zh = typeof text.zh === 'string' ? text.zh.trim() : ''
  if (!en && !zh) return undefined
  return { en: en || zh, ...(zh ? { zh } : {}) }
}

function seconds(iso) {
  const value = Date.parse(iso)
  if (!Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value / 1000)
}

const catalog = typeof catalogSource === 'string' && /^https?:/u.test(catalogSource)
  ? await fetchJson(catalogSource)
  : JSON.parse(await readFile(catalogSource, 'utf8'))

const categories = {}
for (const [id, titles] of Object.entries(catalog.categories ?? {})) {
  const title = localized(titles)
  if (title) categories[id] = { title }
}

const candidates = (catalog.plugins ?? []).filter((entry) => typeof entry.npm === 'string' && entry.npm !== '')
log(`catalog: ${catalog.plugins?.length ?? 0} entries, ${candidates.length} with an npm package`)

const plugins = []
const skipped = { notFound: 0, noBundle: 0, noVersion: 0, noTimestamp: 0 }

let cursor = 0
async function worker() {
  while (cursor < candidates.length) {
    const entry = candidates[cursor]
    cursor += 1
    let packument
    try {
      packument = await fetchJson(`${REGISTRY}/${entry.npm}`)
    } catch {
      try {
        packument = await fetchJson(`${FALLBACK_REGISTRY}/${entry.npm}`)
      } catch {
        skipped.notFound += 1
        continue
      }
    }
    if (!packument) {
      skipped.notFound += 1
      continue
    }
    const wanted = [packument['dist-tags']?.latest, entry.version].filter((v) => typeof v === 'string')
    const versions = []
    for (const version of wanted) {
      const manifest = packument.versions?.[version]
      if (!manifest) continue
      if (manifest.deprecated) continue
      if (!manifest.dsh?.bundle) continue
      const published = seconds(packument.time?.[version])
      if (published === undefined) continue
      if (versions.some((item) => item.version === version)) continue
      const engines = semverRange(manifest.engines?.dsh)
      versions.push({
        version,
        publishTimestamp: published,
        source: { type: 'npm', registry: REGISTRY },
        ...(engines ? { engines: { dsh: engines } } : {}),
      })
      if (versions.length >= MAX_VERSIONS_PER_PLUGIN) break
    }
    if (versions.length === 0) {
      const latest = packument['dist-tags']?.latest
      if (!latest || !packument.versions?.[latest]) skipped.noVersion += 1
      else if (!packument.versions[latest].dsh?.bundle) skipped.noBundle += 1
      else skipped.noTimestamp += 1
      continue
    }
    const best = versions[0]
    const manifest = packument.versions[best.version] ?? {}
    const category = typeof entry.category === 'string' && categories[entry.category] ? entry.category : undefined
    const description = localized(entry.description)
    const homepage = typeof entry.url === 'string' && URL.canParse(entry.url) ? entry.url : undefined
    const sortKeys = {}
    if (Number.isFinite(entry.stars)) sortKeys.stars = entry.stars
    if (Number.isFinite(entry.downloads)) sortKeys.downloads = entry.downloads
    plugins.push({
      name: entry.npm,
      ...(homepage ? { homepage } : {}),
      ...(typeof entry.owner === 'string' && entry.owner !== '' ? { author: entry.owner } : {}),
      ...(description ? { description } : {}),
      ...(typeof manifest.icon === 'string' ? {} : {}),
      ...(homepage ? { repository: { url: homepage } } : {}),
      versions,
      metadata: {
        ...(category ? { category } : {}),
        ...(Object.keys(sortKeys).length > 0 ? { sortKeys } : {}),
      },
    })
    if (plugins.length % 250 === 0) log(`  ${plugins.length} plugins…`)
  }
}

await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))

plugins.sort((a, b) => a.name.localeCompare(b.name))

const document = {
  format: 1,
  title: {
    en: 'Awesome DSH Plugins',
    zh: 'DSH 社区插件大全',
  },
  description: {
    en: `Generated from the awesome-dsh-plugin catalog (${catalog.plugins?.length ?? 0} entries): npm bundles whose manifest declares dsh.bundle. Inclusion is not a security review.`,
    zh: `由 awesome-dsh-plugin 目录（${catalog.plugins?.length ?? 0} 条）生成：只收录 manifest 声明了 dsh.bundle 的 npm 组合包。收录不代表安全审查。`,
  },
  metadata: {
    categories,
    labels: {},
    sortKeys: {
      stars: { title: { en: 'Stars', zh: '收藏' }, order: 'desc' },
      downloads: { title: { en: 'Downloads', zh: '下载量' }, order: 'desc' },
    },
  },
  plugins,
}

if (flag('check')) {
  const { parseMarketIndex } = await import('../vendor/plugin-market-index.mjs')
  const existing = JSON.parse(await readFile(out, 'utf8'))
  parseMarketIndex(existing, 'https://example.com/index.json')
  console.log(`index.json is valid format 1 with ${existing.plugins.length} plugins`)
  process.exit(0)
}

await writeFile(out, `${JSON.stringify(document, undefined, 1)}\n`)
log(`wrote ${out}: ${plugins.length} plugins`)
log(`skipped: ${JSON.stringify(skipped)}`)
if (existsSync(out)) log(`size: ${(await readFile(out)).length} bytes`)
