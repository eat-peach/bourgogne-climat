#!/usr/bin/env python3
"""Build exact DGFiP legal-entity parcel ownership overlays.

The input is the 2025 DGFiP persons-morales parcel release. This script only
joins exact 14-character cadastral parcel identifiers already present in the
Etalab cadastre payloads. It never fuzzy-matches, infers private ownership, or
claims that an entity is the vineyard operator.

Each holder keeps the DGFiP name exactly as published (entityName) and gets a readable displayName (owner_names.py:
legal form restored, ordinary capitals, accents and apostrophes, and, for names the file cuts at 60 characters, the full
registered name from the national company register looked up by SIREN, cached in scripts/data/sirene_names.json).
Each parcel also carries its area in m² and its recorded land use (DGFiP "nature de culture", e.g. VI - Vignes).
owners.json.gz indexes every holder with the parcels it holds, for the atlas search.
"""
from __future__ import annotations
import argparse, csv, gzip, hashlib, io, json, re, time, unicodedata, urllib.request, zipfile
from owner_names import display_name, fold
from pathlib import Path
from collections import defaultdict

ROOT = Path(__file__).resolve().parents[2]
CADASTRE = ROOT / "website/dist/data/cadastre"
OUT = ROOT / "website/dist/data/ownership"
DEPARTMENTS = {"21", "69", "71", "89"}
SOURCE_URL = "https://data.economie.gouv.fr/explore/dataset/fichiers-des-locaux-et-des-parcelles-des-personnes-morales/"
SPEC_URL = "https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/fichiers-des-locaux-et-des-parcelles-des-personnes-morales/attachments/fichier_des_parcelles_des_personnes_morales_descriptif_2025_odt"
FIXED_FIELDS = ["dept", "direction", "commune", "communeName", "prefix", "section", "number", "streetNumber", "repeat", "majicStreet", "rivoli", "streetType", "streetName", "parcelAreaCentiare", "suf", "culture", "sufAreaCentiare", "rights", "personNumber", "siren", "group", "legalForm", "legalFormShort", "entity"]

def clean(value):
    return str(value or "").strip()

def key(value):
    value = unicodedata.normalize("NFKD", clean(value))
    value = "".join(c for c in value if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]", "", value.casefold())

def parcel_id(value):
    value = re.sub(r"\s+", "", clean(value)).upper()
    return value if re.fullmatch(r"[0-9A-Z]{14}", value) else None

def header_map(headers):
    aliases = {
        "dept": {"codedepartemental", "departement", "codepartement"},
        "parcel": {"idparcelle", "idparcellaire", "identifiantparcelle", "parcelle", "idparcellecadastrale"},
        "commune": {"codecommune", "insee", "codeinsee", "codecommuneinsee", "codeinseelacommune"},
        "prefix": {"prefixe", "prefixedesection", "prefixedesection"},
        "section": {"section", "sectioncadastrale", "codesectioncadastrale"},
        "number": {"numero", "numeroparcelle", "nparcelle", "numerodeplan"},
        "entity": {"denomination", "denominationproprietaire", "denominationproprietaire", "nom", "raisonsociale", "nomproprietaire"},
        "siren": {"siren", "sirenproprietaire"},
        "rights": {"codedroit", "droit", "codedesdroits", "naturedroit"},
        "rightsLabel": {"libelledroit", "libelledesdroits", "naturedroitlibelle"},
    }
    result = {}
    normalized = {key(h): h for h in headers}
    for target, names in aliases.items():
        for alias in names:
            if key(alias) in normalized:
                result[target] = normalized[key(alias)]
                break
    return result

def source_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def iter_tables(root):
    for path in sorted(root.rglob("*")):
        if path.suffix.casefold() in {".csv", ".tsv", ".txt"}:
            yield path, path.open("rb")
        elif path.suffix.casefold() == ".zip":
            with zipfile.ZipFile(path) as archive:
                for info in archive.infolist():
                    if info.is_dir() or Path(info.filename).suffix.casefold() not in {".csv", ".tsv", ".txt"}:
                        continue
                    yield path, archive.open(info, "r")

parcel_info = defaultdict(dict)  # per parcel: areaM2 and land uses, from the same rows

def read_rows(root, source_as_of):
    rows = defaultdict(list); hashes = {}
    for source, stream in iter_tables(root):
        if source not in hashes:
            hashes[source] = source_hash(source)
        raw = stream.read()
        text = raw.decode("utf-8-sig", errors="replace")
        dialect = csv.Sniffer().sniff(text[:8192], delimiters=";,\t|")
        raw_reader = csv.reader(io.StringIO(text), dialect=dialect)
        first = next(raw_reader, [])
        header_like = bool(first and ("departement" in key(first[0]) or not clean(first[0]).isdigit()))
        values = raw_reader if header_like else iter([first])
        records = (dict(zip(FIXED_FIELDS, values)) for values in values if values)
        for row in records:
            ident = None
            commune = row.get("commune", "")
            section = row.get("section", "")
            number = row.get("number", "")
            prefix = row.get("prefix", "")
            if not ident and commune and section and number:
                dept = row.get("dept", "")
                ident = parcel_id(clean(dept).zfill(2) + clean(commune).zfill(3) + clean(prefix).zfill(3) + clean(section).upper().rjust(2, "0") + clean(number).zfill(4))
            if not ident or ident[:2] not in DEPARTMENTS:
                continue
            entity = clean(row.get("entity", ""))
            siren = clean(row.get("siren", ""))
            rights = clean(row.get("rights", ""))
            rights_label = ""
            if "-" in rights:
                rights, rights_label = (part.strip() for part in rights.split("-", 1))
            # Persons-morales release is legally scoped to entities; an empty
            # row is retained only as a validation miss, never as private owner.
            holder = {"entityName": entity, "siren": siren, "rightsCode": rights, "rightsLabel": rights_label,
                      "sourceAsOf": source_as_of, "legalForm": clean(row.get("legalFormShort", ""))}
            area = clean(row.get("parcelAreaCentiare", "")); culture = clean(row.get("culture", ""))
            if area.isdigit(): parcel_info[ident]["areaM2"] = int(area)
            if culture: parcel_info[ident].setdefault("land", []).append(culture) if culture not in parcel_info[ident].get("land", []) else None
            if holder not in rows[ident]:
                rows[ident].append(holder)
    return rows, hashes

SIRENE_CACHE = Path(__file__).resolve().parent / "data" / "sirene_names.json"

def full_names(rows):
    """Registered names (recherche-entreprises.api.gouv.fr, the French state's public company search) for holders whose
    DGFiP name is cut at 60 characters and who have a 9-digit SIREN. Results are cached; nothing else is sent."""
    cache = json.loads(SIRENE_CACHE.read_text("utf8")) if SIRENE_CACHE.exists() else {}
    wanted = sorted({h["siren"] for holders in rows.values() for h in holders if len(h["entityName"]) >= 60 and re.fullmatch(r"\d{9}", h["siren"]) and h["siren"] not in cache})
    for siren in wanted:
        try:
            req = urllib.request.Request(f"https://recherche-entreprises.api.gouv.fr/search?q={siren}&per_page=1", headers={"User-Agent": "bourgogne-climat-atlas/1.0"})
            data = json.load(urllib.request.urlopen(req, timeout=20))
            hit = next((r for r in data.get("results", []) if r.get("siren") == siren), None)
            cache[siren] = (hit or {}).get("nom_raison_sociale") or (hit or {}).get("nom_complet") or ""
        except Exception as error:
            print("SIRENE lookup failed", siren, error); time.sleep(2); continue
        time.sleep(.16)  # the service allows about 7 requests a second
    SIRENE_CACHE.parent.mkdir(parents=True, exist_ok=True); SIRENE_CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=1, sort_keys=True), "utf8")
    return cache

COMMUNE_PARTICLES = {"le", "la", "les", "sur", "sous", "en", "de", "du", "des", "lès", "lés", "lez", "et", "aux", "au", "à"}
COMMUNE_NAME_FIXES = {"Chapelle-De-Guinchay": "La Chapelle-de-Guinchay", "Chapelle-Sous-Brancion": "La Chapelle-sous-Brancion", "Chapelle-Vaupelteigne": "La Chapelle-Vaupelteigne"}

def commune_case(name):
    """Commune names as the page shows them (feature-panel.js communeDisplayName): linking words lower case after a hyphen."""
    if name in COMMUNE_NAME_FIXES: return COMMUNE_NAME_FIXES[name]
    parts = name.split("-")
    return "-".join(p if not i else (p.lower() if p.lower() in COMMUNE_PARTICLES else re.sub(r"^([DL])(['’])", lambda m: m.group(1).lower() + m.group(2), p)) for i, p in enumerate(parts))

def place_names():
    """Commune names as the atlas spells them (with accents), keyed by their capitalised, accent-free form."""
    index = json.loads((ROOT / "website/dist/data/index.json").read_text("utf8"))
    names = {}
    for v in index.get("villages", []):
        name = commune_case(clean(v.get("name")))
        if name and len(name) > 3: names[fold(name)] = name
    return names

def load_cadastre(path):
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        return json.load(stream)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ownership-root", type=Path, required=True)
    ap.add_argument("--cadastre-root", type=Path, default=CADASTRE)
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--source-as-of", default="2025-01-01")
    ap.add_argument("--departments", help="comma-separated departments (default: the Burgundy set)")
    args = ap.parse_args()
    if args.departments:
        DEPARTMENTS.clear(); DEPARTMENTS.update(args.departments.split(","))
    rows, hashes = read_rows(args.ownership_root, args.source_as_of)
    registered, places = full_names(rows), place_names()
    print("rows read:", len(rows), flush=True)
    readable = {}  # one clean-up per distinct name
    for holders in rows.values():
        for h in holders:
            longer = registered.get(h["siren"]) if len(h["entityName"]) >= 60 else None
            k = (h["entityName"], h["legalForm"], longer)
            if k not in readable: readable[k] = display_name(h["entityName"], h["legalForm"], places, longer or None)
            h["displayName"] = readable[k]
    print("names cleaned:", len(readable), flush=True)
    args.out.mkdir(parents=True, exist_ok=True)
    manifest = {"schemaVersion": 1, "sourceAsOf": args.source_as_of, "source": "DGFiP personnes morales parcel release", "sourceUrl": SOURCE_URL, "specificationUrl": SPEC_URL,
                "departments": sorted(DEPARTMENTS), "sourceHashes": {str(k): v for k, v in hashes.items()}, "communes": {},
                "validation": {"join": "exact 14-character cadastral parcel ID", "fuzzyMatches": 0, "privateOwnersInferred": 0}}
    total = matched = 0
    owner_index = {}
    for path in sorted(args.cadastre_root.glob("*.json.gz")):
        cadastre = load_cadastre(path); code = str(cadastre.get("communeCode") or path.stem)
        if code[:2] not in DEPARTMENTS:
            continue
        owners = {}; missing = 0
        for parcel in cadastre.get("parcels", []):
            ident = parcel_id(parcel.get("id")); total += 1
            found = rows.get(ident, []) if ident else []
            if found:
                info = parcel_info.get(ident, {})
                owners[ident] = [{**h, **info} for h in found]; matched += 1
                for h in found:
                    key = h["siren"] or h["entityName"]
                    entry = owner_index.setdefault(key, {"name": h["displayName"], "siren": h["siren"], "form": h["legalForm"], "areaM2": 0, "vinesM2": 0, "parcels": defaultdict(list)})
                    entry["parcels"][code].append(ident); entry["areaM2"] += info.get("areaM2", 0)
                    if any(land.startswith("VI") for land in info.get("land", [])): entry["vinesM2"] += info.get("areaM2", 0)
            else:
                missing += 1
        body = {"schemaVersion": 1, "communeCode": code, "sourceAsOf": args.source_as_of,
                "source": "DGFiP personnes morales parcel release", "sourceUrl": SOURCE_URL, "specificationUrl": SPEC_URL,
                "join": "exact-14-character-id", "parcels": owners,
                "coverage": {"cadastreParcelCount": len(cadastre.get("parcels", [])), "matchedParcelCount": len(owners), "missingOwnershipCount": missing}}
        target = args.out / f"{code}.json.gz"
        with gzip.open(target, "wt", encoding="utf-8", compresslevel=9) as stream:
            json.dump(body, stream, ensure_ascii=False, separators=(",", ":"))
        manifest["communes"][code] = {"path": f"data/ownership/{code}.json.gz", "cadastreParcelCount": len(cadastre.get("parcels", [])), "matchedParcelCount": len(owners), "missingOwnershipCount": missing}
    manifest["validation"].update({"cadastreParcelCount": total, "matchedParcelCount": matched, "unmatchedParcelCount": total - matched})
    # Owner index for the search: [display name, SIREN, legal form, parcel area m², of which vines m², {commune: "id,id,…"}],
    # largest holdings first. Areas are whole-parcel areas, also counted for each co-owner where several are listed.
    listed = sorted(owner_index.values(), key=lambda e: -e["areaM2"])
    payload = {"schemaVersion": 1, "sourceAsOf": args.source_as_of, "source": "DGFiP personnes morales parcel release", "sourceUrl": SOURCE_URL,
               "fields": ["name", "siren", "legalForm", "areaM2", "vinesM2", "parcelsByCommune"],
               "owners": [[e["name"], e["siren"], e["form"], e["areaM2"], e["vinesM2"], {c: ",".join(ids) for c, ids in e["parcels"].items()}] for e in listed]}
    with gzip.open(args.out / "owners.json.gz", "wt", encoding="utf-8", compresslevel=9) as stream:
        json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
    manifest["owners"] = {"path": "data/ownership/owners.json.gz", "count": len(listed)}
    (args.out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(manifest["validation"], ensure_ascii=False))

if __name__ == "__main__":
    main()
