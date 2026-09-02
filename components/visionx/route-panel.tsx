'use client'

import { useState } from 'react'
import {
  ArrowUp,
  ChevronDown,
  ChevronUp,
  CornerUpLeft,
  CornerUpRight,
  Flag,
  MapPin,
  Plane,
  RotateCw,
  Share2,
  Square,
} from 'lucide-react'
import { formatDistance, formatDuration, formatEta, type Route, type RouteStep } from '@/lib/geo'
import { cn } from '@/lib/utils'

type Props = {
  routes: Route[]
  selected: number
  flying: boolean
  onSelect: (i: number) => void
  onStepClick: (s: RouteStep) => void
  onFlyover: () => void
  onShare: () => void
  onClear: () => void
}

function StepIcon({ step }: { step: RouteStep }) {
  const cls = 'size-3.5'
  if (step.type === 'depart') return <MapPin className={cls} />
  if (step.type === 'arrive') return <Flag className={cls} />
  if (step.type.includes('roundabout') || step.type.includes('rotary')) return <RotateCw className={cls} />
  if (step.modifier?.includes('left')) return <CornerUpLeft className={cls} />
  if (step.modifier?.includes('right')) return <CornerUpRight className={cls} />
  return <ArrowUp className={cls} />
}

export function RoutePanel({ routes, selected, flying, onSelect, onStepClick, onFlyover, onShare, onClear }: Props) {
  const [open, setOpen] = useState(false)
  const route = routes[selected]
  if (!route) return null

  return (
    <section
      aria-label="Route details"
      className="pointer-events-auto absolute inset-x-3 bottom-3 z-10 mx-auto flex max-w-md flex-col rounded-2xl border border-primary/40 bg-panel shadow-hud backdrop-blur-2xl"
    >
      <div className="flex items-center gap-3 p-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-baseline gap-2 font-mono">
            <span className="text-xl font-bold text-primary">{formatDuration(route.duration)}</span>
            <span className="text-xs text-muted-foreground">{formatDistance(route.distance)}</span>
            <span className="text-xs text-muted-foreground">ETA {formatEta(route.duration)}</span>
          </div>
          {routes.length > 1 && (
            <div className="mt-1.5 flex gap-1" role="radiogroup" aria-label="Route alternatives">
              {routes.map((r, i) => (
                <button
                  key={i}
                  type="button"
                  role="radio"
                  aria-checked={i === selected}
                  onClick={() => onSelect(i)}
                  className={cn(
                    'rounded-md border px-2 py-0.5 font-mono text-[10px] tracking-wider transition',
                    i === selected
                      ? 'border-primary bg-primary/20 text-primary'
                      : 'border-border-hud text-muted-foreground hover:text-foreground',
                  )}
                >
                  {i === 0 ? 'FASTEST' : `ALT ${i}`} · {formatDuration(r.duration)}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onFlyover}
            className={cn(
              'flex size-9 items-center justify-center rounded-lg border transition',
              flying
                ? 'border-destructive bg-destructive/20 text-destructive'
                : 'border-primary/50 bg-primary/10 text-primary hover:bg-primary/25',
            )}
            aria-label={flying ? 'Stop flyover' : 'Start cinematic flyover'}
            title={flying ? 'Stop flyover' : 'Cinematic flyover'}
          >
            {flying ? <Square className="size-4" /> : <Plane className="size-4" />}
          </button>
          <button
            type="button"
            onClick={onShare}
            className="flex size-9 items-center justify-center rounded-lg border border-border-hud text-primary transition hover:bg-primary/15"
            aria-label="Copy share link"
            title="Copy share link"
          >
            <Share2 className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="flex size-9 items-center justify-center rounded-lg border border-border-hud text-primary transition hover:bg-primary/15"
            aria-label={open ? 'Hide directions' : 'Show turn-by-turn directions'}
            aria-expanded={open}
          >
            {open ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-primary/20">
          <ol className="max-h-[38vh] overflow-y-auto p-2">
            {route.steps.map((s, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => onStepClick(s)}
                  className="flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-primary/10"
                >
                  <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border border-primary/40 text-primary">
                    <StepIcon step={s} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-sans text-xs text-foreground">{s.instruction}</span>
                    {s.distance > 0 && (
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {formatDistance(s.distance)} · {formatDuration(s.duration)}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <div className="flex justify-end border-t border-primary/20 p-2">
            <button
              type="button"
              onClick={onClear}
              className="rounded-md px-3 py-1.5 font-mono text-[10px] tracking-wider text-muted-foreground hover:text-destructive"
            >
              CLEAR ROUTE
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
