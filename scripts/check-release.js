// Release checks used by .github/workflows/publish.yml (and runnable locally):
//
//   node scripts/check-release.js version <tag>      the tag (a leading "v" is ignored) must equal package.json's version
//   node scripts/check-release.js vsix <file.vsix>   the .vsix must contain only the files an extension needs at runtime
//
// Exits with a non-zero code and a "::error::" message (a GitHub Actions annotation) when a check fails.
// It has no dependencies; the zip directory is read with Node's own fs.
'use strict';
const fs = require('fs');
const path = require('path');

/** "v1.2.3" -> "1.2.3". */
function normalizeTag(tag) {
  return String(tag ?? '').trim().replace(/^v/, '');
}

/** Compares a release tag with the version in package.json. Returns { ok, version, message }. */
function checkVersion(tag, packageVersion) {
  const wanted = normalizeTag(tag);
  if (!wanted) {
    return { ok: false, version: packageVersion, message: 'No release tag was given.' };
  }
  if (wanted !== packageVersion) {
    return {
      ok: false,
      version: packageVersion,
      message: `The release tag "${tag}" (version ${wanted}) does not match the version in package.json (${packageVersion}). Bump the version, push, and create the release from a tag that matches.`
    };
  }
  return { ok: true, version: packageVersion, message: `Tag ${tag} matches package.json version ${packageVersion}.` };
}

/** What may be inside the .vsix: the generated files, the standard docs and the runtime files (case-insensitive). */
const ALLOWED_VSIX_ENTRIES = [
  /^\[Content_Types\]\.xml$/,
  /^extension\.vsixmanifest$/,
  /^extension\/package\.json$/,
  /^extension\/(readme|changelog)\.md$/i,
  /^extension\/licen[sc]e(\.txt|\.md)?$/i,
  /^extension\/media\/(cats\.css|icon\.png)$/,
  /^extension\/out\/[A-Za-z0-9_-]+\.js$/,
  /^extension\/out\/webview\/cats\.js$/
];

/** Names that are rejected even if a pattern above were ever widened. */
const FORBIDDEN_NAMES = /(^|\/)(\.env[^/]*|[^/]*todo[^/]*|[^/]*secret[^/]*|[^/]*\.(pem|key|map|ts))$/i;

/** Checks the list of file names in a .vsix. Returns { ok, unexpected }. */
function checkVsixEntries(entries) {
  const names = entries.filter((n) => !n.endsWith('/'));
  const unexpected = names.filter((n) => FORBIDDEN_NAMES.test(n) || !ALLOWED_VSIX_ENTRIES.some((re) => re.test(n)));
  const missing = ['extension/package.json', 'extension/out/extension.js', 'extension/media/cats.css', 'extension/out/webview/cats.js'].filter((n) => !names.includes(n));
  return { ok: unexpected.length === 0 && missing.length === 0, unexpected, missing };
}

/** The file names of a zip (.vsix), read from its central directory. */
function listZipEntries(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${file} is not a zip file`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`${file}: broken zip directory`);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    names.push(buf.toString('utf8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exitCode = 1;
}

function main(argv) {
  const [mode, arg] = argv;
  if (mode === 'version') {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
    const r = checkVersion(arg, pkg.version);
    if (!r.ok) return fail(r.message);
    console.log(r.message);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${r.version}\n`);
  } else if (mode === 'vsix' && arg) {
    const entries = listZipEntries(arg);
    console.log(`${arg} contains ${entries.length} entries:`);
    entries.forEach((e) => console.log(`  ${e}`));
    const r = checkVsixEntries(entries);
    if (!r.ok) {
      return fail(
        [r.unexpected.length ? `Unexpected files in the package: ${r.unexpected.join(', ')}.` : '', r.missing.length ? `Missing files: ${r.missing.join(', ')}.` : '']
          .filter(Boolean)
          .join(' ')
      );
    }
    console.log('The package contains only the expected files.');
  } else {
    fail('Usage: node scripts/check-release.js version <tag> | vsix <file.vsix>');
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { normalizeTag, checkVersion, checkVsixEntries, listZipEntries, ALLOWED_VSIX_ENTRIES };
