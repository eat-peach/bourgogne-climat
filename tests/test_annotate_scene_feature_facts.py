import copy
import gzip
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

from shapely.geometry import box

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from annotate_scene_feature_facts import (  # noqa: E402
    annotate_scene,
    matching_source_ordinal,
    write_gzip_json_atomic,
)


def rings(geometry):
    return [[[float(x), float(y)] for x, y in geometry.exterior.coords]]


class AnnotateSceneFactsTests(unittest.TestCase):
    def test_display_subset_matches_actual_source_geometry(self):
        original = {"id": "x", "name": "A", "rings": rings(box(0, 0, 10, 10)), "other": "kept"}
        display = {"id": "x", "name": "A", "rings": rings(box(1, 1, 9, 9))}
        scene = {"climats": [display], "parcels": []}
        before = copy.deepcopy(scene)
        stats = annotate_scene(scene, {"climats": [original]}, "village")
        self.assertEqual(stats["matched"], 1)
        self.assertEqual(scene["climats"][0]["factsKey"], "climats:village:x:0")
        self.assertEqual(scene["climats"][0]["rings"], before["climats"][0]["rings"])

    def test_outside_geometry_and_ambiguity_are_unmatched(self):
        outside = {"id": "x", "name": "A", "rings": rings(box(0, 0, 10.2, 10))}
        source = {"id": "x", "name": "A", "rings": rings(box(0, 0, 10, 10))}
        self.assertEqual(matching_source_ordinal(outside, [(0, source)])[1], "no_containing_source")
        a = {"id": "x", "name": "A", "rings": rings(box(0, 0, 10, 10))}
        b = {"id": "x", "name": "A", "rings": rings(box(0, 0, 12, 12))}
        display = {"id": "x", "name": "A", "rings": rings(box(1, 1, 9, 9))}
        self.assertEqual(matching_source_ordinal(display, [(0, a), (1, b)])[1], "ambiguous_candidates")

    def test_gzip_writer_uses_deterministic_header(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "scene.json.gz"
            write_gzip_json_atomic(path, {"a": 1})
            first = path.read_bytes()
            write_gzip_json_atomic(path, {"a": 1})
            self.assertEqual(first, path.read_bytes())
            with gzip.open(io.BytesIO(first), "rt", encoding="utf-8") as stream:
                self.assertEqual(json.load(stream), {"a": 1})


if __name__ == "__main__":
    unittest.main()
