import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const browserName = process.argv[2]
if (!['chrome', 'firefox'].includes(browserName)) {
  throw new Error('Browser name must be chrome or firefox')
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectDir = path.resolve(scriptDir, '..')
const buildDir = path.join(projectDir, '.extension-build', browserName)
const archivePath = path.join(
  projectDir,
  browserName === 'chrome' ? 'tab-utils-chrome.zip' : 'tab-utils.xpi'
)
const isStorageUnlimited = process.env.BUILD_IS_SNAPSHOT_STORAGE_UNLIMITED === 'true'

await rm(buildDir, { recursive: true, force: true })
await mkdir(buildDir, { recursive: true })

const manifest = JSON.parse(await readFile(path.join(projectDir, 'manifest.json'), 'utf8'))
if (browserName === 'firefox') {
  delete manifest.background.service_worker
} else {
  delete manifest.background.scripts
  delete manifest.browser_specific_settings
}
if (isStorageUnlimited && !manifest.permissions.includes('unlimitedStorage')) {
  manifest.permissions.push('unlimitedStorage')
}
await writeFile(
  path.join(buildDir, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`
)

for (const itemName of ['background.js', 'background', 'icon']) {
  await cp(
    path.join(projectDir, itemName),
    path.join(buildDir, itemName),
    { recursive: true }
  )
}
await mkdir(path.join(buildDir, 'popup'), { recursive: true })
await cp(
  path.join(projectDir, 'popup', 'build'),
  path.join(buildDir, 'popup', 'build'),
  { recursive: true }
)

await rm(archivePath, { force: true })
const zipResult = spawnSync('zip', ['-r', archivePath, '.'], {
  cwd: buildDir,
  stdio: 'inherit'
})
if (zipResult.status !== 0) {
  throw new Error(`Archive creation failed with code ${zipResult.status}`)
}
