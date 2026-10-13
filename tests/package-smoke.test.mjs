import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

test('manifest package includes the CLI pull-request matching import', () => {
  const manifest = JSON.parse(readFileSync(new URL('../mobius.json', import.meta.url)))
  assert.ok(manifest.source_files.includes('prMatching.js'))
  const packageRoot = mkdtempSync(join(tmpdir(), 'kanban-package-'))
  try {
    for (const path of manifest.source_files) {
      const destination = join(packageRoot, path)
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(new URL(`../${path}`, import.meta.url), destination)
    }
    const result = spawnSync(process.execPath, ['scripts/kanban.mjs'], {
      cwd: packageRoot,
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
    })
    assert.match(result.stderr, /Run inside a Möbius agent turn/)
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/)
  } finally {
    rmSync(packageRoot, { recursive: true, force: true })
  }
})

// An install from the app store fetches only `source_files`, so every module
// the app reaches from its entry (or the agent helper) must be listed there.
test('every module the app imports is listed in the manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../mobius.json', import.meta.url)))
  const listed = new Set(manifest.source_files)
  const seen = new Set()
  const queue = [manifest.entry, 'scripts/kanban.mjs']
  while (queue.length) {
    const path = queue.shift()
    if (seen.has(path)) continue
    seen.add(path)
    assert.ok(path === manifest.entry || listed.has(path), `${path} is imported but missing from source_files`)
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    for (const [, spec] of source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/gu)) {
      queue.push(join(dirname(path), spec).replaceAll('\\', '/'))
    }
  }
})
