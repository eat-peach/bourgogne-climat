"""Focused tests for the compact physical commune boundary export."""
from __future__ import annotations

import gzip
import json
import math
import tempfile
import unittest
from pathlib import Path

import geopandas as gpd
from shapely.geometry import MultiPolygon, Polygon

from export_commune_boundaries import (
    DEFAULT_OUTPUT,
    DEFAULT_SOURCE,
    build_payload,
    write_deterministic_gzip,
)


def _source_rows():
    frame = gpd.read_file(DEFAULT_SOURCE)
    return {str(row.insee): row for row in frame.itertuples()}


class CommuneBoundaryExportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = _source_rows()
        with gzip.open(DEFAULT_OUTPUT, "rt", encoding="utf-8") as stream:
            cls.payload = json.load(stream)

    def test_export_has_expected_schema_and_code_coverage(self):
        self.assertEqual(self.payload["crs"], "EPSG:2154")
        communes = self.payload["communes"]
        self.assertEqual(len(communes), 376)
        codes = [row["code"] for row in communes]
        self.assertEqual(len(set(codes)), 376)
        self.assertEqual(set(codes), set(self.source))
        self.assertEqual(codes, sorted(codes))
        for row in communes:
            self.assertIsInstance(row["name"], str)
            self.assertEqual(len(row["bounds"]), 4)
            self.assertEqual(len(row["centroid"]), 2)
            self.assertTrue(all(math.isfinite(float(value)) for value in row["bounds"]))
            self.assertTrue(all(math.isfinite(float(value)) for value in row["centroid"]))

    def test_rings_are_valid_and_disconnected_parts_are_preserved(self):
        by_code = {row["code"]: row for row in self.payload["communes"]}
        for code, source_row in self.source.items():
            row = by_code[code]
            self.assertEqual(len(row["rings"]), len(source_row.geometry.geoms))
            polygons = []
            for polygon_rings in row["rings"]:
                self.assertGreaterEqual(len(polygon_rings), 1)
                for ring in polygon_rings:
                    self.assertGreaterEqual(len(ring), 4)
                    self.assertEqual(ring[0], ring[-1])
                    self.assertTrue(all(math.isfinite(float(value)) for point in ring for value in point))
                polygons.append(Polygon(polygon_rings[0], polygon_rings[1:]))
            geometry = MultiPolygon(polygons)
            self.assertTrue(geometry.is_valid, code)
            bounds = row["bounds"]
            self.assertEqual([round(float(value), 2) for value in source_row.geometry.bounds], bounds)

    def test_centroid_is_the_unmodified_source_centroid(self):
        by_code = {row["code"]: row for row in self.payload["communes"]}
        for code, source_row in self.source.items():
            source_centroid = [round(source_row.geometry.centroid.x, 2), round(source_row.geometry.centroid.y, 2)]
            self.assertEqual(by_code[code]["centroid"], source_centroid, code)

    def test_target_communes_have_expected_touching_neighbors(self):
        expected = {
            "71019": {"71241", "71403", "71430", "71447"},
            "21714": {"21088", "21267", "21464"},
        }
        for code, neighbor_codes in expected.items():
            target = self.source[code].geometry
            touching = {
                neighbor_code
                for neighbor_code, row in self.source.items()
                if neighbor_code != code and row.geometry.boundary.intersects(target.boundary)
            }
            self.assertEqual(touching, neighbor_codes, code)

    def test_gzip_output_is_compact_and_deterministic(self):
        self.assertLess(DEFAULT_OUTPUT.stat().st_size, 1_000_000)
        payload = build_payload(DEFAULT_SOURCE)
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / "one.json.gz"
            second = Path(directory) / "two.json.gz"
            write_deterministic_gzip(payload, first)
            write_deterministic_gzip(payload, second)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(first.read_bytes(), DEFAULT_OUTPUT.read_bytes())


if __name__ == "__main__":
    unittest.main()
