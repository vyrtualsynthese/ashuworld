#!/usr/bin/env node
/* global console, process */
// Guards the promise the web CSP makes: the Vite build ships no inline script, no inline
// style and no `javascript:` URL. nginx sends `script-src 'self'; style-src 'self'` with
// no hash and no `unsafe-inline`, so an inline element is not a policy to tighten later —
// the page simply stops working in the browser. Catching it here names the offending tag
// instead of leaving a blank page in production.
//
// No dependency on purpose: this runs in the `verify` job right after the build, before
// any dev tool is needed, and a parser for these three shapes would be more code than the
// checks themselves.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const indexPath = path.join(root, 'apps', 'web', 'dist', 'index.html')

let html
try {
  html = await readFile(indexPath, 'utf8')
} catch {
  console.error(
    `check-web-csp: ${path.relative(root, indexPath)} is missing; build the web app first ` +
      '(pnpm --filter @ashuworld/web build)',
  )
  process.exit(1)
}

const problems = []

// An opening `<script ...>` tag: everything up to the first `>`. Inline means no `src`
// attribute at all. A `<script src="...">` with an empty body is what Vite emits.
for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
  const attributes = match[1] ?? ''
  if (!/\bsrc\s*=/i.test(attributes)) {
    problems.push(`<script> without src at index ${match.index}: ${match[0]}`)
  }
}

// nginx allows `style-src 'self'` only, so any `<style>` element — inline or not — would
// need a hash in the policy. React and Vite emit a linked stylesheet instead.
for (const match of html.matchAll(/<style\b[^>]*>/gi)) {
  problems.push(`<style> element at index ${match.index}: ${match[0]}`)
}

// A `javascript:` URL is inline script in another spelling, and `script-src 'self'` refuses
// it too.
for (const match of html.matchAll(/\b(?:href|src)\s*=\s*["']?\s*javascript:/gi)) {
  problems.push(`javascript: URL at index ${match.index}: ${match[0]}`)
}

if (problems.length > 0) {
  console.error(`check-web-csp: ${problems.length} CSP violation(s) in the built bundle:`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log('check-web-csp: the built bundle has no inline script, no <style> and no javascript: URL')
