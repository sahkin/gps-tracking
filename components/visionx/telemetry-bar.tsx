'use client'

import type { GpsFix } from '@/hooks/use-geolocation'
import type { ViewState } from './map-view'

type Props = {
  view: ViewState | null
  gps: GpsFix | null
  tracking: boolean
  hasRoute: boolean
}

export function TelemetryBar({ view, gps, tracking, hasRoute }: Props) {
  if (!view) return null
  const speedKmh = gps?.speed != null && gps.speed >= 0 ? (gps.speed * 3.6).toFixed(0) : null

  return (
    <aside
      aria-label="Live telemetry"
      className={`pointer-events-none absolute left-3 z-10 flex flex-col gap-0.5 rounded-xl border border-primary/30 bg-panel px-3 py-2 font-mono text-[10px] leading-relaxed text-primary shadow-hud backdrop-blur-xl ${
        hasRoute ? 'bottom-24' : 'bottom-3'
      } max-sm:hidden`}
    >
      <div className="flex items-center gap-1.5 font-bold text-success">
        <span className="size-1.5 animate-pulse rounded-full bg-success shadow-glow-success" />
        {tracking ? 'GPS LOCK · LIVE TRACKING' : 'SATELLITE DOWNLINK · SYNCED'}
      </div>
      <div className="text-muted-foreground">
        LAT {view.lat.toFixed(4)} · LNG {view.lng.toFixed(4)}
      </div>
      <div className="text-muted-foreground">
        ZOOM {view.zoom.toFixed(1)}x · PITCH {view.pitch.toFixed(0)}° · HDG {((view.bearing + 360) % 360).toFixed(0)}°
        {view.elevation !== null && ` · ELEV ${view.elevation.toFixed(0)} m`}
      </div>
      {gps && (
        <div className="text-success/90">
          GPS ±{gps.accuracy.toFixed(0)} m
          {speedKmh !== null && ` · ${speedKmh} km/h`}
          {gps.altitude != null && ` · ALT ${gps.altitude.toFixed(0)} m`}
        </div>
      )}
    </aside>
  )
}
