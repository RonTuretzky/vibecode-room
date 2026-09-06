#!/usr/bin/env python3
"""Refresh the small, attributed OSM site snapshot used by the park renderer.

No API key or runtime network access. Only geometry, feature names and revision
metadata are retained. Fails without replacing the previous dataset if a site
is missing. See docs/central-park-accuracy.md for accuracy limits.
"""
import json
from pathlib import Path
import urllib.parse
import urllib.request

SITES = {
    'gapstow': 546663191, 'wollman': 136507647,
    'hallett': 385442738, 'dairy': 265347588,
    'chess': 265347597, 'carousel': 585788256,
    'copCot': 385442739, 'inscope': 427087524,
    'sherman': 988716842, 'pulitzer': 988718514,
    'umpire': 385443481, 'arsenal': 265347583,
}

def main():
    query = '[out:json][timeout:45];way(id:' + ','.join(map(str, SITES.values())) + ');out meta geom;'
    request = urllib.request.Request(
        'https://overpass-api.de/api/interpreter',
        data=urllib.parse.urlencode({'data': query}).encode(),
        headers={'User-Agent': 'vibecode-room-geography/1.0'},
    )
    with urllib.request.urlopen(request, timeout=65) as response:
        data = json.load(response)
    ways = {way['id']: way for way in data['elements']}
    features = {}
    for key, way_id in SITES.items():
        way = ways[way_id]
        geometry = [[p['lon'], p['lat']] for p in way['geometry']]
        if len(geometry) < 2:
            raise ValueError(f'Missing geometry for {key}')
        features[key] = {
            'name': way['tags']['name'], 'osmWay': way_id,
            'version': way['version'], 'modified': way['timestamp'],
            'coordinates': geometry,
        }
        if 'height' in way['tags']:
            features[key]['heightM'] = float(way['tags']['height'])
    output = {
        'attribution': '© OpenStreetMap contributors',
        'license': 'https://www.openstreetmap.org/copyright',
        'source': 'https://overpass-api.de/api/interpreter',
        'snapshot': data['osm3s']['timestamp_osm_base'],
        'coordinateOrder': 'longitude,latitude', 'features': features,
    }
    target = Path(__file__).resolve().parents[1] / 'src/park3d/data/south-park-sites.json'
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix('.tmp')
    temporary.write_text(json.dumps(output, indent=2) + '\n')
    temporary.replace(target)
    print(f'Saved {len(features)} mapped sites to {target}')

if __name__ == '__main__':
    main()
