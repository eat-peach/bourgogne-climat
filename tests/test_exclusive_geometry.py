import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import make_exclusive_parcels as geometry
from shapely.geometry import GeometryCollection, box


class ExclusiveGeometryTests(unittest.TestCase):
    def test_nested_source_classes_become_separate_display_areas(self):
        sources = dict(zip(geometry.RANK, [box(4, 4, 6, 6), box(2, 2, 8, 8), box(0, 0, 10, 10), box(-2, -2, 12, 12), GeometryCollection()]))
        masks = geometry.higher_masks(sources)
        display = {}
        for cls in geometry.RANK[:-1]:
            result = geometry.difference_geometry(sources[cls], masks[cls])
            parcel = json.loads(json.dumps({'classification': cls, 'rings': geometry.as_rings(result)}))
            display[cls] = geometry.source_geometry(parcel)
        self.assertEqual([display[c].area for c in geometry.RANK[:-1]], [4, 32, 64, 96])
        for higher in display:
            for lower in display:
                if higher != lower:
                    self.assertEqual(display[higher].intersection(display[lower]).area, 0)
        # Hiding a higher class does not change the lower class geometry.
        grand_point = display['grand-cru'].representative_point()
        self.assertFalse(display['premier-cru'].covers(grand_point))
        self.assertFalse(display['village'].covers(grand_point))
        self.assertFalse(display['regional'].covers(grand_point))

    def test_holes_and_precise_cut_vertices_survive_json_round_trip(self):
        higher = box(1.23456789, 1, 3.34567891, 3)
        lower = geometry.difference_geometry(box(0, 0, 5, 5), higher)
        restored = geometry.source_geometry(json.loads(json.dumps({'rings': geometry.as_rings(lower)})))
        self.assertTrue(restored.equals(lower))
        self.assertEqual(restored.intersection(higher).area, 0)
        self.assertGreater(len(restored.interiors), 0)


if __name__ == '__main__':
    unittest.main()
