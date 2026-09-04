'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import type { Map as MLMap } from 'maplibre-gl'
import { useGeolocation } from '@/hooks/use-geolocation'
import {
  fetchRoutes,
  formatDistance,
  formatDuration,
  formatLngLat,
  pointAlong,
  reverseGeocode,
  type LngLat,
  type Place,
  type Profile,
  type Route,
  type RouteStep,
} from '@/lib/geo'
import { HudPanel, type HudStatus } from './hud-panel'
import { INITIAL_CENTER, MapView, type LayerMode, type ViewState } from './map-view'
import { RoutePanel } from './route-panel'
import { SideControls } from './side-controls'
import { TelemetryBar } from './telemetry-bar'

const IDLE_STATUS: HudStatus = {
  tone: 'info',
  text: 'Satellite link established. Enter two nodes, tap the map to drop a target, or lock onto your GPS position.',
}

function parseLngLat(v: string | null): LngLat | null {
  if (!v) return null
  const [a, b] = v.split(',').map(Number)
  return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : null
}

export function VisionXApp() {
  const mapRef = useRef<MLMap | null>(null)
  const flyFrame = useRef<number>(0)
  const routeAbort = useRef<AbortController | null>(null)

  const [origin, setOrigin] = useState<Place | null>(null)
  const [dest, setDest] = useState<Place | null>(null)
  const [profile, setProfile] = useState<Profile>('driving')
  const [routes, setRoutes] = useState<Route[]>([])
  const [selected, setSelected] = useState(0)
  const [status, setStatus] = useState<HudStatus>(IDLE_STATUS)
  const [busy, setBusy] = useState(false)
  const [layerMode, setLayerMode] = useState<LayerMode>('hybrid')
  const [terrain, setTerrain] = useState(true)
  const [tilted, setTilted] = useState(true)
  const [follow, setFollow] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [flying, setFlying] = useState(false)
  const [feedLive, setFeedLive] = useState(true)
  const [view, setView] = useState<ViewState | null>(null)

  const gps = useGeolocation()

  // ---------- Routing ----------
  const engage = useCallback(
    async (o: Place | null, d: Place | null, p: Profile) => {
      if (!o || !d) return
      routeAbort.current?.abort()
      const ctrl = new AbortController()
      routeAbort.current = ctrl
      setBusy(true)
      setStatus({ tone: 'info', text: `Computing ${p} vectors from ${o.name.split(',')[0]} to ${d.name.split(',')[0]}...` })
      try {
        const found = await fetchRoutes(o.lngLat, d.lngLat, p, ctrl.signal)
        if (ctrl.signal.aborted) return
        if (!found.length) {
          setRoutes([])
          setStatus({ tone: 'warn', text: `No ${p} route exists between these nodes. Try a different mode or closer targets.` })
          return
        }
        setRoutes(found)
        setSelected(0)
        const best = found[0]
        setStatus({
          tone: 'ok',
          text: `Lock acquired: ${formatDistance(best.distance)} · ${formatDuration(best.duration)}${
            found.length > 1 ? ` · ${found.length - 1} alternative${found.length > 2 ? 's' : ''} available` : ''
          }. Trajectory rendered over live imagery.`,
        })
        const map = mapRef.current
        if (map) {
          const coords = best.geometry.coordinates as LngLat[]
          const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]))
          map.fitBounds(bounds, { padding: { top: 260, bottom: 120, left: 40, right: 70 }, pitch: 50, bearing: 0, duration: 2500 })
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') return
        setStatus({ tone: 'error', text: 'Telemetry breakdown during routing. Routing service may be unreachable — retry shortly.' })
      } finally {
        if (!ctrl.signal.aborted) setBusy(false)
      }
    },
    [],
  )

  // Re-route automatically when profile changes and a route exists
  const onProfileChange = (p: Profile) => {
    setProfile(p)
    if (routes.length) engage(origin, dest, p)
  }

  // ---------- Deep link on load ----------
  const onMapReady = useCallback(
    (map: MLMap) => {
      mapRef.current = map
      const params = new URLSearchParams(window.location.search)
      const o = parseLngLat(params.get('o'))
      const d = parseLngLat(params.get('d'))
      const p = (params.get('p') as Profile | null) ?? 'driving'
      if (o && d) {
        const oP: Place = { name: params.get('on') ?? formatLngLat(o), lngLat: o }
        const dP: Place = { name: params.get('dn') ?? formatLngLat(d), lngLat: d }
        setOrigin(oP)
        setDest(dP)
        if (['driving', 'cycling', 'walking'].includes(p)) setProfile(p)
        engage(oP, dP, p)
      }
    },
    [engage],
  )

  // ---------- GPS ----------
  const useGpsAsOrigin = async () => {
    setStatus({ tone: 'info', text: 'Acquiring GPS fix from satellite constellation...' })
    try {
      const fix = await gps.locate()
      const name = await reverseGeocode(fix.lngLat)
      setOrigin({ name, lngLat: fix.lngLat })
      setStatus({ tone: 'ok', text: `GPS lock ±${fix.accuracy.toFixed(0)} m. Origin set to your current position.` })
      mapRef.current?.flyTo({ center: fix.lngLat, zoom: 15, duration: 2000 })
    } catch (e) {
      setStatus({ tone: 'error', text: (e as Error).message })
    }
  }

  const toggleTracking = () => {
    if (gps.tracking) {
      gps.stopTracking()
      setFollow(false)
      setStatus({ tone: 'info', text: 'Live tracking disengaged.' })
    } else {
      gps.startTracking()
      setFollow(true)
      setStatus({ tone: 'ok', text: 'Live GPS tracking engaged. Camera will follow your position.' })
    }
  }

  // Follow camera
  useEffect(() => {
    const map = mapRef.current
    if (!map || !gps.fix || !gps.tracking || !follow || flying) return
    map.easeTo({
      center: gps.fix.lngLat,
      bearing: gps.fix.heading ?? map.getBearing(),
      zoom: Math.max(map.getZoom(), 15),
      duration: 800,
    })
  }, [gps.fix, gps.tracking, follow, flying])

  // Surface GPS errors during tracking
  useEffect(() => {
    if (gps.error && gps.status === 'error') setStatus({ tone: 'error', text: gps.error })
  }, [gps.error, gps.status])

  // ---------- Map click → drop target ----------
  const onMapClick = async (lngLat: LngLat) => {
    if (flying) return
    const placeholder: Place = { name: formatLngLat(lngLat), lngLat }
    const isOrigin = !origin
    if (isOrigin) setOrigin(placeholder)
    else setDest(placeholder)
    setStatus({ tone: 'info', text: `${isOrigin ? 'Origin' : 'Target'} dropped at ${formatLngLat(lngLat)}. Resolving address...` })
    const name = await reverseGeocode(lngLat)
    const resolved = { name, lngLat }
    if (isOrigin) setOrigin(resolved)
    else setDest(resolved)
    setStatus({
      tone: 'ok',
      text: `${isOrigin ? 'Origin' : 'Target'} set: ${name.split(',').slice(0, 2).join(',')}.${
        isOrigin ? ' Now tap the map or search for a destination.' : ' Engage to route.'
      }`,
    })
  }

  const swap = () => {
    setOrigin(dest)
    setDest(origin)
    if (routes.length && origin && dest) engage(dest, origin, profile)
  }

  const clearRoute = () => {
    routeAbort.current?.abort()
    stopFlyover()
    setRoutes([])
    setStatus(IDLE_STATUS)
  }

  // ---------- Cinematic flyover ----------
  const stopFlyover = useCallback(() => {
    cancelAnimationFrame(flyFrame.current)
    setFlying(false)
  }, [])

  const startFlyover = () => {
    const map = mapRef.current
    const route = routes[selected]
    if (!map || !route) return
    if (flying) return stopFlyover()

    const coords = route.geometry.coordinates as LngLat[]
    const durationMs = Math.min(45000, Math.max(12000, route.distance / 25))
    const startT = performance.now()
    setFlying(true)
    setStatus({ tone: 'info', text: 'Cinematic flyover engaged. Drag the map or press Esc to abort.' })

    const stop = () => {
      stopFlyover()
      map.off('dragstart', stop)
    }
    map.once('dragstart', stop)

    const frame = (t: number) => {
      const f = Math.min(1, (t - startT) / durationMs)
      const eased = f < 0.05 ? f / 0.05 : 1
      const { point, bearing } = pointAlong(coords, f)
      map.jumpTo({
        center: point,
        bearing,
        pitch: 60 + 10 * eased,
        zoom: 15.5 - 0.5 * Math.sin(f * Math.PI),
      })
      if (f < 1) flyFrame.current = requestAnimationFrame(frame)
      else {
        stop()
        setStatus({ tone: 'ok', text: 'Flyover complete. Arrived at target node.' })
      }
    }
    flyFrame.current = requestAnimationFrame(frame)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && stopFlyover()
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      cancelAnimationFrame(flyFrame.current)
    }
  }, [stopFlyover])

  // ---------- Camera helpers ----------
  const resetView = () => {
    const map = mapRef.current
    if (!map) return
    stopFlyover()
    const route = routes[selected]
    if (route) {
      const coords = route.geometry.coordinates as LngLat[]
      const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]))
      map.fitBounds(bounds, { padding: { top: 260, bottom: 120, left: 40, right: 70 }, pitch: tilted ? 50 : 0, bearing: 0, duration: 1500 })
    } else {
      map.easeTo({ center: gps.fix?.lngLat ?? origin?.lngLat ?? INITIAL_CENTER, zoom: 12.5, pitch: tilted ? 55 : 0, bearing: 0, duration: 1500 })
    }
  }

  const toggleTilt = () => {
    const next = !tilted
    setTilted(next)
    mapRef.current?.easeTo({ pitch: next ? 60 : 0, duration: 1000 })
  }

  const cycleLayer = () => {
    const order: LayerMode[] = ['hybrid', 'satellite', 'streets']
    setLayerMode(order[(order.indexOf(layerMode) + 1) % order.length])
  }

  const refreshFeed = () => {
    const map = mapRef.current
    if (!map) return
    setFeedLive(false)
    const src = map.getSource('satellite') as maplibregl.RasterTileSource | undefined
    src?.setTiles([
      `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?t=${Date.now()}`,
    ])
    setTimeout(() => setFeedLive(true), 1200)
  }

  const flyToStep = (s: RouteStep) => {
    stopFlyover()
    mapRef.current?.flyTo({ center: s.location, zoom: 17, pitch: 60, duration: 1500 })
  }

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen()
    } catch {
      /* unsupported in some embeds */
    }
  }
  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const share = async () => {
    if (!origin || !dest) return
    const url = new URL(window.location.href)
    url.search = ''
    url.searchParams.set('o', origin.lngLat.map((n) => n.toFixed(5)).join(','))
    url.searchParams.set('d', dest.lngLat.map((n) => n.toFixed(5)).join(','))
    url.searchParams.set('on', origin.name.split(',').slice(0, 2).join(','))
    url.searchParams.set('dn', dest.name.split(',').slice(0, 2).join(','))
    url.searchParams.set('p', profile)
    try {
      await navigator.clipboard.writeText(url.toString())
      setStatus({ tone: 'ok', text: 'Mission link copied to clipboard. Anyone opening it will load this exact route.' })
    } catch {
      setStatus({ tone: 'warn', text: `Copy blocked. Link: ${url.toString()}` })
    }
  }

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-background font-sans text-foreground">
      <MapView
        origin={origin}
        dest={dest}
        gps={gps.fix}
        routes={routes}
        selected={selected}
        layerMode={layerMode}
        terrain={terrain}
        onReady={onMapReady}
        onMove={setView}
        onMapClick={onMapClick}
        onSelectRoute={setSelected}
      />

      <HudPanel
        origin={origin}
        dest={dest}
        profile={profile}
        status={status}
        busy={busy}
        gpsBusy={gps.status === 'locating'}
        feedLive={feedLive}
        onOriginChange={setOrigin}
        onDestChange={setDest}
        onProfileChange={onProfileChange}
        onUseGps={useGpsAsOrigin}
        onSwap={swap}
        onEngage={() => engage(origin, dest, profile)}
      />

      <SideControls
        layerMode={layerMode}
        terrain={terrain}
        tilted={tilted}
        tracking={gps.tracking}
        follow={follow}
        fullscreen={fullscreen}
        onCycleLayer={cycleLayer}
        onToggleTerrain={() => setTerrain((t) => !t)}
        onToggleTilt={toggleTilt}
        onResetView={resetView}
        onRefreshFeed={refreshFeed}
        onToggleTracking={toggleTracking}
        onToggleFollow={() => setFollow((f) => !f)}
        onToggleFullscreen={toggleFullscreen}
      />

      <TelemetryBar view={view} gps={gps.fix} tracking={gps.tracking} hasRoute={routes.length > 0} />

      <RoutePanel
        routes={routes}
        selected={selected}
        flying={flying}
        onSelect={setSelected}
        onStepClick={flyToStep}
        onFlyover={startFlyover}
        onShare={share}
        onClear={clearRoute}
      />
    </main>
  )
}
