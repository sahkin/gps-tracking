'use client'

import { useEffect, useRef } from 'react'
import maplibregl, { type Map as MLMap, type StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { LngLat, Place, Route } from '@/lib/geo'
import type { GpsFix } from '@/hooks/use-geolocation'

export type LayerMode = 'satellite' | 'hybrid' | 'streets'

export type ViewState = {
  lng: number
  lat: number
  zoom: number
  pitch: number
  bearing: number
  elevation: number | null
}

type Props = {
  origin: Place | null
  dest: Place | null
  gps: GpsFix | null
  routes: Route[]
  selected: number
  layerMode: LayerMode
  terrain: boolean
  onReady: (map: MLMap) => void
  onMove: (v: ViewState) => void
  onMapClick: (lngLat: LngLat) => void
  onSelectRoute: (i: number) => void
}

export const INITIAL_CENTER: LngLat = [73.2399, 34.2182]

const STYLE: StyleSpecification = {
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    satellite: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 19,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    },
    labels: {
      type: 'raster',
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      maxzoom: 19,
    },
    streets: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© OpenStreetMap contributors',
    },
    dem: {
      type: 'raster-dem',
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      tileSize: 256,
      encoding: 'terrarium',
      maxzoom: 15,
      attribution: 'Terrain: Mapzen / AWS',
    },
  },
  layers: [
    { id: 'satellite', type: 'raster', source: 'satellite' },
    { id: 'streets', type: 'raster', source: 'streets', layout: { visibility: 'none' } },
    {
      id: 'hillshade',
      type: 'hillshade',
      source: 'dem',
      layout: { visibility: 'none' },
      paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#020617', 'hillshade-highlight-color': '#38bdf8' },
    },
    { id: 'labels', type: 'raster', source: 'labels', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.9 } },
  ],
  sky: {
    'sky-color': '#020617',
    'horizon-color': '#0ea5e9',
    'fog-color': '#020617',
    'sky-horizon-blend': 0.55,
    'horizon-fog-blend': 0.7,
    'fog-ground-blend': 0.55,
  },
}

function makeMarkerEl(kind: 'origin' | 'dest' | 'gps') {
  const el = document.createElement('div')
  el.className = `vx-marker vx-marker-${kind}`
  if (kind === 'gps') {
    el.innerHTML = '<div class="vx-gps-ring"></div><div class="vx-gps-cone"></div><div class="vx-gps-dot"></div>'
  }
  return el
}

function accuracyCircle(center: LngLat, radiusM: number): GeoJSON.Feature<GeoJSON.Polygon> {
  const pts: LngLat[] = []
  const [lng, lat] = center
  const dLat = radiusM / 111320
  const dLng = radiusM / (111320 * Math.cos((lat * Math.PI) / 180))
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * Math.PI * 2
    pts.push([lng + Math.cos(a) * dLng, lat + Math.sin(a) * dLat])
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [pts] } }
}

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

export function MapView({
  origin,
  dest,
  gps,
  routes,
  selected,
  layerMode,
  terrain,
  onReady,
  onMove,
  onMapClick,
  onSelectRoute,
}: Props) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MLMap | null>(null)
  const loaded = useRef(false)
  const markers = useRef<{ origin?: maplibregl.Marker; dest?: maplibregl.Marker; gps?: maplibregl.Marker }>({})
  const dashFrame = useRef<number>(0)

  // Init
  useEffect(() => {
    if (!container.current || mapRef.current) return
    const map = new maplibregl.Map({
      container: container.current,
      style: STYLE,
      center: INITIAL_CENTER,
      zoom: 12.5,
      pitch: 55,
      bearing: -15,
      maxPitch: 85,
      attributionControl: { compact: true },
      antialias: true,
    })
    mapRef.current = map

    const emit = () => {
      const c = map.getCenter()
      let elevation: number | null = null
      if (map.getTerrain()) {
        const e = map.queryTerrainElevation(c)
        elevation = typeof e === 'number' && Number.isFinite(e) ? e : null
      }
      onMove({ lng: c.lng, lat: c.lat, zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(), elevation })
    }

    map.on('load', () => {
      // Route sources + layers
      map.addSource('route-alt', { type: 'geojson', data: EMPTY })
      map.addSource('route-main', { type: 'geojson', data: EMPTY })
      map.addSource('gps-accuracy', { type: 'geojson', data: EMPTY })

      map.addLayer({
        id: 'gps-accuracy-fill',
        type: 'fill',
        source: 'gps-accuracy',
        paint: { 'fill-color': '#22c55e', 'fill-opacity': 0.12 },
      })
      map.addLayer({
        id: 'gps-accuracy-line',
        type: 'line',
        source: 'gps-accuracy',
        paint: { 'line-color': '#22c55e', 'line-width': 1, 'line-opacity': 0.6 },
      })
      map.addLayer({
        id: 'route-alt-line',
        type: 'line',
        source: 'route-alt',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#94a3b8', 'line-width': 4, 'line-opacity': 0.55, 'line-dasharray': [2, 2] },
      })
      map.addLayer({
        id: 'route-casing',
        type: 'line',
        source: 'route-main',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#020617', 'line-width': 11, 'line-opacity': 0.85 },
      })
      map.addLayer({
        id: 'route-glow',
        type: 'line',
        source: 'route-main',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#38bdf8', 'line-width': 16, 'line-opacity': 0.25, 'line-blur': 8 },
      })
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route-main',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#38bdf8', 'line-width': 6 },
      })
      map.addLayer({
        id: 'route-flow',
        type: 'line',
        source: 'route-main',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#e0f2fe', 'line-width': 3, 'line-dasharray': [0, 4, 3] },
      })

      // Animated "data flow" dash along the active route
      const seq = [
        [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5],
        [3, 4, 0], [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5],
      ]
      let step = 0
      let last = 0
      const tick = (t: number) => {
        if (t - last > 60) {
          step = (step + 1) % seq.length
          if (map.getLayer('route-flow')) map.setPaintProperty('route-flow', 'line-dasharray', seq[step])
          last = t
        }
        dashFrame.current = requestAnimationFrame(tick)
      }
      dashFrame.current = requestAnimationFrame(tick)

      map.on('click', 'route-alt-line', (e) => {
        const f = e.features?.[0]
        if (f && typeof f.properties?.index === 'number') {
          onSelectRoute(f.properties.index)
          e.preventDefault()
        }
      })
      map.on('mouseenter', 'route-alt-line', () => (map.getCanvas().style.cursor = 'pointer'))
      map.on('mouseleave', 'route-alt-line', () => (map.getCanvas().style.cursor = ''))

      loaded.current = true
      emit()
      onReady(map)
    })

    map.on('move', emit)
    map.on('click', (e) => {
      if (e.defaultPrevented) return
      onMapClick([e.lngLat.lng, e.lngLat.lat])
    })

    return () => {
      cancelAnimationFrame(dashFrame.current)
      map.remove()
      mapRef.current = null
      loaded.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Layer mode
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const apply = () => {
      map.setLayoutProperty('satellite', 'visibility', layerMode === 'streets' ? 'none' : 'visible')
      map.setLayoutProperty('streets', 'visibility', layerMode === 'streets' ? 'visible' : 'none')
      map.setLayoutProperty('labels', 'visibility', layerMode === 'hybrid' ? 'visible' : 'none')
    }
    if (map.isStyleLoaded()) apply()
    else map.once('load', apply)
  }, [layerMode])

  // Terrain
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const apply = () => {
      if (terrain) {
        map.setTerrain({ source: 'dem', exaggeration: 1.35 })
        map.setLayoutProperty('hillshade', 'visibility', 'visible')
      } else {
        map.setTerrain(null)
        map.setLayoutProperty('hillshade', 'visibility', 'none')
      }
    }
    if (map.isStyleLoaded()) apply()
    else map.once('load', apply)
  }, [terrain])

  // Origin / destination markers
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const sync = (kind: 'origin' | 'dest', place: Place | null) => {
      const existing = markers.current[kind]
      if (!place) {
        existing?.remove()
        markers.current[kind] = undefined
        return
      }
      if (existing) existing.setLngLat(place.lngLat)
      else markers.current[kind] = new maplibregl.Marker({ element: makeMarkerEl(kind), anchor: 'bottom' }).setLngLat(place.lngLat).addTo(map)
    }
    sync('origin', origin)
    sync('dest', dest)
  }, [origin, dest])

  // GPS marker + accuracy
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const apply = () => {
      const src = map.getSource('gps-accuracy') as maplibregl.GeoJSONSource | undefined
      if (!gps) {
        markers.current.gps?.remove()
        markers.current.gps = undefined
        src?.setData(EMPTY)
        return
      }
      if (!markers.current.gps) {
        markers.current.gps = new maplibregl.Marker({ element: makeMarkerEl('gps'), anchor: 'center', rotationAlignment: 'map' })
          .setLngLat(gps.lngLat)
          .addTo(map)
      } else {
        markers.current.gps.setLngLat(gps.lngLat)
      }
      const el = markers.current.gps.getElement()
      const cone = el.querySelector<HTMLElement>('.vx-gps-cone')
      if (cone) {
        cone.style.opacity = gps.heading !== null && !Number.isNaN(gps.heading) ? '1' : '0'
        cone.style.transform = `rotate(${gps.heading ?? 0}deg)`
      }
      src?.setData({ type: 'FeatureCollection', features: [accuracyCircle(gps.lngLat, gps.accuracy)] })
    }
    if (loaded.current) apply()
    else map.once('load', apply)
  }, [gps])

  // Routes
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const apply = () => {
      const main = map.getSource('route-main') as maplibregl.GeoJSONSource | undefined
      const alt = map.getSource('route-alt') as maplibregl.GeoJSONSource | undefined
      if (!main || !alt) return
      if (!routes.length) {
        main.setData(EMPTY)
        alt.setData(EMPTY)
        return
      }
      const sel = routes[Math.min(selected, routes.length - 1)]
      main.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: sel.geometry }] })
      alt.setData({
        type: 'FeatureCollection',
        features: routes
          .map((r, i) => ({ r, i }))
          .filter(({ i }) => i !== selected)
          .map(({ r, i }) => ({ type: 'Feature' as const, properties: { index: i }, geometry: r.geometry })),
      })
    }
    if (loaded.current) apply()
    else map.once('load', apply)
  }, [routes, selected])

  return <div ref={container} className="absolute inset-0" aria-label="Interactive satellite map" role="application" />
}
