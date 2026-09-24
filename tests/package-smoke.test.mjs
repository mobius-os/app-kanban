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
