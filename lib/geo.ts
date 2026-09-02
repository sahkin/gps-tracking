export type LngLat = [number, number]

export type Place = {
  name: string
  lngLat: LngLat
}

export type RouteStep = {
  instruction: string
  name: string
  distance: number
  duration: number
  type: string
  modifier?: string
  location: LngLat
}

export type Route = {
  geometry: GeoJSON.LineString
  distance: number
  duration: number
  steps: RouteStep[]
}

export type Profile = 'driving' | 'cycling' | 'walking'

const NOMINATIM = 'https://nominatim.openstreetmap.org'
const OSRM = 'https://router.project-osrm.org'

export async function geocode(query: string, limit = 5, signal?: AbortSignal): Promise<Place[]> {
  const url = `${NOMINATIM}/search?format=json&limit=${limit}&q=${encodeURIComponent(query)}`
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`Geocoder responded ${res.status}`)
  const data = (await res.json()) as Array<{ display_name: string; lat: string; lon: string }>
  return data.map((d) => ({
    name: d.display_name,
    lngLat: [parseFloat(d.lon), parseFloat(d.lat)] as LngLat,
  }))
}

export async function reverseGeocode(lngLat: LngLat, signal?: AbortSignal): Promise<string> {
  const [lng, lat] = lngLat
  const url = `${NOMINATIM}/reverse?format=json&lat=${lat}&lon=${lng}&zoom=16`
  try {
    const res = await fetch(url, { signal, headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error()
    const data = (await res.json()) as { display_name?: string }
    return data.display_name ?? formatLngLat(lngLat)
  } catch {
    return formatLngLat(lngLat)
  }
}

export async function fetchRoutes(start: LngLat, dest: LngLat, profile: Profile, signal?: AbortSignal): Promise<Route[]> {
  const coords = `${start[0]},${start[1]};${dest[0]},${dest[1]}`
  const url = `${OSRM}/route/v1/${profile}/${coords}?overview=full&geometries=geojson&steps=true&alternatives=true`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Router responded ${res.status}`)
  const data = (await res.json()) as {
    code: string
    routes?: Array<{
      geometry: GeoJSON.LineString
      distance: number
      duration: number
      legs: Array<{
        steps: Array<{
          name: string
          distance: number
          duration: number
          maneuver: { type: string; modifier?: string; location: LngLat }
        }>
      }>
    }>
  }
  if (data.code !== 'Ok' || !data.routes?.length) return []

  return data.routes.map((r) => ({
    geometry: r.geometry,
    distance: r.distance,
    duration: r.duration,
    steps: r.legs.flatMap((leg) =>
      leg.steps.map((s) => ({
        name: s.name,
        distance: s.distance,
        duration: s.duration,
        type: s.maneuver.type,
        modifier: s.maneuver.modifier,
        location: s.maneuver.location,
        instruction: describeStep(s.maneuver.type, s.maneuver.modifier, s.name),
      })),
    ),
  }))
}

function describeStep(type: string, modifier: string | undefined, name: string): string {
  const road = name ? ` onto ${name}` : ''
  const dir = modifier ? modifier.replace('slight ', 'slightly ').replace('sharp ', 'sharply ') : ''
  switch (type) {
    case 'depart':
      return `Depart${name ? ` on ${name}` : ''}`
    case 'arrive':
      return 'Arrive at destination'
    case 'turn':
      return `Turn ${dir}${road}`
    case 'new name':
      return `Continue${road}`
    case 'continue':
      return `Continue ${dir}${road}`.replace(/\s+/g, ' ')
    case 'merge':
      return `Merge ${dir}${road}`
    case 'on ramp':
      return `Take the ramp${road}`
    case 'off ramp':
      return `Take the exit${road}`
    case 'fork':
      return `Keep ${dir} at the fork${road}`
    case 'end of road':
      return `At the end of the road, turn ${dir}${road}`
    case 'roundabout':
    case 'rotary':
      return `Enter the roundabout and exit${road}`
    case 'exit roundabout':
    case 'exit rotary':
      return `Exit the roundabout${road}`
    default:
      return `Continue${road}`
  }
}

export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`
}

export function formatDuration(s: number): string {
  const mins = Math.round(s / 60)
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

export function formatEta(s: number): string {
  const eta = new Date(Date.now() + s * 1000)
  return eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function formatLngLat([lng, lat]: LngLat): string {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`
}

export function haversine(a: LngLat, b: LngLat): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b[1] - a[1])
  const dLng = toRad(b[0] - a[0])
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

export function bearingBetween(a: LngLat, b: LngLat): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const toDeg = (r: number) => (r * 180) / Math.PI
  const φ1 = toRad(a[1])
  const φ2 = toRad(b[1])
  const Δλ = toRad(b[0] - a[0])
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

/** Returns a point `fraction` (0..1) along a line, plus the bearing at that point. */
export function pointAlong(coords: LngLat[], fraction: number): { point: LngLat; bearing: number } {
  if (coords.length < 2) return { point: coords[0] ?? [0, 0], bearing: 0 }
  const segs: number[] = []
  let total = 0
  for (let i = 1; i < coords.length; i++) {
    const d = haversine(coords[i - 1], coords[i])
    segs.push(d)
    total += d
  }
  let target = Math.min(Math.max(fraction, 0), 1) * total
  for (let i = 0; i < segs.length; i++) {
    if (target <= segs[i]) {
      const t = segs[i] === 0 ? 0 : target / segs[i]
      const a = coords[i]
      const b = coords[i + 1]
      return {
        point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
        bearing: bearingBetween(a, b),
      }
    }
    target -= segs[i]
  }
  const last = coords.length - 1
  return { point: coords[last], bearing: bearingBetween(coords[last - 1], coords[last]) }
}
