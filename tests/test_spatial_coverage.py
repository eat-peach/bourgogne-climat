import sys
import unittest
from pathlib import Path

import geopandas as gpd
from shapely.geometry import Polygon, box

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from attach_spatial_aoc_eligibility import build_matches


class SpatialCoverageTests(unittest.TestCase):
    def entry(self, geometry):
        return {'key': ('a', 'd'), 'appellation': 'Volnay', 'denomination': 'Volnay premier cru Santenots',
                'tier': 'Premier Cru', 'geometry': geometry}

    def source(self, geometry):
        return gpd.GeoDataFrame({'source_id': ['test'], 'nom': ['Test'], 'geometry': [geometry]}, crs='EPSG:2154')

    def test_small_row_intersections_are_combined_before_tolerance_and_duplicates_not_counted(self):
        a, b = box(0, 0, .6, 10), box(.6, 0, 1.2, 10)
        result, _ = build_matches([self.entry(a), self.entry(b), self.entry(a)], self.source(box(0, 0, 10, 10)))
        match = result[('test', 'Test')]['matches'][0]
        self.assertEqual(match['coverageFraction'], .12)
        self.assertEqual(match['intersectionAreaM2'], 12)

    def test_holes_are_excluded_from_both_area_and_coverage(self):
        geometry = Polygon([(0, 0), (10, 0), (10, 10), (0, 10)], [[(2, 2), (8, 2), (8, 8), (2, 8)]])
        result, _ = build_matches([self.entry(box(0, 0, 10, 10))], self.source(geometry))
        record = result[('test', 'Test')]
        self.assertEqual(record['mappedAreaM2'], 64)
        self.assertEqual(record['matches'][0]['coverageFraction'], 1)


if __name__ == '__main__':
    unittest.main()
