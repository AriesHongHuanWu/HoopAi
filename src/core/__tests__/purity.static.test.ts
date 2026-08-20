/**
 * Static purity scan: src/core and src/ml are pure + deterministic
 * (replayable). Time comes only from camera timestamps carried in the
 * inputs. A wall-clock or RNG read here breaks recorded-session replay and
 * the whole-suite determinism contract — the same frames must always produce
 * the same shots.
 *
 * The scan is textual (comment-stripped line regexes), not an AST walk: it
 * can under-match in pathological cases (a pattern after a string literal
 * containing '//') but never blocks legitimate code, and it needs zero deps.
 */
import * as fs from 'fs';
import * as path from 'path';

const CORE_ROOT = path.resolve(__dirname, '..');
const ML_ROOT = path.resolve(__dirname, '../../ml');

/**
 * Sanctioned exceptions: repo-relative-ish path (as produced by relPath())
 * -> list of pattern names allowed in that file. Add entries ONLY with a
 * rationale comment explaining why the hit is safe. Starts empty on purpose.
 */
const ALLOWLIST: Record<string, string[]> = {};

/** Recursively list non-test .ts sources under a root. */
function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...listSources(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Stable, separator-normalized display path for failure messages. */
function relPath(file: string): string {
  return path.relative(path.resolve(__dirname, '../../..'), file).split(path.sep).join('/');
}

/**
 * Read a file and return its lines with comments stripped: '//' tails
 * removed, /* ... *\/ block contents blanked (tracked across lines). String
 * literals are NOT parsed — see the header note on textual under-matching.
 */
function codeLines(file: string): string[] {
  const raw = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let inBlock = false;
  return raw.map((line) => {
    let out = '';
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end === -1) return out;
        inBlock = false;
        i = end + 2;
        continue;
      }
      const lineComment = line.indexOf('//', i);
      const blockComment = line.indexOf('/*', i);
      if (lineComment !== -1 && (blockComment === -1 || lineComment < blockComment)) {
        return out + line.slice(i, lineComment);
      }
      if (blockComment !== -1) {
        out += line.slice(i, blockComment);
        inBlock = true;
        i = blockComment + 2;
        continue;
      }
      out += line.slice(i);
      break;
    }
    return out;
  });
}

interface BannedPattern {
  name: string;
  re: RegExp;
}

/** Scan files for banned patterns; return 'file:line pattern' violations. */
function scan(files: string[], patterns: BannedPattern[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const rel = relPath(file);
    const allowed = ALLOWLIST[rel] ?? [];
    const lines = codeLines(file);
    lines.forEach((line, idx) => {
      for (const p of patterns) {
        if (p.re.test(line) && !allowed.includes(p.name)) {
          violations.push(`${rel}:${idx + 1} ${p.name}`);
        }
      }
    });
  }
  return violations;
}

const WALL_CLOCK_RNG: BannedPattern[] = [
  { name: 'Date.now', re: /\bDate\.now\s*\(/ },
  { name: 'performance.now', re: /\bperformance\.now\s*\(/ },
  { name: 'Math.random', re: /\bMath\.random\s*\(/ },
];

const TIMERS: BannedPattern[] = [
  { name: 'setTimeout', re: /\bsetTimeout\s*\(/ },
  { name: 'setInterval', re: /\bsetInterval\s*\(/ },
];

describe('static purity scan', () => {
  test('no wall clock / RNG in src/core or src/ml', () => {
    const files = [...listSources(CORE_ROOT), ...listSources(ML_ROOT)];
    expect(files.length).toBeGreaterThan(0);
    expect(scan(files, WALL_CLOCK_RNG)).toEqual([]);
  });

  test('no timers in src/core or src/ml', () => {
    const files = [...listSources(CORE_ROOT), ...listSources(ML_ROOT)];
    expect(scan(files, TIMERS)).toEqual([]);
  });

  // Reanimated captures module vars by value; writing one from a worklet
  // crashes on the first frame — this happened with a layout-lock cache (see
  // the prevLayout threading around yoloParser.ts:238-242, which replaced
  // it). Column-0 let/var = module scope; indented let is function-local and
  // fine.
  test('no module-scope mutable state in src/ml (worklet capture crash)', () => {
    const files = listSources(ML_ROOT);
    expect(files.length).toBeGreaterThan(0);
    const violations = scan(files, [
      { name: 'module-scope let/var', re: /^(let|var)\s/ },
    ]);
    expect(violations).toEqual([]);
  });
});
