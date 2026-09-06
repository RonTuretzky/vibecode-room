#!/usr/bin/env python3
"""Bake south-end streets and perimeter walls from OpenStreetMap.

Centerlines and tagged dimensions are retained; fallback street widths and
sidewalk profiles are illustrative. The runtime needs no map service.
"""
import json
import math
from pathlib import Path
import urllib.parse
import urllib.request

BOUNDS = [40.756, -73.990, 40.782, -73.958]

def main():
    bounds = ','.join(map(str, BOUNDS))
    query = (f'[out:json][timeout:90];('
             f'way["highway"~"^(primary|secondary|tertiary|residential|unclassified|service)$"]({bounds});'
             f'way["barrier"~"^(wall|retaining_wall)$"]({bounds});'
             'way["highway"~"^(footway|path|pedestrian|cycleway|bridleway|steps)$"](40.763,-73.985,40.775,-73.965);'
             'node["natural"="tree"](40.763,-73.985,40.775,-73.965);'
             'way(427818536););out meta geom;')
    request = urllib.request.Request('https://overpass-api.de/api/interpreter',
        data=urllib.parse.urlencode({'data': query}).encode(),
        headers={'User-Agent': 'vibecode-room-geography/1.0'})
    with urllib.request.urlopen(request, timeout=115) as response:
        data = json.load(response)
    ways = []
    walks = []
    trees = []
    outline = None
    for way in data['elements']:
        if way['id'] == 427818536:
            outline = {'osmWay': way['id'], 'version': way['version'], 'modified': way['timestamp'],
                'coordinates': [[p['lon'], p['lat']] for p in way['geometry']]}
            continue
        tags = way.get('tags', {})
        if way['type'] == 'node':
            trees.append({'id': way['id'], 'coordinates': [way['lon'], way['lat']],
                'height': tags.get('height'), 'genus': tags.get('genus')})
            continue
        if tags.get('tunnel') == 'yes' or tags.get('access') == 'private':
            continue
        geometry = [[p['lon'], p['lat']] for p in way.get('geometry', [])]
        if len(geometry) < 2:
            raise ValueError(f"Missing geometry for {way['id']}")
        bucket = walks if tags.get('highway') in ('footway', 'path', 'pedestrian', 'cycleway', 'bridleway', 'steps') else ways
        bucket.append({'id': way['id'], 'version': way['version'], 'modified': way['timestamp'],
            'tags': {k: v for k, v in tags.items() if k in ('name', 'highway', 'barrier', 'width', 'height',
                'lanes', 'oneway', 'surface', 'material', 'wall', 'bridge', 'layer')},
            'coordinates': geometry})
    if len(ways) < 100 or not any(w['tags'].get('name') == 'Central Park South' for w in ways) or not outline:
        raise ValueError('Incomplete south-end street extract')
    def local(p):
        return ((p[0] + 73.9656) * 111319.49 * math.cos(math.radians(40.7829)), -(p[1] - 40.7829) * 111319.49)
    ring = list(map(local, outline['coordinates']))
    def inside(p):
        x, z = local(p)
        result = False
        for a, b in zip(ring, ring[1:]):
            if (a[1] > z) != (b[1] > z) and x < a[0] + (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]):
                result = not result
        return result
    def edge_distance(p):
        x, z = local(p)
        closest = math.inf
        for a, b in zip(ring, ring[1:]):
            dx, dz = b[0] - a[0], b[1] - a[1]
            t = max(0, min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz or 1)))
            closest = min(closest, math.hypot(x - a[0] - dx * t, z - a[1] - dz * t))
        return closest
    walks = [w for w in walks if any(inside(p) for p in w['coordinates'])]
    trees = [t for t in trees if edge_distance(t['coordinates']) < 25 and (inside(t['coordinates']) or edge_distance(t['coordinates']) < 8)]
    if len(walks) < 100 or len(trees) < 10:
        raise ValueError('Incomplete path/tree extract; keeping the previous files')
    output = {'attribution': '© OpenStreetMap contributors',
        'license': 'https://www.openstreetmap.org/copyright',
        'source': 'https://overpass-api.de/api/interpreter',
        'snapshot': data['osm3s']['timestamp_osm_base'], 'bounds': BOUNDS,
        'coordinateOrder': 'longitude,latitude', 'ways': sorted(ways, key=lambda w: w['id']),
        'walkBounds': [40.763, -73.985, 40.775, -73.965],
        'walks': sorted(walks, key=lambda w: w['id']), 'trees': sorted(trees, key=lambda t: t['id'])}
    if outline['coordinates'][0] != outline['coordinates'][-1] or len(outline['coordinates']) < 4:
        raise ValueError('Park boundary must be a closed polygon')
    boundary = {key: output[key] for key in ('attribution', 'license', 'source', 'snapshot', 'coordinateOrder')}
    boundary.update(outline)
    target = Path(__file__).resolve().parents[1] / 'public/assets/park/streets.json'
    temporary = target.with_suffix('.tmp')
    temporary.write_text(json.dumps(output, separators=(',', ':')) + '\n')
    temporary.replace(target)
    boundary_path = Path(__file__).resolve().parents[1] / 'src/park3d/data/park-outline.json'
    temporary = boundary_path.with_suffix('.tmp')
    temporary.write_text(json.dumps(boundary, indent=2) + '\n')
    temporary.replace(boundary_path)
    print(f'Saved {len(ways)} streets/walls, {len(walks)} walks and {len(trees)} perimeter trees ({target.stat().st_size:,} bytes)')

if __name__ == '__main__':
    main()
