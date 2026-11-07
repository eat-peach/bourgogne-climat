import json
import gzip
import math
import unittest
from pathlib import Path

from build_feature_facts import geom_area, representative_point, sample_height, geology_for, VOSNE_GC_IDS

ROOT = Path(__file__).resolve().parents[2]


class FeatureFactsTests(unittest.TestCase):
    def test_representative_point_is_inside_concave_geometry(self):
        feature = {"rings": [[[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4], [0, 0]]]}
        p = representative_point(feature)
        self.assertTrue(0 <= p[0] <= 1 or 0 <= p[1] <= 1)

    def test_hole_area_is_subtracted(self):
        feature = {"rings": [[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[2, 2], [2, 4], [4, 4], [4, 2], [2, 2]]]]}
        self.assertAlmostEqual(geom_area(feature), 96.0)

    def test_altitude_edge_fill_outside_and_nonfinite_are_unavailable(self):
        scene = {"bounds": [0, 0, 10, 10], "gridSize": 3, "heights": [1, 2, 3, 4, 5, 6, 7, 8, 9]}
        self.assertEqual(sample_height(scene, [-1, 5]), (None, None))
        scene["coverage"] = {"terrainEdgeFillUsed": True}
        self.assertEqual(sample_height(scene, [5, 5]), (None, None))
        scene["coverage"] = {}
        scene["heights"][4] = None
        self.assertEqual(sample_height(scene, [5, 5]), (None, None))
        scene["heights"][4] = float("nan")
        self.assertEqual(sample_height(scene, [5, 5]), (None, None))
        scene["heights"][4] = float("inf")
        self.assertEqual(sample_height(scene, [5, 5]), (None, None))

    def test_grand_cru_scope_is_exact_vosne_climats_only(self):
        for source_id in VOSNE_GC_IDS:
            feature = {"id": source_id, "name": "anything"}
            self.assertNotEqual(geology_for(feature, "vosne-roman-e-21714")["status"], "not_available")
            self.assertEqual(geology_for(feature, "morey-saint-denis-21442")["status"], "not_available")
            self.assertEqual(geology_for(feature, "vosne-roman-e-21714")["source"].endswith("79814.pdf"), True)
            self.assertEqual(geology_for(feature, "vosne-roman-e-21714", "parcels")["status"], "not_available")
        self.assertEqual(geology_for({"id": "13976", "name": "La Grande Rue"}, "vosne-roman-e-21714")["status"], "verified_appellation_scope")


if __name__ == "__main__":
    unittest.main()
