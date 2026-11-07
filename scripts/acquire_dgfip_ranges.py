#!/usr/bin/env python3
"""Inspect/download selected members from large DGFiP ZIPs using HTTP ranges.

The default action reads only the ZIP tail and central directory. Use
``--extract`` after confirming the server supports byte ranges.
"""
from __future__ import annotations
import argparse, hashlib, io, json, re, urllib.request, zipfile
from pathlib import Path

DEPARTMENTS = {"21", "69", "71", "89"}

class RemoteRangeFile(io.RawIOBase):
    def __init__(self, url: str, size: int, block_size: int = 1024 * 1024):
        self.url, self.size, self.block_size, self.pos = url, size, block_size, 0
        self.cache = {}
    def readable(self): return True
    def seekable(self): return True
    def tell(self): return self.pos
    def seek(self, offset, whence=io.SEEK_SET):
        self.pos = max(0, min(self.size, offset if whence == io.SEEK_SET else self.pos + offset if whence == io.SEEK_CUR else self.size + offset))
        return self.pos
    def read(self, n=-1):
        if self.pos >= self.size: return b""
        end = self.size if n is None or n < 0 else min(self.size, self.pos + n)
        out = bytearray()
        while self.pos < end:
            start = (self.pos // self.block_size) * self.block_size
            stop = min(self.size - 1, start + self.block_size - 1)
            if start not in self.cache:
                req = urllib.request.Request(self.url, headers={"Range": f"bytes={start}-{stop}", "Accept-Encoding": "identity", "User-Agent": "burgundy-map-dgfip-range/1.0"})
                with urllib.request.urlopen(req) as response:
                    status = getattr(response, "status", response.getcode())
                    if status != 206:
                        raise RuntimeError(f"Range request returned HTTP {status}, not 206")
                    self.cache[start] = response.read()
            chunk = self.cache[start]
            offset = self.pos - start
            take = min(end - self.pos, len(chunk) - offset)
            if take <= 0: break
            out.extend(chunk[offset:offset + take]); self.pos += take
        return bytes(out)

def head(url):
    req = urllib.request.Request(url, method="HEAD", headers={"Accept-Encoding": "identity", "User-Agent": "burgundy-map-dgfip-range/1.0"})
    with urllib.request.urlopen(req) as response:
        return {"status": response.status, "headers": dict(response.headers.items()), "url": response.geturl()}

def member_pattern(departments):
    """Department files are named PM_<year>_NB_<code>.csv, the code being the department number followed by 0."""
    codes = sorted({d.zfill(3) for d in departments} | {f"{d}0" for d in departments})
    return re.compile(r"PM_\d+_NB_(?:%s)\.csv$" % "|".join(codes), re.I)

def inspect(url, departments=DEPARTMENTS):
    metadata = head(url)
    size = int(metadata["headers"].get("Content-Length", "0"))
    if not size: raise RuntimeError("Missing Content-Length; cannot perform bounded ZIP inspection")
    probe_start = max(0, size - 65536)
    req = urllib.request.Request(url, headers={"Range": f"bytes={probe_start}-{size - 1}", "Accept-Encoding": "identity", "User-Agent": "burgundy-map-dgfip-range/1.0"})
    with urllib.request.urlopen(req) as response:
        probe_status = response.status
        probe = response.read()
        content_range = response.headers.get("Content-Range")
    if probe_status != 206:
        return {"url": url, "resolvedUrl": metadata["url"], "size": size, "head": metadata, "rangeStatus": probe_status, "contentRange": content_range, "rangeSupported": False}
    with zipfile.ZipFile(RemoteRangeFile(url, size)) as archive:
        entries = [{"name": i.filename, "size": i.file_size, "compressedSize": i.compress_size, "crc": f"{i.CRC:08x}"} for i in archive.infolist()]
    pattern = member_pattern(departments)
    selected = [x for x in entries if pattern.search(x["name"])]
    return {"url": url, "resolvedUrl": metadata["url"], "size": size, "head": metadata, "rangeStatus": probe_status, "contentRange": content_range, "rangeSupported": True, "entryCount": len(entries), "selectedEntries": selected}

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("urls", nargs="+"); ap.add_argument("--report", type=Path, default=Path("work/ownership/dgfip-range-report.json")); ap.add_argument("--extract-dir", type=Path); ap.add_argument("--departments", default=",".join(sorted(DEPARTMENTS))); args = ap.parse_args()
    departments = set(args.departments.split(","))
    report = {"departments": sorted(departments), "archives": [inspect(url, departments) for url in args.urls]}
    if args.extract_dir:
        args.extract_dir.mkdir(parents=True, exist_ok=True)
        for archive_report in report["archives"]:
            if not archive_report.get("rangeSupported"):
                raise RuntimeError(f"Range unsupported for {archive_report['url']}; refusing full archive fallback")
            size = int(archive_report["size"])
            with zipfile.ZipFile(RemoteRangeFile(archive_report["url"], size)) as archive:
                for entry in archive_report["selectedEntries"]:
                    target = args.extract_dir / Path(entry["name"]).name
                    with target.open("wb") as stream:
                        stream.write(archive.read(entry["name"]))
                    entry["extractedPath"] = str(target)
    args.report.parent.mkdir(parents=True, exist_ok=True); args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
if __name__ == "__main__": main()
