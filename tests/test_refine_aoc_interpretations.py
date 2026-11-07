import json
from pathlib import Path

from shapely.geometry import box, mapping

from website.scripts.refine_aoc_interpretations import refine, geometry_from_rings


def _feature(app, denom, geometry):
    return {"type": "Feature", "properties": {"app": app, "denom": denom, "categorie": "Grand Cru", "id_app": app, "id_denom": denom}, "geometry": mapping(geometry)}


def test_chambertin_is_disjoint_from_beze_and_retains_legal_area(tmp_path: Path):
    chambertin = box(0, 0, 10, 10)
    beze = box(0, 0, 3, 10)
    official = tmp_path / "official.geojson"
    official.write_text(json.dumps({"type": "FeatureCollection", "features": [
        _feature("Chambertin", "Chambertin", chambertin),
        _feature("Chambertin-Clos de Bèze", "Chambertin-Clos de Bèze", beze),
    ]}, ensure_ascii=False), encoding="utf-8")
    source = tmp_path / "website" / "source"
    out = tmp_path / "website" / "out"
    source.mkdir(parents=True)
    scene = {"id": "21295", "bounds": [0, 0, 10, 10], "parcels": [
        {"name": "Chambertin", "appellation": "Chambertin", "officialAppellation": "Chambertin", "officialDenomination": "Chambertin", "rings": [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]},
        {"name": "Chambertin-Clos de Bèze", "appellation": "Chambertin-Clos de Bèze", "officialAppellation": "Chambertin-Clos de Bèze", "officialDenomination": "Chambertin-Clos de Bèze", "rings": [[[0, 0], [3, 0], [3, 10], [0, 10], [0, 0]]]},
    ], "climats": [{"name": "Chambertin", "rings": [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]}]}
    (source / "scene.json").write_text(json.dumps(scene), encoding="utf-8")
    result = refine(source, out, official)
    payload = json.loads((out / "scene.json").read_text(encoding="utf-8"))
    cham = payload["parcels"][0]
    beze_row = payload["parcels"][1]
    assert result["physicalChambertinRecords"] == 2
    assert cham["aocVerification"]["physicalStatus"] == "derived-supported"
    assert cham["aocVerification"]["physicalAreaM2"] == 70.0
    assert cham["aocVerification"]["legalAreaM2"] == 100.0
    assert cham["displayAreaM2"] == 70.0
    assert beze_row["aocVerification"]["legalAreaM2"] == 30.0
    assert payload["climats"][0]["aocVerification"]["geometryScope"] == "physical-climat"


def test_same_tier_overlap_is_flagged_without_partition(tmp_path: Path):
    official = tmp_path / "official.geojson"
    geometry = box(0, 0, 2, 2)
    official.write_text(json.dumps({"type": "FeatureCollection", "features": [
        _feature("Chambertin", "Chambertin", box(0, 0, 1, 1)),
        _feature("Chambertin-Clos de Bèze", "Chambertin-Clos de Bèze", box(0, 0, 1, 1)),
        _feature("Charmes-Chambertin", "Charmes-Chambertin", geometry),
        _feature("Mazoyères-Chambertin", "Mazoyères-Chambertin", geometry),
    ]}, ensure_ascii=False), encoding="utf-8")
    source = tmp_path / "website" / "source"
    out = tmp_path / "website" / "out"
    source.mkdir(parents=True)
    scene = {"id": "21295", "bounds": [0, 0, 2, 2], "parcels": [
        {"name": "Charmes-Chambertin", "appellation": "Charmes-Chambertin", "officialAppellation": "Charmes-Chambertin", "officialDenomination": "Charmes-Chambertin", "rings": [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]]},
        {"name": "Mazoyères-Chambertin", "appellation": "Mazoyères-Chambertin", "officialAppellation": "Mazoyères-Chambertin", "officialDenomination": "Mazoyères-Chambertin", "rings": [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]]},
    ]}
    (source / "scene.json").write_text(json.dumps(scene), encoding="utf-8")
    refine(source, out, official)
    rows = json.loads((out / "scene.json").read_text(encoding="utf-8"))["parcels"]
    assert {row["aocVerification"]["geometryScope"] for row in rows} == {"shared-eligibility"}
    assert all(row["aocVerification"]["physicalStatus"] == "unverified" for row in rows)
    assert [row["aocVerification"]["officialAppellation"] for row in rows] == ["Charmes-Chambertin", "Mazoyères-Chambertin"]
    assert all(row["overlapFamily"] == ["Charmes-Chambertin", "Mazoyères-Chambertin"] for row in rows)


def test_geometry_parser_keeps_multipolygon_parts_and_holes():
    rings = [
        [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]], [[1, 1], [1, 2], [2, 2], [2, 1], [1, 1]]],
        [[[10, 0], [12, 0], [12, 2], [10, 2], [10, 0]]],
    ]
    assert round(geometry_from_rings(rings).area, 6) == 19.0
