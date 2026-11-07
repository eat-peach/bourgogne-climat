"""Export a code-only copy of the atlas for a public repository.

What goes in: the site code (dist/*.js, *.html, *.css, vendor libraries and fonts), the Cloudflare worker, build and
validation scripts, tests, migrations and configuration, from the files tracked in this repository.

What stays out: every data payload (dist/data/, dist/rhone/data/), the source and corrected scenes, source terrain,
working CSV/JSON reports and local notes. In their place, data-templates/ holds one skeleton per data family: the
same file layout and the same keys ("columns"), with every value replaced by a type placeholder, so the formats are
documented without publishing any record. CSV files keep their header row only.

Usage:  python scripts/export_public.py [--out "E:/Burgundy Map/github-export"]
The output folder is replaced each run except for its .git directory, so it can stay a git checkout.
"""
from __future__ import annotations
import argparse, csv, gzip, io, json, re, shutil, subprocess, sys
from pathlib import Path

SITE = Path(__file__).resolve().parents[1]
DEFAULT_OUT = SITE.parent / 'github-export'

INCLUDE = [r'^dist/(?!data/|rhone/data/)', r'^scripts/', r'^tests/', r'^migrations/', r'^worker/', r'^regions/[^/]+/region\.json$',
           r'^performance/[^/]+\.(mjs|md)$', r'^public-repo/', r'^(wrangler\.jsonc|package\.json|README\.md|start-local\.ps1|\.gitignore|\.dev\.vars\.example)$']
EXCLUDE = [r'\.(tif|tiff|gpkg)$', r'^dist/data/', r'^dist/rhone/data/', r'^scripts/data/']
DATA_ROOTS = ['dist/data', 'dist/rhone/data', 'scripts/data']
MAP_KEYS = 8          # a dict with more keys than this whose keys look like ids is a lookup table: keep one entry


def tracked():
    out = subprocess.run(['git', 'ls-files', '-z'], cwd=SITE, capture_output=True, check=True).stdout.decode('utf8')
    return [p for p in out.split('\0') if p]


def wanted(path):
    if not any(re.search(p, path) for p in INCLUDE): return False
    if path.startswith('dist/vendor/'): return True     # three.js, its licence and the self-hosted font
    return not any(re.search(p, path) for p in EXCLUDE)


def idlike(keys):
    """A lookup table rather than a record: many id-shaped keys, or keys that are not field names at all
    (paths, slugs, numbers, names), which would otherwise publish data values as keys."""
    keys = list(keys)
    if not keys: return False
    field = lambda k: re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', k) is not None
    if not all(field(k) for k in keys) and sum(not field(k) for k in keys) >= max(1, len(keys) * .5): return True
    return len(keys) > MAP_KEYS and sum(bool(re.search(r'[\d:_/-]', k)) for k in keys) >= len(keys) * .6


def skeleton(v, depth=0):
    if isinstance(v, dict):
        if idlike(v.keys()):
            k = next(iter(v)); return {'<id>': skeleton(v[k], depth + 1), '…': f'{len(v)} entries in the source file'}
        return {k: skeleton(x, depth + 1) for k, x in v.items()}
    if isinstance(v, list):
        if not v: return []
        if all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in v): return ['<number>', '…']
        if len(v) <= 6 and len({type(x).__name__ for x in v}) > 1: return [skeleton(x, depth + 1) for x in v]   # a tuple such as [id, share]
        return [skeleton(v[0], depth + 1), '…'] if len(v) > 1 else [skeleton(v[0], depth + 1)]
    if isinstance(v, bool): return '<boolean>'
    if isinstance(v, (int, float)): return '<number>'
    if isinstance(v, str): return '<string>'
    return None


def read_json(path):
    raw = path.read_bytes()
    if raw[:2] == bytes([0x1f, 0x8b]): raw = gzip.decompress(raw)
    return json.loads(raw.decode('utf8'))


def templates(out):
    dest = out / 'data-templates'
    rows = []
    for root in DATA_ROOTS:
        base = SITE / root
        if not base.exists(): continue
        seen = {}
        for f in sorted(base.rglob('*')):
            if not f.is_file(): continue
            sub = f.relative_to(base).as_posix()
            folder = sub.rsplit('/', 1)[0] if '/' in sub else ''
            key = (folder, re.sub(r'[\w\-]*\d[\w\-]*', '#', f.name) if folder else f.name)
            seen.setdefault(key, []).append(f)
        for (folder, pattern), files in sorted(seen.items()):
            f = files[0]; rel = f.relative_to(SITE).as_posix()
            suffix = ''.join(f.suffixes[-2:]) if f.name.endswith('.json.gz') else f.suffix
            plain = f.name[:-3] if f.name.endswith('.gz') else f.name
            ext = plain[plain.index('.'):] if '.' in plain else ''
            target = dest / f.relative_to(SITE).parent / (f'_template{ext}' if len(files) > 1 else plain)
            kind = 'binary (not templated)'
            try:
                if suffix in ('.json', '.json.gz'):
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(json.dumps(skeleton(read_json(f)), indent=2, ensure_ascii=False) + '\n', 'utf8'); kind = 'JSON skeleton'
                elif suffix == '.csv':
                    head = next(csv.reader(io.StringIO(f.read_text('utf8', 'replace'))), [])
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(','.join(head) + '\n', 'utf8'); kind = 'CSV header'
                elif suffix == '.js' and f.stat().st_size < 5_000_000:
                    text = f.read_text('utf8'); m = re.search(r'=\s*(\{.*\}|\[.*\])\s*;?\s*$', text, re.S)
                    if m:
                        target = target.with_name(target.name + '.json'); target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_text(json.dumps(skeleton(json.loads(m.group(1))), indent=2, ensure_ascii=False) + '\n', 'utf8'); kind = 'JSON skeleton (from JS module)'
            except Exception as e:  # unreadable payloads are listed, not templated
                kind = f'not templated ({type(e).__name__})'
            rows.append((root, folder or '.', pattern, len(files), kind, target.relative_to(dest).as_posix() if kind.startswith(('JSON', 'CSV')) else ''))
    lines = ['# Data templates', '',
             'The atlas data is not published here. Each data family under `dist/data/` (Burgundy) and `dist/rhone/data/` (Rhône)',
             'has one skeleton below: the same file path and the same keys as the real files, with values replaced by',
             '`<string>`, `<number>` or `<boolean>`. Lookup tables keyed by ids show one `<id>` entry; arrays show one element.',
             'Gzipped JSON (`.json.gz`) is shown uncompressed. Build the real files with the scripts in `scripts/`',
             '(for example `build_terroir.py`, `build_geology.py`) from the public sources named on the site\'s Sources page.', '',
             '| Site data | Folder | Files | Count | Template |', '|---|---|---|---|---|']
    for root, folder, pattern, n, kind, path in rows:
        lines.append(f"| `{root}` | `{folder}` | `{pattern}` | {n} | {f'[{kind}]({path.replace(chr(32), '%20')})' if path else kind} |")
    (dest).mkdir(parents=True, exist_ok=True)
    (dest / 'README.md').write_text('\n'.join(lines) + '\n', 'utf8')
    return len(rows)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--out', default=str(DEFAULT_OUT)); a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for child in out.iterdir():
        if child.name == '.git': continue
        shutil.rmtree(child) if child.is_dir() else child.unlink()
    files = [p for p in tracked() if wanted(p)]
    for p in files:
        dst = out / p; dst.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(SITE / p, dst)
    n = templates(out)
    # public-repo/ holds the repository's own README (English and Chinese) and its screenshots; it replaces the
    # internal development README at the top of the export
    public = out / 'public-repo'
    if public.exists():
        for f in public.rglob('*'):
            if f.is_file():
                dst = out / f.relative_to(public); dst.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(f, dst)
        shutil.rmtree(public)
    readme = out / 'README.md'
    if readme.exists() and 'data-templates/' not in readme.read_text('utf8'):
        note = ('\n\n## Data\n\nThis repository holds the code only. The data payloads under `dist/data/` and `dist/rhone/data/` '
                'are not included; [data-templates/](data-templates/README.md) shows the layout and keys of every data file, '
                'and the scripts in `scripts/` build them from public sources.\n')
        readme.write_text(readme.read_text('utf8').rstrip() + note, 'utf8')
    gi = out / '.gitignore'
    extra = '\n# data is built locally and never committed here\ndist/data/\ndist/rhone/data/\nscripts/data/\n'
    gi.write_text((gi.read_text('utf8') if gi.exists() else '') + extra, 'utf8')
    print(f'copied {len(files)} files, {n} data families templated -> {out}')


if __name__ == '__main__':
    main()
