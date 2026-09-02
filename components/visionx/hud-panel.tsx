'use client'

import { useEffect, useRef, useState } from 'react'
import {
  ArrowUpDown,
  Bike,
  Car,
  ChevronDown,
  ChevronUp,
  Crosshair,
  Footprints,
  LoaderCircle,
  Satellite,
  Signal,
  Target,
  X,
} from 'lucide-react'
import { geocode, type Place, type Profile } from '@/lib/geo'
import { cn } from '@/lib/utils'

export type HudStatus = { tone: 'info' | 'ok' | 'warn' | 'error'; text: string }

type Props = {
  origin: Place | null
  dest: Place | null
  profile: Profile
  status: HudStatus
  busy: boolean
  gpsBusy: boolean
  feedLive: boolean
  onOriginChange: (p: Place | null) => void
  onDestChange: (p: Place | null) => void
  onProfileChange: (p: Profile) => void
  onUseGps: () => void
  onSwap: () => void
  onEngage: () => void
}

const PROFILES: { id: Profile; label: string; Icon: typeof Car }[] = [
  { id: 'driving', label: 'Drive', Icon: Car },
  { id: 'cycling', label: 'Cycle', Icon: Bike },
  { id: 'walking', label: 'Walk', Icon: Footprints },
]

function PlaceInput({
  id,
  value,
  placeholder,
  icon,
  onChange,
  trailing,
}: {
  id: string
  value: Place | null
  placeholder: string
  icon: React.ReactNode
  onChange: (p: Place | null) => void
  trailing?: React.ReactNode
}) {
  const [text, setText] = useState(value?.name ?? '')
  const [results, setResults] = useState<Place[]>([])
  const [open, setOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync when parent sets value programmatically (GPS, map click, swap)
  useEffect(() => {
    setText(value?.name ?? '')
  }, [value])

  const search = (q: string) => {
    setText(q)
    if (value) onChange(null)
    if (timer.current) clearTimeout(timer.current)
    abortRef.current?.abort()
    if (q.trim().length < 3) {
      setResults([])
      setOpen(false)
      return
    }
    timer.current = setTimeout(async () => {
      const ctrl = new AbortController()
      abortRef.current = ctrl
      setSearching(true)
      try {
        const r = await geocode(q, 5, ctrl.signal)
        setResults(r)
        setOpen(r.length > 0)
      } catch {
        /* aborted or offline */
      } finally {
        setSearching(false)
      }
    }, 450)
  }

  const pick = (p: Place) => {
    onChange(p)
    setText(p.name)
    setOpen(false)
    setResults([])
  }

  const submitFirst = async () => {
    if (value || text.trim().length < 3) return
    if (results[0]) return pick(results[0])
    setSearching(true)
    try {
      const r = await geocode(text, 1)
      if (r[0]) pick(r[0])
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="relative">
      <div
        className={cn(
          'flex items-center gap-2 rounded-lg border bg-panel px-3 py-2 transition-colors',
          value ? 'border-primary/50' : 'border-border-hud focus-within:border-primary/70',
        )}
      >
        <span className="shrink-0 text-primary" aria-hidden>
          {icon}
        </span>
        <label htmlFor={id} className="sr-only">
          {placeholder}
        </label>
        <input
          id={id}
          value={text}
          onChange={(e) => search(e.target.value)}
          onFocus={() => results.length && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) submitFirst()
          }}
          placeholder={placeholder}
          autoComplete="off"
          className="min-w-0 flex-1 truncate bg-transparent font-sans text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
        />
        {searching && <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" aria-label="Searching" />}
        {!searching && text && (
          <button
            type="button"
            onClick={() => {
              setText('')
              onChange(null)
              setResults([])
            }}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="Clear"
          >
            <X className="size-3.5" />
          </button>
        )}
        {trailing}
      </div>
      {open && (
        <ul
          role="listbox"
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-lg border border-border-hud bg-panel-solid shadow-2xl"
        >
          {results.map((r, i) => (
            <li key={`${r.lngLat.join(',')}-${i}`} role="option" aria-selected={false}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(r)}
                className="block w-full truncate px-3 py-2 text-left font-sans text-xs text-foreground hover:bg-primary/15"
              >
                {r.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function HudPanel({
  origin,
  dest,
  profile,
  status,
  busy,
  gpsBusy,
  feedLive,
  onOriginChange,
  onDestChange,
  onProfileChange,
  onUseGps,
  onSwap,
  onEngage,
}: Props) {
  const [collapsed, setCollapsed] = useState(false)

  const toneClass = {
    info: 'border-primary/60 bg-primary/10 text-primary',
    ok: 'border-success/60 bg-success/10 text-success',
    warn: 'border-warning/60 bg-warning/10 text-warning',
    error: 'border-destructive/60 bg-destructive/10 text-destructive',
  }[status.tone]

  return (
    <section
      aria-label="Navigation control center"
      className="pointer-events-auto absolute inset-x-3 top-3 z-10 mx-auto flex max-w-md flex-col gap-2.5 rounded-2xl border border-primary/50 bg-panel p-3 shadow-hud backdrop-blur-2xl"
    >
      <header className="flex items-center justify-between border-b border-primary/20 pb-1.5 font-mono text-[10px] font-bold tracking-[0.2em] text-primary">
        <span>VISIONX // SATELLITE NAV</span>
        <div className="flex items-center gap-2">
          <span className={cn('flex items-center gap-1', feedLive ? 'text-success' : 'text-warning')}>
            <span className={cn('size-1.5 rounded-full', feedLive ? 'bg-success shadow-glow-success animate-pulse' : 'bg-warning')} />
            {feedLive ? 'FEED LIVE' : 'SYNCING'}
          </span>
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="text-primary/80 hover:text-primary"
            aria-label={collapsed ? 'Expand panel' : 'Collapse panel'}
            aria-expanded={!collapsed}
          >
            {collapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          </button>
        </div>
      </header>

      {!collapsed && (
        <>
          <div className="flex items-stretch gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <PlaceInput
                id="origin"
                value={origin}
                placeholder="Origin node (e.g. Abbottabad)"
                icon={<Satellite className="size-3.5" />}
                onChange={onOriginChange}
                trailing={
                  <button
                    type="button"
                    onClick={onUseGps}
                    disabled={gpsBusy}
                    className="shrink-0 rounded-md border border-success/40 p-1 text-success transition hover:bg-success/15 disabled:opacity-50"
                    aria-label="Use my GPS location as origin"
                    title="Use my GPS location"
                  >
                    {gpsBusy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Crosshair className="size-3.5" />}
                  </button>
                }
              />
              <PlaceInput
                id="dest"
                value={dest}
                placeholder="Target destination (e.g. Balakot)"
                icon={<Target className="size-3.5 text-destructive" />}
                onChange={onDestChange}
              />
            </div>
            <button
              type="button"
              onClick={onSwap}
              className="flex w-9 shrink-0 items-center justify-center rounded-lg border border-border-hud bg-panel text-primary transition hover:bg-primary/15"
              aria-label="Swap origin and destination"
            >
              <ArrowUpDown className="size-4" />
            </button>
          </div>

          <div className="flex gap-1.5" role="radiogroup" aria-label="Travel mode">
            {PROFILES.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={profile === id}
                onClick={() => onProfileChange(id)}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1.5 rounded-lg border py-1.5 font-mono text-[10px] font-bold tracking-wider transition',
                  profile === id
                    ? 'border-primary bg-primary/20 text-primary'
                    : 'border-border-hud text-muted-foreground hover:border-primary/40 hover:text-foreground',
                )}
              >
                <Icon className="size-3.5" />
                {label.toUpperCase()}
              </button>
            ))}
          </div>

          <output
            aria-live="polite"
            className={cn('flex items-start gap-2 rounded-lg border p-2.5 font-sans text-[11px] leading-relaxed', toneClass)}
          >
            <Signal className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>{status.text}</span>
          </output>

          <button
            type="button"
            onClick={onEngage}
            disabled={busy || !origin || !dest}
            className="flex items-center justify-center gap-2 rounded-lg bg-gradient-to-br from-primary to-primary-deep py-2.5 font-mono text-[11px] font-bold tracking-[0.15em] text-primary-foreground transition hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? (
              <>
                <LoaderCircle className="size-3.5 animate-spin" /> SYNCING SATELLITE...
              </>
            ) : (
              'ENGAGE SATELLITE NAVIGATION'
            )}
          </button>
        </>
      )}
    </section>
  )
}
