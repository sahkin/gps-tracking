'use client'

import { Box, Compass, Layers, LocateFixed, Maximize, Minimize, Mountain, Navigation, RotateCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { LayerMode } from './map-view'

type Props = {
  layerMode: LayerMode
  terrain: boolean
  tilted: boolean
  tracking: boolean
  follow: boolean
  fullscreen: boolean
  onCycleLayer: () => void
  onToggleTerrain: () => void
  onToggleTilt: () => void
  onResetView: () => void
  onRefreshFeed: () => void
  onToggleTracking: () => void
  onToggleFollow: () => void
  onToggleFullscreen: () => void
}

const LAYER_LABEL: Record<LayerMode, string> = { satellite: 'SAT', hybrid: 'HYB', streets: 'MAP' }

function Btn({
  active,
  label,
  onClick,
  children,
  badge,
}: {
  active?: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
  badge?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(
        'relative flex size-10 items-center justify-center rounded-xl border shadow-hud backdrop-blur-xl transition active:scale-95',
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-primary/40 bg-panel text-primary hover:bg-primary/15',
      )}
    >
      {children}
      {badge && (
        <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded bg-panel-solid px-1 font-mono text-[8px] font-bold tracking-wider text-primary">
          {badge}
        </span>
      )}
    </button>
  )
}

export function SideControls(p: Props) {
  return (
    <nav
      aria-label="Map controls"
      className="pointer-events-auto absolute right-3 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-2"
    >
      <Btn label={`Layer: ${p.layerMode}`} onClick={p.onCycleLayer} badge={LAYER_LABEL[p.layerMode]}>
        <Layers className="size-4" />
      </Btn>
      <Btn label="Toggle 3D terrain" onClick={p.onToggleTerrain} active={p.terrain}>
        <Mountain className="size-4" />
      </Btn>
      <Btn label="Toggle tilt" onClick={p.onToggleTilt} active={p.tilted}>
        <Box className="size-4" />
      </Btn>
      <Btn label="Live GPS tracking" onClick={p.onToggleTracking} active={p.tracking}>
        <LocateFixed className={cn('size-4', p.tracking && 'animate-pulse')} />
      </Btn>
      {p.tracking && (
        <Btn label="Follow my position" onClick={p.onToggleFollow} active={p.follow}>
          <Navigation className="size-4" />
        </Btn>
      )}
      <Btn label="Reset view / north up" onClick={p.onResetView}>
        <Compass className="size-4" />
      </Btn>
      <Btn label="Refresh satellite feed" onClick={p.onRefreshFeed}>
        <RotateCw className="size-4" />
      </Btn>
      <Btn label={p.fullscreen ? 'Exit fullscreen' : 'Fullscreen'} onClick={p.onToggleFullscreen}>
        {p.fullscreen ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
      </Btn>
    </nav>
  )
}
